package com.releaseprofiler

import android.widget.Toast
import com.facebook.hermes.instrumentation.HermesSamplingProfiler
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import java.io.File

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
  fun stopProfiling(promise: Promise) {
    val outputPath =  File.createTempFile(
            "sampling-profiler-trace", ".cpuprofile", reactContext.getCacheDir())
        .getPath();
    HermesSamplingProfiler.dumpSampledTraceToFile(outputPath);
    HermesSamplingProfiler.disable();
    Toast.makeText(
            reactContext,
            "Saved results from Profiler to " + outputPath,
            Toast.LENGTH_LONG)
        .show();
    promise.resolve(null)
  }

  companion object {
    const val NAME = "ReleaseProfiler"
  }
}
