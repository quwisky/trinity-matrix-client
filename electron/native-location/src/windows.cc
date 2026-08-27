#include "result.h"

#include <winrt/Windows.Devices.Geolocation.h>
#include <winrt/Windows.Foundation.h>
#include <memory>
#include <string>

using namespace winrt;
using namespace Windows::Devices::Geolocation;
using namespace Windows::Foundation;

namespace {
struct Request {
  napi_env env;
  napi_deferred deferred;
  napi_threadsafe_function tsfn;
  LocationResult result;
  uint32_t timeout_ms;
};

void CallJs(napi_env env, napi_value, void*, void* data) {
  std::unique_ptr<Request> request(static_cast<Request*>(data));
  napi_resolve_deferred(env, request->deferred,
                        ResultToJs(env, request->result));
  napi_release_threadsafe_function(request->tsfn, napi_tsfn_release);
}

void Finish(Request* request, LocationResult result) {
  request->result = result;
  napi_call_threadsafe_function(request->tsfn, request, napi_tsfn_nonblocking);
}

LocationStatus ErrorStatus(hresult_error const& error) {
  const std::wstring message{error.message()};
  return message.find(L"denied") != std::wstring::npos ||
         message.find(L"permission") != std::wstring::npos
      ? LocationStatus::Denied
      : LocationStatus::Error;
}

napi_value RequestCurrentPosition(napi_env env, napi_callback_info info) {
  auto* request = new Request{env, nullptr, nullptr, {}, TimeoutArgument(env, info)};
  napi_value promise;
  napi_create_promise(env, &request->deferred, &promise);
  napi_value name;
  napi_create_string_utf8(env, "Windows one-shot location", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, nullptr,
                                  nullptr, nullptr, CallJs, &request->tsfn);

  try {
    Geolocator::RequestAccessAsync().Completed(
        [request](auto const& operation, AsyncStatus status) {
          try {
            if (status != AsyncStatus::Completed ||
                operation.GetResults() != GeolocationAccessStatus::Allowed) {
              Finish(request, LocationResult{LocationStatus::Denied});
              return;
            }
            Geolocator locator;
            locator.DesiredAccuracyInMeters(100);
            const TimeSpan maximum_age{60LL * 10'000'000};
            const TimeSpan timeout{
                static_cast<int64_t>(request->timeout_ms) * 10'000};
            locator.GetGeopositionAsync(maximum_age, timeout).Completed(
                [request, locator](auto const& position_operation,
                                   AsyncStatus position_status) {
                  try {
                    if (position_status != AsyncStatus::Completed) {
                      Finish(request, LocationResult{LocationStatus::Timeout});
                      return;
                    }
                    auto coordinate =
                        position_operation.GetResults().Coordinate();
                    auto point = coordinate.Point().Position();
                    Finish(request,
                           LocationResult{LocationStatus::Ok, point.Latitude,
                                          point.Longitude,
                                          coordinate.Accuracy()});
                  } catch (hresult_error const& error) {
                    Finish(request, LocationResult{ErrorStatus(error)});
                  }
                });
          } catch (hresult_error const& error) {
            Finish(request, LocationResult{ErrorStatus(error)});
          }
        });
  } catch (hresult_error const& error) {
    Finish(request, LocationResult{ErrorStatus(error)});
  }
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
