cmake_minimum_required(VERSION 3.22.1)
project(releaseprofiler LANGUAGES CXX)

find_package(ReactAndroid REQUIRED CONFIG)
find_package(hermes-engine REQUIRED CONFIG)

add_library(releaseprofiler SHARED HermesProfilerBridge.cpp)
target_compile_features(releaseprofiler PRIVATE cxx_std_20)
target_compile_options(releaseprofiler PRIVATE -Wall -Wextra -Werror)
# Hermes renamed its prefab module in newer releases. Resolve from the host's
# exact Hermes dependency, never bundle a second engine or hardcode C++ symbols.
if(TARGET hermes-engine::libhermes)
  set(RELEASE_PROFILER_HERMES hermes-engine::libhermes)
elseif(TARGET hermes-engine::hermesvm)
  set(RELEASE_PROFILER_HERMES hermes-engine::hermesvm)
else()
  message(FATAL_ERROR "Unsupported Hermes prefab: expected libhermes or hermesvm")
endif()
target_link_libraries(releaseprofiler PRIVATE ${RELEASE_PROFILER_HERMES} ReactAndroid::jsi)

# Detect the API from the exact installed headers, not RN versions or prefab names.
# New Hermes moved process-wide profiling from HermesRuntime to IHermesRootAPI.
include(CheckCXXSourceCompiles)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_REQUIRED_LIBRARIES ${RELEASE_PROFILER_HERMES} ReactAndroid::jsi)
set(_RELEASE_PROFILER_TRY_COMPILE_TARGET_TYPE "${CMAKE_TRY_COMPILE_TARGET_TYPE}")
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
unset(RELEASE_PROFILER_HAS_ROOT_API CACHE)
check_cxx_source_compiles("
  #include <hermes/hermes.h>
  void check() {
    auto* api = facebook::jsi::castInterface<facebook::hermes::IHermesRootAPI>(
      facebook::hermes::makeHermesRootAPI());
    api->enableSamplingProfiler();
    api->disableSamplingProfiler();
    api->dumpSampledTraceToFile(\"profile\");
  }
" RELEASE_PROFILER_HAS_ROOT_API)
if(RELEASE_PROFILER_HAS_ROOT_API)
  target_compile_definitions(releaseprofiler PRIVATE RELEASE_PROFILER_USE_ROOT_API=1)
else()
  unset(RELEASE_PROFILER_HAS_STATIC_API CACHE)
  check_cxx_source_compiles("
    #include <hermes/hermes.h>
    void check() {
      facebook::hermes::HermesRuntime::enableSamplingProfiler();
      facebook::hermes::HermesRuntime::disableSamplingProfiler();
      facebook::hermes::HermesRuntime::dumpSampledTraceToFile(\"profile\");
    }
  " RELEASE_PROFILER_HAS_STATIC_API)
  if(NOT RELEASE_PROFILER_HAS_STATIC_API)
    message(FATAL_ERROR "Installed Hermes exposes neither supported sampling-profiler API")
  endif()
endif()
set(CMAKE_TRY_COMPILE_TARGET_TYPE "${_RELEASE_PROFILER_TRY_COMPILE_TARGET_TYPE}")
unset(CMAKE_REQUIRED_LIBRARIES)
