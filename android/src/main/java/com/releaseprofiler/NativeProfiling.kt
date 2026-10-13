package com.releaseprofiler

import android.content.Context

/** Starts Android sampling without loading the Hermes profiler bridge. */
object NativeProfiling {
  private var instance: ProfilingSessions? = null

  @Synchronized internal fun sessions(context: Context): ProfilingSessions =
    instance ?: ProfilingSessions(context.applicationContext ?: context).also { instance = it }

  /**
   * Call after super.attachBaseContext(base), or from Application.onCreate(),
   * before React Native/SoLoader initialization.
   * Only Android sampling starts here. The first JS startProfilingSession() enables
   * Hermes and adopts this native recording; its options are ignored.
   * Stop and export through that JS session using the normal CLI workflow.
   * Native sampling starts asynchronously and may miss the earliest startup work.
   * Throws when Android is older than API 35, another profiler is active, or setup fails.
   */
  @JvmStatic
  @JvmOverloads
  fun start(
    context: Context,
    durationMs: Int = 30000,
    samplingFrequencyHz: Int = 100,
    bufferSizeKb: Int = 8192,
    resultTimeoutMs: Int = 120000
  ): String = sessions(context).startSession(
    durationMs, samplingFrequencyHz, bufferSizeKb, resultTimeoutMs, true
  )

  /**
   * Discards a startup recording that JS has not adopted, e.g. when the app decides not
   * to profile this launch. Returns false when there is no such recording.
   */
  @JvmStatic
  fun cancel(context: Context): Boolean = sessions(context).cancelPending()
}
