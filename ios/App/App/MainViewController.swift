import Capacitor
import UIKit
import UserNotifications

/**
 * The app's bridge for coordinating WebKit history gestures with Angular-owned surfaces.
 *
 * WKWebView ships with `allowsBackForwardNavigationGestures` off, and Capacitor does not turn
 * it on. Trinity enables it while Angular reports no dialog or registered panel that should
 * consume Back first. Both WebKit edges share this one switch, so disabling it also yields
 * the right edge to the open drawer's closing gesture.
 *
 * Start disabled, deliberately. A rejected bridge call should lose the convenience gesture,
 * not restore the bug where WebKit navigates underneath a visible panel. Angular explicitly
 * enables it after the root shell has observed an empty interception stack.
 */
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.allowsBackForwardNavigationGestures = false
        // Capacitor paints the WebView with systemBackground (black in dark mode) until the first
        // page paint. The launch screen's colour set follows the system appearance, which
        // capacitor.config.ts's single `backgroundColor` can't.
        if let launchBackground = UIColor(named: "LaunchBackground") {
            webView?.backgroundColor = launchBackground
            webView?.scrollView.backgroundColor = launchBackground
        }
        bridge?.registerPluginInstance(NativeNavigationPlugin())
        bridge?.registerPluginInstance(AppSettingsPlugin())
        bridge?.registerPluginInstance(KeyboardFramePlugin())
    }
}

/**
 * Reports each keyboard frame change with the keyboard's own animation timing, so the web layout
 * moves with the keyboard (`NativeKeyboardInsetAdapter`). The keyboard plugin's events carry only
 * a height, and its hide event waits a run-loop turn.
 *
 * The height is the part of the WebView the keyboard covers, as Apple advises, so a hardware
 * keyboard's off-screen frame reports only its visible bar.
 */
@objc(KeyboardFramePlugin)
class KeyboardFramePlugin: CAPInstancePlugin, CAPBridgedPlugin {
    let identifier = "KeyboardFramePlugin"
    let jsName = "KeyboardFrame"
    let pluginMethods: [CAPPluginMethod] = []

    override func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillChangeFrame(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
    }

    @objc func keyboardWillChangeFrame(_ notification: Notification) {
        guard let webView = bridge?.webView, let screen = webView.window?.screen,
              let info = notification.userInfo,
              let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        else { return }
        let frame = webView.convert(end, from: screen.coordinateSpace)
        let covered = webView.bounds.intersection(frame)
        notifyListeners("keyboardFrame", data: [
            "height": covered.isNull ? 0 : covered.height,
            "duration": info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0,
            "curve": info[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int ?? 0
        ])
    }
}

@objc(NativeNavigationPlugin)
class NativeNavigationPlugin: CAPInstancePlugin, CAPBridgedPlugin {
    let identifier = "NativeNavigationPlugin"
    let jsName = "NativeNavigation"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setGesturesEnabled", returnType: CAPPluginReturnPromise)
    ]

    @objc func setGesturesEnabled(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else {
            call.reject("Must provide enabled")
            return
        }

        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.allowsBackForwardNavigationGestures = enabled
            call.resolve()
        }
    }
}

/**
 * Opens Trinity's page in the Settings app, where a permission the user refused can be turned
 * back on. The composer offers it after camera or photo-library access is denied (#919).
 * App lock's "Hide on the lock screen" opens Trinity's notification page and reads its Show
 * Previews setting, which that choice follows.
 */
@objc(AppSettingsPlugin)
class AppSettingsPlugin: CAPInstancePlugin, CAPBridgedPlugin {
    let identifier = "AppSettingsPlugin"
    let jsName = "AppSettings"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openNotificationSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notificationPreviewSetting", returnType: CAPPluginReturnPromise)
    ]

    @objc func openAppSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("Settings are unavailable")
                return
            }
            UIApplication.shared.open(url) { opened in
                if opened {
                    call.resolve()
                } else {
                    call.reject("Settings are unavailable")
                }
            }
        }
    }

    /// Trinity's page under Settings › Notifications (iOS 16 and later; the app targets 16.4).
    @objc func openNotificationSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else {
                call.reject("Settings are unavailable")
                return
            }
            UIApplication.shared.open(url) { opened in
                if opened {
                    call.resolve()
                } else {
                    call.reject("Settings are unavailable")
                }
            }
        }
    }

    /// Show Previews for Trinity: "always", "whenUnlocked" or "never"; null for a value this
    /// build doesn't know.
    @objc func notificationPreviewSetting(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let value: Any
            switch settings.showPreviewsSetting {
            case .always: value = "always"
            case .whenAuthenticated: value = "whenUnlocked"
            case .never: value = "never"
            @unknown default: value = NSNull()
            }
            call.resolve(["value": value])
        }
    }
}
