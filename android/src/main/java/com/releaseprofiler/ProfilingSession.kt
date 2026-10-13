package com.releaseprofiler

import android.annotation.TargetApi
import android.content.ContentValues
import android.content.Context
import android.os.*
import android.provider.MediaStore
import com.facebook.react.bridge.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** All state is guarded by this instance; no polling or continuous clock synchronization. */
internal class ProfilingSessions(private val context: Context) {
  private val handler = Handler(Looper.getMainLooper())
  // Idle workers expire rather than retaining a thread.
  private val worker = ThreadPoolExecutor(0, 1, 30, TimeUnit.SECONDS, LinkedBlockingQueue<Runnable>())
  private var active: Session? = null
  private var legacyActive = false

  @Synchronized fun startLegacy() {
    // An unadopted startup recording has not enabled Hermes, so it must not block legacy use.
    check(active?.awaitingAdoption != false) { "A combined profiling session is already active" }
    if (legacyActive) return
    HermesProfilerBridge.enable()
    legacyActive = true
  }

  @Synchronized fun stopLegacy(outputPath: String): Boolean {
    if (active?.awaitingAdoption == false) return false
    HermesProfilerBridge.disable()
    HermesProfilerBridge.dumpSampledTraceToFile(outputPath)
    legacyActive = false
    return true
  }

  private class Session(val id: String, val directory: File, val timeoutMs: Long) {
    val cancellation = CancellationSignal()
    val anchors = JSONArray()
    val boundaries = JSONObject()
    val requestedOptions = JSONObject()
    var nativeStatus = "pending"
    var nativeError: String? = null
    var nativeErrorCode: Int? = null
    var nativeFile: File? = null
    var hermesFile: File? = null
    var completion: Promise? = null
    var stopped = false
    var awaitingAdoption = false
    var saveToDownloads = false
    var timeout: Runnable? = null
  }

  /** True while a combined session owns the Hermes sampler. */
  @Synchronized fun isActive() = active?.awaitingAdoption == false

  /** Discards a startup recording that JS has not adopted. */
  @Synchronized fun cancelPending(): Boolean {
    val session = active ?: return false
    if (!session.awaitingAdoption) return false
    active = null
    session.cancellation.cancel()
    session.directory.deleteRecursively()
    return true
  }

  @Synchronized fun detachRuntime() {
    if (legacyActive) {
      runCatching { HermesProfilerBridge.disable() }
      legacyActive = false
    }
    val session = active ?: return
    // A runtime owns a startup session only after JS explicitly adopts it. A stopped
    // session has already dumped Hermes; let it finish exporting instead of discarding it.
    if (session.awaitingAdoption || session.stopped) return
    session.timeout?.let { handler.removeCallbacks(it) }
    try {
      runCatching { HermesProfilerBridge.disable() }
      session.cancellation.cancel()
    } finally {
      val pendingCompletion = session.completion
      session.completion = null
      active = null
      pendingCompletion?.let { callback ->
        worker.execute { callback.reject("E_DESTROYED", "React runtime was destroyed during profiling") }
      }
    }
  }

  private fun clock(): JSONObject {
    val before = System.nanoTime()
    val boot = SystemClock.elapsedRealtimeNanos()
    val after = System.nanoTime()
    return JSONObject().put("monotonicNs", (before + (after - before) / 2).toString())
      .put("boottimeNs", boot.toString()).put("uncertaintyNs", (after - before).toString())
  }

  private fun positiveInt(options: ReadableMap, key: String, default: Int): Int {
    if (!options.hasKey(key)) return default
    require(options.getType(key) == ReadableType.Number) { "$key must be a positive integer" }
    val value = options.getDouble(key)
    require(value.isFinite() && value > 0 && value <= Int.MAX_VALUE && value % 1.0 == 0.0) {
      "$key must be a positive integer"
    }
    return value.toInt()
  }

  @Synchronized fun start(options: ReadableMap, promise: Promise) {
    if (Build.VERSION.SDK_INT < 35) {
      promise.reject("E_UNSUPPORTED", "Native sampling requires Android 15 (API 35) or newer")
      return
    }
    if (legacyActive) {
      promise.reject("E_BUSY", "Legacy Hermes profiling is already active")
      return
    }
    active?.let { session ->
      if (session.awaitingAdoption && !session.stopped) {
        try {
          startHermes(session)
          session.awaitingAdoption = false
          promise.resolve(session.id)
        } catch (error: Throwable) {
          promise.reject("E_START", error)
        }
      } else {
        promise.reject("E_BUSY", "A profiling session is already active")
      }
      return
    }
    val parameters = try {
      intArrayOf(
        positiveInt(options, "durationMs", 30000),
        positiveInt(options, "samplingFrequencyHz", 100),
        positiveInt(options, "bufferSizeKb", 8192),
        positiveInt(options, "resultTimeoutMs", 120000)
      )
    } catch (error: Exception) {
      promise.reject("E_OPTIONS", error)
      return
    }
    try {
      promise.resolve(startSession(parameters[0], parameters[1], parameters[2], parameters[3], false))
    } catch (error: Throwable) {
      promise.reject("E_START", error)
    }
  }

  @Synchronized fun startSession(
    duration: Int, frequency: Int, size: Int, timeout: Int, awaitingAdoption: Boolean
  ): String {
    check(Build.VERSION.SDK_INT >= 35) { "Native sampling requires Android 15 (API 35) or newer" }
    check(active == null && !legacyActive) { "A profiling session is already active" }
    require(duration > 0 && frequency > 0 && size > 0 && timeout > 0) {
      "Profiling options must be positive integers"
    }
    val session = prepare(duration, frequency, size, timeout)
    session.awaitingAdoption = awaitingAdoption
    if (!awaitingAdoption) startHermes(session)
    return session.id
  }

  private fun startHermes(session: Session) {
    try {
      val anchor = clock()
      session.anchors.put(anchor)
      session.boundaries.put("hermesStart", anchor)
      HermesProfilerBridge.enable()
    } catch (error: Throwable) {
      // Enable can fail partway through initialization; always attempt both cleanups.
      try { HermesProfilerBridge.disable() } catch (cleanup: Throwable) { error.addSuppressed(cleanup) }
      try { session.cancellation.cancel() } catch (cleanup: Throwable) { error.addSuppressed(cleanup) }
      active = null
      throw error
    }
  }

  private fun prepare(duration: Int, frequency: Int, size: Int, timeout: Int): Session {
    val id = UUID.randomUUID().toString()
    val dir = File(context.filesDir, "release-profiler/$id")
    check(dir.mkdirs()) { "Cannot create profiling session directory" }
    val session = Session(id, dir, timeout.toLong())
    session.requestedOptions.put("durationMs", duration).put("samplingFrequencyHz", frequency)
      .put("bufferSizeKb", size).put("resultTimeoutMs", timeout)
    active = session
    val anchor = clock()
    session.anchors.put(anchor)
    session.boundaries.put("nativeRequest", anchor)
    try {
      requestNative(session, duration, frequency, size)
    } catch (error: Throwable) {
      active = null
      dir.deleteRecursively()
      throw error
    }
    return session
  }

  private fun requestNative(session: Session, duration: Int, frequency: Int, size: Int) {
    check(Build.VERSION.SDK_INT >= 35) { "Native sampling requires Android 15 (API 35) or newer" }
    NativeSampler.request(context, session.id, session.cancellation, worker, duration, frequency, size) {
      code, error, path ->
      synchronized(this) {
        if (active !== session || session.nativeStatus != "pending") {
          path?.let { File(it).delete() }
          return@synchronized
        }
        session.boundaries.put("nativeResult", clock())
        session.nativeErrorCode = code
        if (path != null) {
          try {
            val target = File(session.directory, "native.perfetto-trace")
            val source = File(path)
            // ProfilingManager writes into this app's files dir; don't keep a second copy.
            if (!source.renameTo(target)) {
              source.copyTo(target, overwrite = true)
              source.delete()
            }
            session.nativeFile = target
            session.nativeStatus = "success"
          } catch (error: Exception) {
            session.nativeFile = null
            session.nativeStatus = "error"
            session.nativeError = error.message
          }
        } else {
          session.nativeStatus = "error"
          session.nativeError = error
        }
        finish(session)
      }
    }
  }

  fun stop(id: String, saveToDownloads: Boolean, promise: Promise) {
    worker.execute { stopSession(id, saveToDownloads, promise) }
  }

  @Synchronized private fun stopSession(id: String, saveToDownloads: Boolean, completion: Promise) {
    val session = active
    if (session == null || session.id != id || session.stopped || session.awaitingAdoption) {
      worker.execute { completion.reject("E_SESSION", "No matching running profiling session") }
      return
    }
    session.stopped = true
    session.completion = completion
    session.saveToDownloads = saveToDownloads
    try {
      try {
        HermesProfilerBridge.disable()
        val disabled = clock()
        session.anchors.put(disabled)
      } finally {
        session.cancellation.cancel()
      }
      val file = File(session.directory, "hermes.cpuprofile")
      HermesProfilerBridge.dumpSampledTraceToFile(file.path)
      session.hermesFile = file
    } catch (error: Throwable) {
      session.timeout?.let { handler.removeCallbacks(it) }
      session.completion = null
      active = null
      worker.execute { completion.reject("E_STOP", error.message ?: "Failed to stop profiling", error) }
      return
    }
    if (session.nativeStatus == "pending") {
      val timeout = Runnable { worker.execute {
        synchronized(this) {
          if (active === session && session.nativeStatus == "pending") {
            session.nativeStatus = "timeout"
            session.nativeError = "Timed out waiting for ProfilingManager results"
            finish(session)
          }
        }
      } }
      session.timeout = timeout
      handler.postDelayed(timeout, session.timeoutMs)
    }
    worker.execute { synchronized(this) { finish(session) } }
  }

  private fun finish(session: Session) {
    if (active !== session) return
    val completion = session.completion ?: return
    if (session.nativeStatus == "pending") return
    session.completion = null
    session.timeout?.let { handler.removeCallbacks(it) }
    val artifacts: WritableMap
    try {
      val manifest = JSONObject().put("version", 1).put("sessionId", session.id)
        .put("pid", Process.myPid()).put("hermesClock", "monotonic")
        .put("packageName", context.packageName)
        .put("nativeBackend", "android.os.ProfilingManager.STACK_SAMPLING")
        .put("androidApiLevel", Build.VERSION.SDK_INT).put("requestedOptions", session.requestedOptions)
        .put("hermesProfilePath", "hermes.cpuprofile")
        .put("nativeProfilePath", if (session.nativeFile != null) "native.perfetto-trace" else JSONObject.NULL)
        .put("nativeStatus", session.nativeStatus)
        .put("nativeError", session.nativeError ?: JSONObject.NULL)
        .put("nativeErrorCode", session.nativeErrorCode ?: JSONObject.NULL)
        .put("clockAnchors", session.anchors).put("boundaries", session.boundaries)
      val file = File(session.directory, "session.json")
      file.writeText(manifest.toString(2))
      val uris = mutableListOf<String>()
      if (session.saveToDownloads) {
        for (artifact in listOfNotNull(session.hermesFile, session.nativeFile, file)) {
          uris.add(exportFile(session.id, artifact))
        }
      }
      artifacts = Arguments.createMap().apply {
        putString("sessionId", session.id)
        putString("manifestPath", file.path)
        putString("hermesProfilePath", session.hermesFile!!.path)
        putString("nativeProfilePath", session.nativeFile?.path)
        putString("nativeStatus", session.nativeStatus)
        putString("nativeError", session.nativeError)
        session.nativeErrorCode?.let { putInt("nativeErrorCode", it) } ?: putNull("nativeErrorCode")
        putArray("downloadUris", Arguments.createArray().also { array -> uris.forEach { array.pushString(it) } })
      }
    } catch (error: Exception) {
      if (active === session) active = null
      worker.execute {
        completion.reject("E_SAVE", "Artifacts remain in ${session.directory.path}: ${error.message}", error)
      }
      return
    } finally {
      if (active === session) active = null
    }
    // Deliver after releasing session ownership and its monitor.
    worker.execute { completion.resolve(artifacts) }
  }

  @TargetApi(29)
  private fun exportFile(id: String, file: File): String {
    val resolver = context.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
      put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
      put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/release-profiler/$id")
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("Cannot create Downloads artifact")
    try {
      resolver.openOutputStream(uri)?.use { output -> file.inputStream().use { it.copyTo(output) } }
        ?: throw IllegalStateException("Cannot open Downloads artifact")
      values.clear()
      values.put(MediaStore.MediaColumns.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      return uri.toString()
    } catch (error: Exception) {
      resolver.delete(uri, null, null)
      throw error
    }
  }
}
