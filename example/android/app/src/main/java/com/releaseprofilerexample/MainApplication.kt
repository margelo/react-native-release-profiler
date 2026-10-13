package com.releaseprofilerexample

import android.app.Application
import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.util.Log
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.releaseprofiler.NativeProfiling

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList = PackageList(this).packages.apply { add(TestClockPackage()) },
    )
  }

  override fun attachBaseContext(base: Context) {
    super.attachBaseContext(base)
    if (BuildConfig.PROFILE_STARTUP && Build.VERSION.SDK_INT >= 35) {
      try {
        NativeProfiling.start(this)
        // Give the asynchronous native sampler a head start before app initialization.
        // This example-only delay changes startup timing; it is not a readiness signal.
        SystemClock.sleep(100)
      } catch (error: Exception) {
        Log.w("ReleaseProfilerExample", "Could not start startup profiling", error)
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
