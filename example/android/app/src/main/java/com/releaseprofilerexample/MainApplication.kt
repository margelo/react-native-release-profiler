package com.releaseprofilerexample

import android.app.Application
import android.os.Build
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
      packageList = PackageList(this).packages,
    )
  }

  override fun onCreate() {
    super.onCreate()
    if (BuildConfig.PROFILE_STARTUP && Build.VERSION.SDK_INT >= 35) {
      try {
        NativeProfiling.start(this)
      } catch (error: Exception) {
        Log.w("ReleaseProfilerExample", "Could not start startup profiling", error)
      }
    }
    loadReactNative(this)
  }
}
