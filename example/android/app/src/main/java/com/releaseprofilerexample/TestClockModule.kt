package com.releaseprofilerexample

import android.os.SystemClock
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/**
 * Example-only ground truth for accuracy tests: System.nanoTime() is CLOCK_MONOTONIC, the
 * clock Hermes uses for sample timestamps, so task boundaries can be compared to samples.
 */
class TestClockModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "TestClock"

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun monotonicNs(): String = System.nanoTime().toString()

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun boottimeNs(): String = SystemClock.elapsedRealtimeNanos().toString()

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun threadId(): Double = android.os.Process.myTid().toDouble()
}

class TestClockPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
    listOf(TestClockModule(context))

  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
