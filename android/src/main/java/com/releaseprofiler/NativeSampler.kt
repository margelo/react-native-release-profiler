package com.releaseprofiler

import android.content.Context
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ProfilingManager
import android.os.ProfilingResult
import androidx.annotation.RequiresApi
import java.io.File
import java.util.concurrent.Executor

/** Android 15 types stay in this class so ProfilingSessions loads cleanly on older devices. */
@RequiresApi(35)
internal object NativeSampler {
  fun request(
    context: Context,
    tag: String,
    cancellation: CancellationSignal,
    executor: Executor,
    duration: Int,
    frequency: Int,
    size: Int,
    onResult: (errorCode: Int, error: String?, path: String?) -> Unit
  ) {
    val manager = context.getSystemService(ProfilingManager::class.java)
      ?: throw IllegalStateException("ProfilingManager is unavailable on this device")
    // Bundle keys mirror AndroidX StackSamplingRequestBuilder. The OS may clamp values.
    val parameters = Bundle().apply {
      putInt("KEY_DURATION_MS", duration)
      putInt("KEY_FREQUENCY_HZ", frequency)
      putInt("KEY_SIZE_KB", size)
    }
    manager.requestProfiling(ProfilingManager.PROFILING_TYPE_STACK_SAMPLING, parameters,
      tag, cancellation, executor) { result ->
      val code = result.errorCode
      val path = result.resultFilePath
      if (code == ProfilingResult.ERROR_NONE && path != null) {
        onResult(code, null, path)
      } else {
        discardOutput(context, tag, path)
        onResult(code, describe(code, result.errorMessage), null)
      }
    }
  }

  /** A failed capture can still leave its (empty) output file in files/profiling/. */
  private fun discardOutput(context: Context, tag: String, path: String?) {
    runCatching {
      path?.let { File(it).delete() }
      // ProfilingManager names outputs profile_<tag, at most 20 characters>_<time>.<type>.
      File(context.filesDir, "profiling")
        .listFiles { file -> file.name.startsWith("profile_${tag.take(20)}_") }
        ?.forEach { it.delete() }
    }
  }

  private fun describe(code: Int, message: String?): String {
    val name = when (code) {
      ProfilingResult.ERROR_FAILED_RATE_LIMIT_SYSTEM -> "ERROR_FAILED_RATE_LIMIT_SYSTEM"
      ProfilingResult.ERROR_FAILED_RATE_LIMIT_PROCESS -> "ERROR_FAILED_RATE_LIMIT_PROCESS"
      ProfilingResult.ERROR_FAILED_PROFILING_IN_PROGRESS -> "ERROR_FAILED_PROFILING_IN_PROGRESS"
      ProfilingResult.ERROR_FAILED_EXECUTING -> "ERROR_FAILED_EXECUTING"
      ProfilingResult.ERROR_FAILED_POST_PROCESSING -> "ERROR_FAILED_POST_PROCESSING"
      ProfilingResult.ERROR_FAILED_NO_DISK_SPACE -> "ERROR_FAILED_NO_DISK_SPACE"
      ProfilingResult.ERROR_FAILED_INVALID_REQUEST -> "ERROR_FAILED_INVALID_REQUEST"
      else -> "ERROR_UNKNOWN"
    }
    val hint = when (code) {
      ProfilingResult.ERROR_FAILED_RATE_LIMIT_SYSTEM, ProfilingResult.ERROR_FAILED_RATE_LIMIT_PROCESS ->
        ": Android's profiling rate limit was reached. For local testing, run " +
          "`adb shell device_config put profiling_testing rate_limiter.disabled true`"
      else -> ""
    }
    return "ProfilingManager $name ($code)$hint" + (message?.let { " — $it" } ?: "")
  }
}
