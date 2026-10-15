import Capacitor
import TrinityAppLockCore
import UIKit

/**
 * The App lock PIN verifier for the web layer (AppLockPinBridge in @trinity/capacitor-app-lock).
 * The PIN arrives once per call and is never logged, stored or returned; errors carry stable
 * codes only (every storage failure, read, write or delete, is `storage-unavailable`). Work runs
 * off the main thread: PBKDF2 takes a few hundred milliseconds.
 *
 * `cap sync` registers this class from the @trinity/capacitor-app-lock package, so it is a
 * public CAPPlugin: Capacitor's automatic registration skips CAPInstancePlugin subclasses.
 */
@objc(AppLockPlugin)
public class AppLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppLockPlugin"
    public let jsName = "TrinityAppLock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pinStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verifyPin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearPin", returnType: CAPPluginReturnPromise),
    ]
    private let verifier = PinVerifier(store: KeychainPinStore())
    private let work = DispatchQueue(label: "dev.trinityproject.trinity.app-lock.plugin", qos: .userInitiated)

    @objc func pinStatus(_ call: CAPPluginCall) {
        work.async {
            switch self.verifier.status() {
            case .ready(let set, let nextAttemptAt):
                call.resolve(["set": set, "nextAttemptAt": nextAttemptAt ?? NSNull()])
            case .unavailable:
                call.reject("Secure storage is unavailable", "storage-unavailable")
            }
        }
    }

    @objc func setPin(_ call: CAPPluginCall) {
        guard let pin = call.getString("pin") else {
            call.reject("Must provide pin", "pin-invalid")
            return
        }
        work.async {
            switch self.verifier.set(pin) {
            case .completed: call.resolve()
            case .invalid: call.reject("The PIN must be 4 to 16 digits", "pin-invalid")
            case .unavailable: call.reject("Secure storage is unavailable", "storage-unavailable")
            }
        }
    }

    @objc func verifyPin(_ call: CAPPluginCall) {
        // A missing PIN goes through the verifier as an empty one, so it meets the same order
        // as any malformed PIN: an unreadable record is unavailable, otherwise it is invalid.
        let pin = call.getString("pin") ?? ""
        work.async {
            switch self.verifier.verify(pin) {
            case .verified:
                call.resolve(["result": "verified", "nextAttemptAt": NSNull()])
            case .failed(let next):
                call.resolve(["result": "failed", "nextAttemptAt": next ?? NSNull()])
            case .delayed(let next):
                call.resolve(["result": "delayed", "nextAttemptAt": next])
            case .invalid:
                call.resolve(["result": "invalid", "nextAttemptAt": NSNull()])
            case .unavailable:
                call.resolve(["result": "unavailable", "nextAttemptAt": NSNull()])
            }
        }
    }

    @objc func clearPin(_ call: CAPPluginCall) {
        work.async {
            if self.verifier.clear() {
                call.resolve()
            } else {
                call.reject("Secure storage is unavailable", "storage-unavailable")
            }
        }
    }
}
