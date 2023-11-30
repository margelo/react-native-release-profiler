package com.releaseprofiler

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

class ReleaseProfilerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String {
    return NAME
  }

  // Example method
  // See https://reactnative.dev/docs/native-modules-android
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun startProfiling(Promise promise) {
    HermesSamplingProfiler.enable();
    promise.resolve(null)
  }

  @ReactMethod
  fun stopProfiling(Promise promise) {
    final String outputPath =  File.createTempFile(
            "sampling-profiler-trace", ".cpuprofile", getApplicationContext().getCacheDir())
        .getPath();
    HermesSamplingProfiler.dumpSampledTraceToFile(outputPath);
    HermesSamplingProfiler.disable();
    Toast.makeText(
            getApplicationContext(),
            "Saved results from Profiler to " + outputPath,
            Toast.LENGTH_LONG)
        .show();
    promise.resolve(null)
  }

  companion object {
    const val NAME = "ReleaseProfiler"
  }
}
