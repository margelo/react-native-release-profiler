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

/** Session directories kept in app-private storage (newest first, including a new one). */
internal const val KEPT_SESSIONS = 5
private val SESSION_ID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

/**
 * Copies [file] into the public Downloads collection under [relativePath] and returns its URI.
 * The generic MIME type keeps the file name; text/plain would make Android append ".txt".
 */
@TargetApi(29)
internal fun exportToDownloads(context: Context, file: File, relativePath: String): String {
  val resolver = context.contentResolver
  val values = ContentValues().apply {
    put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
    put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
    put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
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

  /** Writes the legacy profile; returns null on success, otherwise the code to reject with. */
  @Synchronized fun stopLegacy(outputPath: String): String? {
    if (active?.awaitingAdoption == false) return "E_BUSY"
    // Without startProfiling() there is nothing to dump; an empty profile would hide real ones.
    if (!legacyActive) return "E_NOT_STARTED"
    legacyActive = false
    HermesProfilerBridge.disable()
    HermesProfilerBridge.dumpSampledTraceToFile(outputPath)
    return null
  }

  private class Session(val id: String, val directory: File, val durationMs: Int, val timeoutMs: Long) {
    val requestedAtNs = System.nanoTime()
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
    var adopted = false
    var nativeEndedBeforeAdoption = false
    var ignoredOptions: JSONObject? = null
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
    // Validate before adopting too, so invalid options never resolve.
    val given = JSONObject()
    val parameters = try {
      listOf("durationMs" to 30000, "samplingFrequencyHz" to 100, "bufferSizeKb" to 8192,
        "resultTimeoutMs" to 120000).map { (key, default) ->
        positiveInt(options, key, default).also { if (options.hasKey(key)) given.put(key, it) }
      }
    } catch (error: Exception) {
      promise.reject("E_OPTIONS", error)
      return
    }
    active?.let { session ->
      if (session.awaitingAdoption && !session.stopped) {
        try {
          // Native sampling is not restarted: report when it has already ended, since this
          // JS session then gets no overlapping native samples.
          val ended = session.nativeStatus != "pending" ||
            System.nanoTime() - session.requestedAtNs >= session.durationMs * 1_000_000L
          startHermes(session)
          session.awaitingAdoption = false
          session.adopted = true
          session.nativeEndedBeforeAdoption = ended
          // The startup recording's options stay in effect.
          if (given.length() > 0) session.ignoredOptions = given
          promise.resolve(startResult(session))
        } catch (error: Throwable) {
          promise.reject("E_START", error)
        }
      } else {
        promise.reject("E_BUSY", "A profiling session is already active")
      }
      return
    }
    try {
      promise.resolve(startResult(
        createSession(parameters[0], parameters[1], parameters[2], parameters[3], false)))
    } catch (error: Throwable) {
      promise.reject("E_START", error)
    }
  }

  private fun startResult(session: Session): WritableMap = Arguments.createMap().apply {
    putString("sessionId", session.id)
    putBoolean("adopted", session.adopted)
    putBoolean("nativeEndedBeforeAdoption", session.nativeEndedBeforeAdoption)
  }

  @Synchronized fun startSession(
    duration: Int, frequency: Int, size: Int, timeout: Int, awaitingAdoption: Boolean
  ): String = createSession(duration, frequency, size, timeout, awaitingAdoption).id

  private fun createSession(
    duration: Int, frequency: Int, size: Int, timeout: Int, awaitingAdoption: Boolean
  ): Session {
    check(Build.VERSION.SDK_INT >= 35) { "Native sampling requires Android 15 (API 35) or newer" }
    check(active == null && !legacyActive) { "A profiling session is already active" }
    require(duration > 0 && frequency > 0 && size > 0 && timeout > 0) {
      "Profiling options must be positive integers"
    }
    val session = prepare(duration, frequency, size, timeout)
    session.awaitingAdoption = awaitingAdoption
    if (!awaitingAdoption) startHermes(session)
    return session
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

  /**
   * Bounds app-private storage: deletes all but the newest [keep] finished session directories.
   * Copies exported to Downloads are separate files and are never touched.
   */
  private fun pruneSessions(root: File, keep: Int) {
    val dirs = root.listFiles { file -> file.isDirectory && SESSION_ID.matches(file.name) } ?: return
    dirs.filter { it != active?.directory }.sortedByDescending { it.lastModified() }.drop(keep)
      .forEach { it.deleteRecursively() }
  }

  private fun prepare(duration: Int, frequency: Int, size: Int, timeout: Int): Session {
    val id = UUID.randomUUID().toString()
    val root = File(context.filesDir, "release-profiler")
    runCatching { pruneSessions(root, KEPT_SESSIONS - 1) }
    val dir = File(root, id)
    check(dir.mkdirs()) { "Cannot create profiling session directory" }
    val session = Session(id, dir, duration, timeout.toLong())
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
        .put("adopted", session.adopted)
        .put("nativeEndedBeforeAdoption", session.nativeEndedBeforeAdoption)
        .put("ignoredOptions", session.ignoredOptions ?: JSONObject.NULL)
        .put("clockAnchors", session.anchors).put("boundaries", session.boundaries)
      val file = File(session.directory, "session.json")
      file.writeText(manifest.toString(2))
      val uris = mutableListOf<String>()
      if (session.saveToDownloads) {
        for (artifact in listOfNotNull(session.hermesFile, session.nativeFile, file)) {
          uris.add(exportToDownloads(context, artifact,
            "${Environment.DIRECTORY_DOWNLOADS}/release-profiler/${session.id}"))
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
        // False: only in app-private storage, which adb cannot read on a release build.
        putBoolean("savedToDownloads", session.saveToDownloads)
        putBoolean("adopted", session.adopted)
        putBoolean("nativeEndedBeforeAdoption", session.nativeEndedBeforeAdoption)
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
}
