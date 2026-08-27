#pragma once

#include <node_api.h>

enum class LocationStatus {
  Ok,
  Denied,
  Unavailable,
  Timeout,
  Cancelled,
  Error,
};

struct LocationResult {
  LocationStatus status = LocationStatus::Error;
  double lat = 0;
  double lng = 0;
  double accuracy = 0;
};

inline const char* StatusName(LocationStatus status) {
  switch (status) {
    case LocationStatus::Ok: return "ok";
    case LocationStatus::Denied: return "denied";
    case LocationStatus::Unavailable: return "unavailable";
    case LocationStatus::Timeout: return "timeout";
    case LocationStatus::Cancelled: return "cancelled";
    default: return "error";
  }
}

inline napi_value ResultToJs(napi_env env, const LocationResult& result) {
  napi_value value;
  napi_create_object(env, &value);
  napi_value status;
  napi_create_string_utf8(env, StatusName(result.status), NAPI_AUTO_LENGTH, &status);
  napi_set_named_property(env, value, "status", status);
  if (result.status == LocationStatus::Ok) {
    napi_value lat;
    napi_value lng;
    napi_value accuracy;
    napi_create_double(env, result.lat, &lat);
    napi_create_double(env, result.lng, &lng);
    napi_create_double(env, result.accuracy, &accuracy);
    napi_set_named_property(env, value, "lat", lat);
    napi_set_named_property(env, value, "lng", lng);
    napi_set_named_property(env, value, "accuracy", accuracy);
  }
  return value;
}

inline uint32_t TimeoutArgument(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t timeout = 20000;
  if (argc == 1) napi_get_value_uint32(env, argv[0], &timeout);
  return timeout;
}
