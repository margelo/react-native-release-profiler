#include <jni.h>
#include <hermes/hermes.h>
#include <exception>
#include <string>
#include <stdexcept>

namespace {
#if RELEASE_PROFILER_USE_ROOT_API
facebook::hermes::IHermesRootAPI* rootAPI() {
  auto* api = facebook::jsi::castInterface<facebook::hermes::IHermesRootAPI>(
      facebook::hermes::makeHermesRootAPI());
  if (api == nullptr) throw std::runtime_error("Hermes root profiling API is unavailable");
  return api;
}
#endif

void reportFailure(JNIEnv* env, const char* message) {
  jclass exception = env->FindClass("java/lang/IllegalStateException");
  if (exception != nullptr) env->ThrowNew(exception, message);
}

template <typename Operation>
void run(JNIEnv* env, Operation operation) {
  try {
    operation();
  } catch (const std::exception& error) {
    reportFailure(env, error.what());
  } catch (...) {
    reportFailure(env, "Hermes sampling profiler failed");
  }
}
} // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_releaseprofiler_HermesProfilerBridge_enable(JNIEnv* env, jclass) {
  run(env, [] {
#if RELEASE_PROFILER_USE_ROOT_API
    rootAPI()->enableSamplingProfiler();
#else
    facebook::hermes::HermesRuntime::enableSamplingProfiler();
#endif
  });
}

extern "C" JNIEXPORT void JNICALL
Java_com_releaseprofiler_HermesProfilerBridge_disable(JNIEnv* env, jclass) {
  // Own this binding: RN 0.72's instrumentation accidentally registers disable
  // to enable, leaving its sampler running between supposedly stopped sessions.
  run(env, [] {
#if RELEASE_PROFILER_USE_ROOT_API
    rootAPI()->disableSamplingProfiler();
#else
    facebook::hermes::HermesRuntime::disableSamplingProfiler();
#endif
  });
}

extern "C" JNIEXPORT void JNICALL
Java_com_releaseprofiler_HermesProfilerBridge_dumpSampledTraceToFile(
    JNIEnv* env, jclass, jstring filename) {
  if (filename == nullptr) {
    reportFailure(env, "A profile filename is required");
    return;
  }
  const char* path = env->GetStringUTFChars(filename, nullptr);
  if (path == nullptr) return; // JVM has already raised an allocation exception.
  run(env, [path] {
#if RELEASE_PROFILER_USE_ROOT_API
    rootAPI()->dumpSampledTraceToFile(std::string(path));
#else
    facebook::hermes::HermesRuntime::dumpSampledTraceToFile(std::string(path));
#endif
  });
  env->ReleaseStringUTFChars(filename, path);
}
