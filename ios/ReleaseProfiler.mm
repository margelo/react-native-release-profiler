#import <React/RCTBridgeModule.h>
#import <hermes/hermes.h>
@interface RCT_EXTERN_MODULE(ReleaseProfiler, NSObject)

RCT_EXTERN_METHOD(multiply:(float)a withB:(float)b
                 withResolver:(RCTPromiseResolveBlock)resolve
                 withRejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(startProfiling) {
    facebook::hermes::HermesRuntime::enableSamplingProfiler();
    return [NSNumber numberWithInt:1];
}

RCT_EXPORT_METHOD(stopProfiling:(RCTPromiseResolveBlock)resolve
                 withRejecter:(RCTPromiseRejectBlock)reject) {
    NSFileManager* sharedFM = [NSFileManager defaultManager];
    NSURL *appDir=[[sharedFM URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] objectAtIndex:0];
    NSURL *fileURL=[appDir URLByAppendingPathComponent:@"profile.cpuprofile"];
    std::string finalPath = std::string([fileURL.path UTF8String]);
    [sharedFM createFileAtPath:fileURL.path
                                            contents:[@"" dataUsingEncoding:NSUTF8StringEncoding]
                                    attributes:nil];
    facebook::hermes::HermesRuntime::dumpSampledTraceToFile(finalPath);
    facebook::hermes::HermesRuntime::disableSamplingProfiler();
    resolve(fileURL.path);
}

@end
