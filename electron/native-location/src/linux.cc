#include "result.h"

#include <gio/gio.h>
#include <algorithm>

namespace {
constexpr const char* kService = "org.freedesktop.GeoClue2";
constexpr const char* kManagerPath = "/org/freedesktop/GeoClue2/Manager";
constexpr const char* kProperties = "org.freedesktop.DBus.Properties";
constexpr const char* kClientInterface = "org.freedesktop.GeoClue2.Client";

struct Request {
  napi_env env;
  napi_deferred deferred;
  napi_async_work work;
  uint32_t timeout_ms;
  LocationResult result;
};

GVariant* Call(GDBusConnection* connection, const char* path,
               const char* interface, const char* method, GVariant* parameters,
               const GVariantType* reply_type, GError** error) {
  return g_dbus_connection_call_sync(connection, kService, path, interface,
                                     method, parameters, reply_type,
                                     G_DBUS_CALL_FLAGS_NONE, 5000, nullptr, error);
}

bool SetProperty(GDBusConnection* connection, const char* path,
                 const char* name, GVariant* value, GError** error) {
  GVariant* reply = Call(connection, path, kProperties, "Set",
                         g_variant_new("(ssv)", kClientInterface, name, value),
                         G_VARIANT_TYPE("()"), error);
  if (!reply) return false;
  g_variant_unref(reply);
  return true;
}

char* GetLocationPath(GDBusConnection* connection, const char* client_path) {
  GError* error = nullptr;
  GVariant* reply = Call(connection, client_path, kProperties, "Get",
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

void Execute(napi_env, void* data) {
  auto* request = static_cast<Request*>(data);
  GError* error = nullptr;
  GDBusConnection* connection = g_bus_get_sync(G_BUS_TYPE_SYSTEM, nullptr, &error);
  if (!connection) {
    request->result.status = LocationStatus::Unavailable;
    g_clear_error(&error);
    return;
  }

  GVariant* reply = Call(connection, kManagerPath,
                         "org.freedesktop.GeoClue2.Manager", "GetClient",
                         nullptr, G_VARIANT_TYPE("(o)"), &error);
  if (!reply) {
    request->result.status = error &&
            (g_strrstr(error->message, "Denied") ||
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

  bool configured =
      SetProperty(connection, client_path, "DesktopId",
                  g_variant_new_string("trinity"), &error) &&
      SetProperty(connection, client_path, "RequestedAccuracyLevel",
                  g_variant_new_uint32(5), &error);
  if (!configured) {
    request->result.status = LocationStatus::Denied;
    g_clear_error(&error);
    g_free(client_path);
    g_object_unref(connection);
    return;
  }

  reply = Call(connection, client_path, kClientInterface, "Start", nullptr,
               G_VARIANT_TYPE("()"), &error);
  if (!reply) {
    request->result.status = LocationStatus::Denied;
    g_clear_error(&error);
    g_free(client_path);
    g_object_unref(connection);
    return;
  }
  g_variant_unref(reply);

  const gint64 deadline = g_get_monotonic_time() +
      static_cast<gint64>(request->timeout_ms) * 1000;
  char* location_path = nullptr;
  while (g_get_monotonic_time() < deadline) {
    location_path = GetLocationPath(connection, client_path);
    if (location_path && g_strcmp0(location_path, "/") != 0) break;
    g_clear_pointer(&location_path, g_free);
    g_usleep(200000);
  }

  if (!location_path) {
    request->result.status = LocationStatus::Timeout;
  } else {
    reply = Call(connection, location_path, kProperties, "GetAll",
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
      request->result.status = LocationStatus::Error;
      g_clear_error(&error);
    }
  }

  reply = Call(connection, client_path, kClientInterface, "Stop", nullptr,
               G_VARIANT_TYPE("()"), &error);
  if (reply) g_variant_unref(reply);
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
  delete request;
}

napi_value RequestCurrentPosition(napi_env env, napi_callback_info info) {
  auto* request =
      new Request{env, nullptr, nullptr, TimeoutArgument(env, info), {}};
  napi_value promise;
  napi_create_promise(env, &request->deferred, &promise);
  napi_value name;
  napi_create_string_utf8(env, "GeoClue one-shot location", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, Execute, Complete, request,
                         &request->work);
  napi_queue_async_work(env, request->work);
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
