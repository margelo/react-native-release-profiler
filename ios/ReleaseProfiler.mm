#import <React/RCTBridgeModule.h>
#import <hermes/hermes.h>
#include <React/ReactNativeVersion.h>

#if REACT_NATIVE_VERSION_MINOR >= 81
using namespace facebook::hermes;
using namespace facebook::jsi;
#endif

@interface RCT_EXTERN_MODULE(ReleaseProfiler, NSObject)

RCT_EXTERN_METHOD(multiply:(float)a withB:(float)b
                 withResolver:(RCTPromiseResolveBlock)resolve
                 withRejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(startProfiling) {
#if REACT_NATIVE_VERSION_MINOR >= 81
    IHermesRootAPI *api = castInterface<IHermesRootAPI>(makeHermesRootAPI());
    api->enableSamplingProfiler();
#else
    facebook::hermes::HermesRuntime::enableSamplingProfiler();
#endif

    return [NSNumber numberWithInt:1];
}

RCT_EXPORT_METHOD(stopProfiling:(BOOL)saveInDownload
                 withResolver:(RCTPromiseResolveBlock)resolve
                 withRejecter:(RCTPromiseRejectBlock)reject) {
    NSFileManager* sharedFM = [NSFileManager defaultManager];
    NSURL *appDir=[[sharedFM URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] objectAtIndex:0];
    NSString * tempFilename = [NSString stringWithFormat:@"profile-%@%@", [[NSProcessInfo processInfo] globallyUniqueString], @".cpuprofile"];
    NSURL *fileURL=[appDir URLByAppendingPathComponent:tempFilename];
    std::string finalPath = std::string([fileURL.path UTF8String]);
    [sharedFM createFileAtPath:fileURL.path
                                            contents:[@"" dataUsingEncoding:NSUTF8StringEncoding]
                                    attributes:nil];

#if REACT_NATIVE_VERSION_MINOR >= 81
    IHermesRootAPI *api = castInterface<IHermesRootAPI>(makeHermesRootAPI());
    api->dumpSampledTraceToFile(finalPath);
    api->disableSamplingProfiler();
#else
    facebook::hermes::HermesRuntime::dumpSampledTraceToFile(finalPath);
    facebook::hermes::HermesRuntime::disableSamplingProfiler();
#endif

    resolve(fileURL.path);
}

@end
