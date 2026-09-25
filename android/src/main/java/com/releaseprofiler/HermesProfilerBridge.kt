package com.releaseprofiler

import com.facebook.soloader.SoLoader

/** Direct bindings to the host Hermes engine, independent of RN's JNI registration. */
internal object HermesProfilerBridge {
  init {
    SoLoader.loadLibrary("releaseprofiler")
  }

  @JvmStatic external fun enable()
  @JvmStatic external fun disable()
  @JvmStatic external fun dumpSampledTraceToFile(filename: String)
}
