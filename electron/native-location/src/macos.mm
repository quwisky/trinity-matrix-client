#import <CoreLocation/CoreLocation.h>
#import <Foundation/Foundation.h>

#include "result.h"

namespace {
struct Request;

@interface TrinityLocationDelegate : NSObject <CLLocationManagerDelegate>
@property(nonatomic, assign) Request* request;
@property(nonatomic, assign) BOOL started;
@end

struct Request {
  napi_env env;
  napi_deferred deferred;
  CLLocationManager* manager;
  TrinityLocationDelegate* delegate;
  bool finished = false;
};

void Finish(Request* request, LocationResult result) {
  if (!request || request->finished) return;
  request->finished = true;
  [request->manager stopUpdatingLocation];
  request->manager.delegate = nil;
  napi_resolve_deferred(request->env, request->deferred,
                        ResultToJs(request->env, result));
  request->delegate = nil;
  request->manager = nil;
}

@implementation TrinityLocationDelegate
- (void)locationManagerDidChangeAuthorization:(CLLocationManager*)manager {
  CLAuthorizationStatus status = manager.authorizationStatus;
  if (status == kCLAuthorizationStatusDenied ||
      status == kCLAuthorizationStatusRestricted) {
    Finish(self.request, LocationResult{LocationStatus::Denied});
  } else if (status == kCLAuthorizationStatusAuthorizedAlways ||
             status == kCLAuthorizationStatusAuthorizedWhenInUse) {
    if (!self.started) {
      self.started = YES;
      [manager requestLocation];
    }
  }
}

- (void)locationManager:(CLLocationManager*)manager
     didUpdateLocations:(NSArray<CLLocation*>*)locations {
  CLLocation* location = locations.lastObject;
  if (!location) {
    Finish(self.request, LocationResult{LocationStatus::Error});
    return;
  }
  Finish(self.request,
         LocationResult{LocationStatus::Ok, location.coordinate.latitude,
                        location.coordinate.longitude,
                        location.horizontalAccuracy});
}

- (void)locationManager:(CLLocationManager*)manager
       didFailWithError:(NSError*)error {
  LocationStatus status = error.code == kCLErrorDenied
      ? LocationStatus::Denied
      : LocationStatus::Error;
  Finish(self.request, LocationResult{status});
}
@end

napi_value RequestCurrentPosition(napi_env env, napi_callback_info info) {
  const uint32_t timeout_ms = TimeoutArgument(env, info);
  napi_value promise;
  napi_deferred deferred;
  napi_create_promise(env, &deferred, &promise);

  if (![CLLocationManager locationServicesEnabled]) {
    napi_resolve_deferred(
        env, deferred,
        ResultToJs(env, LocationResult{LocationStatus::Unavailable}));
    return promise;
  }

  auto* request = new Request{env, deferred};
  request->manager = [[CLLocationManager alloc] init];
  request->delegate = [[TrinityLocationDelegate alloc] init];
  request->delegate.request = request;
  request->manager.delegate = request->delegate;
  request->manager.desiredAccuracy = kCLLocationAccuracyHundredMeters;
  [request->manager requestWhenInUseAuthorization];
  if (request->manager.authorizationStatus ==
          kCLAuthorizationStatusAuthorizedAlways ||
      request->manager.authorizationStatus ==
          kCLAuthorizationStatusAuthorizedWhenInUse) {
    request->delegate.started = YES;
    [request->manager requestLocation];
  }

  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW,
                    static_cast<int64_t>(timeout_ms) * NSEC_PER_MSEC),
      dispatch_get_main_queue(), ^{
        Finish(request, LocationResult{LocationStatus::Timeout});
        // A successful callback may finish before this deadline. Keeping the tiny
        // request allocation alive until here prevents this timeout block from
        // dereferencing freed memory.
        delete request;
      });
  return promise;
}
}  // namespace

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "requestCurrentPosition", NAPI_AUTO_LENGTH,
                       RequestCurrentPosition, nullptr, &fn);
  napi_set_named_property(env, exports, "requestCurrentPosition", fn);
  return exports;
}
