#include "result.h"

#include <winrt/Windows.Devices.Geolocation.h>
#include <winrt/Windows.Foundation.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <windows.h>

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
  std::atomic<bool> finished{false};
  std::mutex operations_mutex;
  IAsyncOperation<GeolocationAccessStatus> access{nullptr};
  IAsyncOperation<Geoposition> position{nullptr};
};

std::mutex current_mutex;
std::shared_ptr<Request> current_request;

void CallJs(napi_env env, napi_value, void*, void* data) {
  std::unique_ptr<std::shared_ptr<Request>> holder(
      static_cast<std::shared_ptr<Request>*>(data));
  const auto& request = *holder;
  napi_resolve_deferred(env, request->deferred, ResultToJs(env, request->result));
  napi_release_threadsafe_function(request->tsfn, napi_tsfn_release);
}

void Finish(const std::shared_ptr<Request>& request, LocationResult result) {
  bool expected = false;
  if (!request->finished.compare_exchange_strong(expected, true)) return;
  request->result = result;
  {
    std::scoped_lock lock(request->operations_mutex);
    request->access = nullptr;
    request->position = nullptr;
  }
  {
    std::scoped_lock lock(current_mutex);
    if (current_request == request) current_request.reset();
  }
  napi_call_threadsafe_function(
      request->tsfn, new std::shared_ptr<Request>(request),
      napi_tsfn_nonblocking);
}

LocationStatus ErrorStatus(hresult_error const& error) {
  return error.code() == E_ACCESSDENIED ? LocationStatus::Denied
                                        : LocationStatus::Error;
}

napi_value RequestCurrentPosition(napi_env env, napi_callback_info info) {
  auto request = std::make_shared<Request>();
  request->env = env;
  request->timeout_ms = TimeoutArgument(env, info);
  napi_value promise;
  napi_create_promise(env, &request->deferred, &promise);
  napi_value name;
  napi_create_string_utf8(env, "Windows one-shot location", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, nullptr,
                                  nullptr, nullptr, CallJs, &request->tsfn);
  {
    std::scoped_lock lock(current_mutex);
    if (current_request) {
      napi_resolve_deferred(
          env, request->deferred,
          ResultToJs(env, LocationResult{LocationStatus::Unavailable}));
      napi_release_threadsafe_function(request->tsfn, napi_tsfn_abort);
      return promise;
    }
    current_request = request;
  }

  try {
    const auto access = Geolocator::RequestAccessAsync();
    {
      std::scoped_lock lock(request->operations_mutex);
      request->access = access;
    }
    access.Completed(
        [request](auto const& operation, AsyncStatus status) {
          try {
            if (status != AsyncStatus::Completed) {
              Finish(request, LocationResult{
                                  status == AsyncStatus::Canceled
                                      ? LocationStatus::Cancelled
                                      : LocationStatus::Error});
              return;
            }
            if (operation.GetResults() != GeolocationAccessStatus::Allowed) {
              Finish(request, LocationResult{LocationStatus::Denied});
              return;
            }
            if (request->finished) return;
            Geolocator locator;
            locator.DesiredAccuracyInMeters(100);
            const TimeSpan maximum_age{60LL * 10'000'000};
            const TimeSpan timeout{
                static_cast<int64_t>(request->timeout_ms) * 10'000};
            const auto position = locator.GetGeopositionAsync(maximum_age, timeout);
            bool cancelled = false;
            {
              std::scoped_lock lock(request->operations_mutex);
              cancelled = request->finished;
              if (!cancelled) request->position = position;
            }
            if (cancelled) {
              position.Cancel();
              return;
            }
            position.Completed(
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

napi_value CancelCurrentRequest(napi_env env, napi_callback_info) {
  std::shared_ptr<Request> request;
  {
    std::scoped_lock lock(current_mutex);
    request = current_request;
  }
  if (request) {
    IAsyncOperation<GeolocationAccessStatus> access{nullptr};
    IAsyncOperation<Geoposition> position{nullptr};
    {
      std::scoped_lock lock(request->operations_mutex);
      access = request->access;
      position = request->position;
    }
    try {
      if (access) access.Cancel();
      if (position) position.Cancel();
    } catch (hresult_error const&) {
      // A completion racing cancellation may make Cancel invalid; Finish below
      // still settles the renderer-facing request exactly once.
    }
    Finish(request, LocationResult{LocationStatus::Cancelled});
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
}  // namespace

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
