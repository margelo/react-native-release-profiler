package com.releaseprofiler

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import com.facebook.hermes.instrumentation.HermesSamplingProfiler
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import java.io.File
import java.io.FileOutputStream
import java.net.URL

class ReleaseProfilerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  val reactContext = reactContext

  override fun getName(): String {
    return NAME
  }

  // Example method
  // See https://reactnative.dev/docs/native-modules-android
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun startProfiling(): Boolean {
    HermesSamplingProfiler.enable();
    return true
  }

  @ReactMethod
  fun stopProfiling(saveToDownloads: Boolean, promise: Promise) {
    val tempFile = File.createTempFile(
      "sampling-profiler-trace", ".cpuprofile", reactContext.getCacheDir())
    val outputPath =  tempFile.getPath()
    HermesSamplingProfiler.dumpSampledTraceToFile(outputPath)
    HermesSamplingProfiler.disable()
    Toast.makeText(
            reactContext,
            "Saved results from Profiler to " + outputPath,
            Toast.LENGTH_LONG)
        .show()

    if (saveToDownloads) {
      val fileName = tempFile.name

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val contentValues = ContentValues().apply {
          put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
          put(MediaStore.MediaColumns.MIME_TYPE, "text/plain")
          put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        }
        val resolver = reactContext.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues)
        if (uri != null) {
          URL("file://$outputPath").openStream().use {input ->
            resolver.openOutputStream(uri).use { output ->
              input.copyTo(output!!, DEFAULT_BUFFER_SIZE)
            }
          }
        }
      } else {
        val file = File(
          Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
          fileName
        )

        URL("file://$outputPath").openStream().use { input ->
          FileOutputStream(file).use { output ->
            input.copyTo(output)
          }
        }
      }
    }

    promise.resolve(outputPath)
  }

  companion object {
    const val NAME = "ReleaseProfiler"
  }
}
