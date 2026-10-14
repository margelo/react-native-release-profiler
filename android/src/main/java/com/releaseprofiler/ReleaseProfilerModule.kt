package com.releaseprofiler

import android.os.Build
import android.os.Environment
import android.widget.Toast
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import java.io.File

class ReleaseProfilerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  val reactContext = reactContext
  private val sessions = NativeProfiling.sessions(reactContext)

  @ReactMethod
  @Synchronized
  fun startProfilingSession(options: ReadableMap, promise: Promise) {
    sessions.start(options, promise)
  }

  @ReactMethod
  fun stopProfilingSession(id: String, saveToDownloads: Boolean, promise: Promise) {
    sessions.stop(id, saveToDownloads, promise)
  }

  @Synchronized
  override fun invalidate() {
    sessions.detachRuntime()
    super.invalidate()
  }

  override fun getName(): String {
    return NAME
  }

  // Example method
  // See https://reactnative.dev/docs/native-modules-android
  @ReactMethod(isBlockingSynchronousMethod = true)
  @Synchronized
  fun startProfiling(): Boolean {
    sessions.startLegacy()
    return true
  }

  @ReactMethod
  @Synchronized
  fun stopProfiling(saveToDownloads: Boolean, promise: Promise) {
    val tempFile = File.createTempFile(
      "sampling-profiler-trace", ".cpuprofile", reactContext.getCacheDir())
    val outputPath = tempFile.getPath()
    val failure = try {
      sessions.stopLegacy(outputPath)
    } catch (error: Throwable) {
      tempFile.delete()
      promise.reject("E_STOP", error.message ?: "Failed to stop profiling", error)
      return
    }
    when (failure) {
      null -> Unit
      "E_NOT_STARTED" -> {
        tempFile.delete()
        promise.reject("E_NOT_STARTED", "stopProfiling() was called without startProfiling(); nothing was recorded")
        return
      }
      else -> {
        tempFile.delete()
        promise.reject("E_BUSY", "Use the combined session stop method")
        return
      }
    }

    // The Downloads copy keeps the cache file's name, so the returned path's file name
    // works with `--fromDownload --filename`.
    if (saveToDownloads) {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          exportToDownloads(reactContext, tempFile, Environment.DIRECTORY_DOWNLOADS)
        } else {
          tempFile.copyTo(File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            tempFile.name
          ))
        }
      } catch (error: Exception) {
        promise.reject("E_SAVE", "Profile saved to $outputPath but not to Downloads: ${error.message}", error)
        return
      }
    }
    Toast.makeText(
            reactContext,
            "Saved results from Profiler to " +
              if (saveToDownloads) "Download/${tempFile.name}" else outputPath,
            Toast.LENGTH_LONG)
        .show()

    promise.resolve(outputPath)
  }

  companion object {
    const val NAME = "ReleaseProfiler"
  }
}
