#import <React/RCTBridgeModule.h>
#import <hermes/hermes.h>

using namespace facebook::hermes;
using namespace facebook::jsi;

@interface RCT_EXTERN_MODULE(ReleaseProfiler, NSObject)

RCT_EXTERN_METHOD(multiply:(float)a withB:(float)b
                 withResolver:(RCTPromiseResolveBlock)resolve
                 withRejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(startProfiling) {
    IHermesRootAPI *api = castInterface<IHermesRootAPI>(makeHermesRootAPI());
    api->enableSamplingProfiler();
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
    IHermesRootAPI *api = castInterface<IHermesRootAPI>(makeHermesRootAPI());
    api->dumpSampledTraceToFile(finalPath);
    api->disableSamplingProfiler();
    resolve(fileURL.path);
}

@end
