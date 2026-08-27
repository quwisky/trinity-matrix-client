#import <CoreLocation/CoreLocation.h>
#import <Foundation/Foundation.h>

#include "result.h"

struct TrinityLocationRequest;

@interface TrinityLocationDelegate : NSObject <CLLocationManagerDelegate>
@property(nonatomic, assign) TrinityLocationRequest* request;
@property(nonatomic, assign) BOOL started;
@end

struct TrinityLocationRequest {
  napi_env env;
  napi_deferred deferred;
  CLLocationManager* manager;
  TrinityLocationDelegate* delegate;
  bool finished = false;
};

static TrinityLocationRequest* current_request = nullptr;

static void Finish(TrinityLocationRequest* request, LocationResult result) {
  if (!request || request->finished) return;
  request->finished = true;
  if (current_request == request) current_request = nullptr;
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

static napi_value RequestCurrentPosition(napi_env env, napi_callback_info info) {
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
  if (current_request) {
    napi_resolve_deferred(
        env, deferred,
        ResultToJs(env, LocationResult{LocationStatus::Unavailable}));
    return promise;
  }

  auto* request = new TrinityLocationRequest{env, deferred};
  current_request = request;
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

static napi_value CancelCurrentRequest(napi_env env, napi_callback_info) {
  Finish(current_request, LocationResult{LocationStatus::Cancelled});
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "requestCurrentPosition", NAPI_AUTO_LENGTH,
                       RequestCurrentPosition, nullptr, &fn);
  napi_set_named_property(env, exports, "requestCurrentPosition", fn);
  napi_create_function(env, "cancelCurrentRequest", NAPI_AUTO_LENGTH,
                       CancelCurrentRequest, nullptr, &fn);
  napi_set_named_property(env, exports, "cancelCurrentRequest", fn);
  return exports;
}
