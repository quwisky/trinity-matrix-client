#include "result.h"

#include <gio/gio.h>
#include <algorithm>
#include <atomic>
#include <climits>

namespace {
constexpr const char* kService = "org.freedesktop.GeoClue2";
constexpr const char* kManagerPath = "/org/freedesktop/GeoClue2/Manager";
constexpr const char* kProperties = "org.freedesktop.DBus.Properties";
constexpr const char* kClientInterface = "org.freedesktop.GeoClue2.Client";

struct Request {
  napi_env env;
  napi_deferred deferred;
  napi_async_work work;
  gint64 deadline;
  std::atomic<bool> cancelled{false};
  GCancellable* cancellable;
  LocationResult result;
};

std::atomic<Request*> current_request{nullptr};

int RemainingMs(const Request* request) {
  const gint64 remaining =
      (request->deadline - g_get_monotonic_time()) / 1000;
  return static_cast<int>(std::clamp<gint64>(remaining, 1, INT_MAX));
}

GVariant* Call(Request* request, GDBusConnection* connection, const char* path,
               const char* interface, const char* method, GVariant* parameters,
               const GVariantType* reply_type, GError** error) {
  return g_dbus_connection_call_sync(connection, kService, path, interface,
                                     method, parameters, reply_type,
                                     G_DBUS_CALL_FLAGS_NONE,
                                     RemainingMs(request), request->cancellable,
                                     error);
}

bool SetProperty(Request* request, GDBusConnection* connection, const char* path,
                 const char* name, GVariant* value, GError** error) {
  GVariant* reply = Call(request, connection, path, kProperties, "Set",
                         g_variant_new("(ssv)", kClientInterface, name, value),
                         G_VARIANT_TYPE("()"), error);
  if (!reply) return false;
  g_variant_unref(reply);
  return true;
}

char* GetLocationPath(Request* request, GDBusConnection* connection,
                      const char* client_path) {
  GError* error = nullptr;
  GVariant* reply = Call(request, connection, client_path, kProperties, "Get",
                         g_variant_new("(ss)", kClientInterface, "Location"),
                         G_VARIANT_TYPE("(v)"), &error);
  if (!reply) {
    g_clear_error(&error);
    return nullptr;
  }
  GVariant* boxed = nullptr;
  g_variant_get(reply, "(v)", &boxed);
  const char* value = g_variant_get_string(boxed, nullptr);
  char* path = g_strdup(value);
  g_variant_unref(boxed);
  g_variant_unref(reply);
  return path;
}

void StopClient(GDBusConnection* connection, const char* client_path) {
  // Use a separate, tightly bounded cleanup call so a cancelled Start reply
  // cannot leave a GeoClue client running on the shared system-bus connection.
  GError* error = nullptr;
  GVariant* reply = g_dbus_connection_call_sync(
      connection, kService, client_path, kClientInterface, "Stop", nullptr,
      G_VARIANT_TYPE("()"), G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &error);
  if (reply) g_variant_unref(reply);
  g_clear_error(&error);
}

void Execute(napi_env, void* data) {
  auto* request = static_cast<Request*>(data);
  if (request->cancelled) {
    request->result.status = LocationStatus::Cancelled;
    return;
  }
  GError* error = nullptr;
  GDBusConnection* connection =
      g_bus_get_sync(G_BUS_TYPE_SYSTEM, request->cancellable, &error);
  if (!connection) {
    request->result.status = request->cancelled
        ? LocationStatus::Cancelled
        : LocationStatus::Unavailable;
    g_clear_error(&error);
    return;
  }

  GVariant* reply = Call(request, connection, kManagerPath,
                         "org.freedesktop.GeoClue2.Manager", "GetClient",
                         nullptr, G_VARIANT_TYPE("(o)"), &error);
  if (!reply) {
    request->result.status = request->cancelled
        ? LocationStatus::Cancelled
        : error && (g_strrstr(error->message, "Denied") ||
                    g_strrstr(error->message, "authorized"))
            ? LocationStatus::Denied
            : LocationStatus::Unavailable;
    g_clear_error(&error);
    g_object_unref(connection);
    return;
  }

  const char* borrowed_path = nullptr;
  g_variant_get(reply, "(&o)", &borrowed_path);
  char* client_path = g_strdup(borrowed_path);
  g_variant_unref(reply);

  if (request->cancelled) {
    request->result.status = LocationStatus::Cancelled;
    StopClient(connection, client_path);
    g_free(client_path);
    g_object_unref(connection);
    return;
  }

  bool configured =
      SetProperty(request, connection, client_path, "DesktopId",
                  g_variant_new_string("trinity"), &error) &&
      SetProperty(request, connection, client_path, "RequestedAccuracyLevel",
                  g_variant_new_uint32(5), &error);
  if (!configured) {
    request->result.status = request->cancelled
        ? LocationStatus::Cancelled
        : LocationStatus::Denied;
    g_clear_error(&error);
    StopClient(connection, client_path);
    g_free(client_path);
    g_object_unref(connection);
    return;
  }

  reply = Call(request, connection, client_path, kClientInterface, "Start", nullptr,
               G_VARIANT_TYPE("()"), &error);
  if (!reply) {
    request->result.status = request->cancelled
        ? LocationStatus::Cancelled
        : LocationStatus::Denied;
    g_clear_error(&error);
    StopClient(connection, client_path);
    g_free(client_path);
    g_object_unref(connection);
    return;
  }
  g_variant_unref(reply);

  char* location_path = nullptr;
  while (g_get_monotonic_time() < request->deadline && !request->cancelled) {
    location_path = GetLocationPath(request, connection, client_path);
    if (location_path && g_strcmp0(location_path, "/") != 0) break;
    g_clear_pointer(&location_path, g_free);
    g_usleep(200000);
  }

  if (!location_path) {
    request->result.status = request->cancelled
        ? LocationStatus::Cancelled
        : LocationStatus::Timeout;
  } else if (request->cancelled) {
    request->result.status = LocationStatus::Cancelled;
  } else {
    reply = Call(request, connection, location_path, kProperties, "GetAll",
                 g_variant_new("(s)", "org.freedesktop.GeoClue2.Location"),
                 G_VARIANT_TYPE("(a{sv})"), &error);
    if (reply) {
      GVariant* values = nullptr;
      g_variant_get(reply, "(@a{sv})", &values);
      double lat = 0, lng = 0, accuracy = 0;
      const bool valid =
          g_variant_lookup(values, "Latitude", "d", &lat) &&
          g_variant_lookup(values, "Longitude", "d", &lng) &&
          g_variant_lookup(values, "Accuracy", "d", &accuracy);
      request->result = valid
          ? LocationResult{LocationStatus::Ok, lat, lng, accuracy}
          : LocationResult{LocationStatus::Error};
      g_variant_unref(values);
      g_variant_unref(reply);
    } else {
      request->result.status = request->cancelled
          ? LocationStatus::Cancelled
          : LocationStatus::Error;
      g_clear_error(&error);
    }
  }

  StopClient(connection, client_path);
  g_clear_error(&error);
  g_free(location_path);
  g_free(client_path);
  g_object_unref(connection);
}

void Complete(napi_env env, napi_status status, void* data) {
  auto* request = static_cast<Request*>(data);
  if (status != napi_ok) request->result.status = LocationStatus::Cancelled;
  napi_resolve_deferred(env, request->deferred, ResultToJs(env, request->result));
  napi_delete_async_work(env, request->work);
  Request* expected = request;
  current_request.compare_exchange_strong(expected, nullptr);
  g_object_unref(request->cancellable);
  delete request;
}

napi_value RequestCurrentPosition(napi_env env, napi_callback_info info) {
  const gint64 deadline = g_get_monotonic_time() +
      static_cast<gint64>(TimeoutArgument(env, info)) * 1000;
  auto* request = new Request{
      env, nullptr, nullptr, deadline, false, g_cancellable_new(), {}};
  napi_value promise;
  napi_create_promise(env, &request->deferred, &promise);
  Request* expected = nullptr;
  if (!current_request.compare_exchange_strong(expected, request)) {
    napi_resolve_deferred(
        env, request->deferred,
        ResultToJs(env, LocationResult{LocationStatus::Unavailable}));
    g_object_unref(request->cancellable);
    delete request;
    return promise;
  }
  napi_value name;
  napi_create_string_utf8(env, "GeoClue one-shot location", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, Execute, Complete, request,
                         &request->work);
  napi_queue_async_work(env, request->work);
  return promise;
}

napi_value CancelCurrentRequest(napi_env env, napi_callback_info) {
  if (auto* request = current_request.load()) {
    request->cancelled = true;
    g_cancellable_cancel(request->cancellable);
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
