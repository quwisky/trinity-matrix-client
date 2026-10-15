// Windows Hello for App lock (spec 2026-10-12). Two calls, each a Promise of a stable string:
//   availability()              UserConsentVerifier.CheckAvailabilityAsync
//   verify(windowHandle, text)  IUserConsentVerifierInterop::RequestVerificationForWindowAsync
// The window handle makes Trinity's window own the Hello dialog. Nothing is logged, and no
// Windows error text crosses into JavaScript.
#include <node_api.h>
#include <windows.h>
#include <userconsentverifierinterop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.UI.h>
#include <string>

namespace {

using winrt::Windows::Security::Credentials::UI::UserConsentVerificationResult;
using winrt::Windows::Security::Credentials::UI::UserConsentVerifier;
using winrt::Windows::Security::Credentials::UI::UserConsentVerifierAvailability;

const char* AvailabilityName(UserConsentVerifierAvailability value) {
  switch (value) {
    case UserConsentVerifierAvailability::Available: return "available";
    case UserConsentVerifierAvailability::DeviceNotPresent: return "device-not-present";
    case UserConsentVerifierAvailability::NotConfiguredForUser: return "not-configured";
    case UserConsentVerifierAvailability::DisabledByPolicy: return "disabled-by-policy";
    case UserConsentVerifierAvailability::DeviceBusy: return "device-busy";
    default: return "unknown";
  }
}

const char* ResultName(UserConsentVerificationResult value) {
  switch (value) {
    case UserConsentVerificationResult::Verified: return "verified";
    case UserConsentVerificationResult::Canceled: return "cancelled";
    case UserConsentVerificationResult::RetriesExhausted: return "retries-exhausted";
    case UserConsentVerificationResult::DeviceNotPresent: return "device-not-present";
    case UserConsentVerificationResult::NotConfiguredForUser: return "not-configured";
    case UserConsentVerificationResult::DisabledByPolicy: return "disabled-by-policy";
    case UserConsentVerificationResult::DeviceBusy: return "device-busy";
    default: return "unknown";
  }
}

struct Work {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  bool verify = false;
  HWND window = nullptr;
  std::wstring message;
  const char* result = "unknown";
};

// Runs on a libuv pool thread, never the JavaScript thread, so blocking on get() is safe.
void Execute(napi_env, void* data) {
  auto* job = static_cast<Work*>(data);
  bool apartment = false;
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    apartment = true;
    if (!job->verify) {
      job->result = AvailabilityName(UserConsentVerifier::CheckAvailabilityAsync().get());
    } else {
      auto factory = winrt::get_activation_factory<UserConsentVerifier, IUserConsentVerifierInterop>();
      winrt::Windows::Foundation::IAsyncOperation<UserConsentVerificationResult> operation{nullptr};
      winrt::hstring text{job->message};
      winrt::check_hresult(factory->RequestVerificationForWindowAsync(
          job->window,
          static_cast<HSTRING>(winrt::get_abi(text)),
          winrt::guid_of<winrt::Windows::Foundation::IAsyncOperation<UserConsentVerificationResult>>(),
          winrt::put_abi(operation)));
      job->result = ResultName(operation.get());
    }
  } catch (...) {
    job->result = "unknown";
  }
  // Balance only an apartment this call entered; a failed init must not undo another's.
  if (apartment) winrt::uninit_apartment();
}

void Complete(napi_env env, napi_status, void* data) {
  auto* job = static_cast<Work*>(data);
  napi_value value;
  napi_create_string_utf8(env, job->result, NAPI_AUTO_LENGTH, &value);
  napi_resolve_deferred(env, job->deferred, value);
  napi_delete_async_work(env, job->work);
  delete job;
}

napi_value Queue(napi_env env, Work* job) {
  napi_value promise;
  napi_value name;
  napi_create_promise(env, &job->deferred, &promise);
  napi_create_string_utf8(env, "trinity-windows-hello", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, Execute, Complete, job, &job->work);
  napi_queue_async_work(env, job->work);
  return promise;
}

napi_value Availability(napi_env env, napi_callback_info) {
  return Queue(env, new Work{});
}

napi_value Verify(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* job = new Work{};
  job->verify = true;
  void* handle = nullptr;
  size_t length = 0;
  if (argc >= 1 && napi_get_buffer_info(env, argv[0], &handle, &length) == napi_ok &&
      length >= sizeof(HWND)) {
    job->window = *static_cast<HWND*>(handle);
  }
  if (argc >= 2) {
    size_t chars = 0;
    if (napi_get_value_string_utf16(env, argv[1], nullptr, 0, &chars) == napi_ok) {
      std::u16string text(chars, u'\0');
      napi_get_value_string_utf16(env, argv[1], text.data(), chars + 1, &chars);
      job->message.assign(text.begin(), text.end());
    }
  }
  if (job->window == nullptr) {
    napi_value promise;
    napi_value value;
    napi_create_promise(env, &job->deferred, &promise);
    napi_create_string_utf8(env, "unknown", NAPI_AUTO_LENGTH, &value);
    napi_resolve_deferred(env, job->deferred, value);
    delete job;
    return promise;
  }
  return Queue(env, job);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"availability", nullptr, Availability, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"verify", nullptr, Verify, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
