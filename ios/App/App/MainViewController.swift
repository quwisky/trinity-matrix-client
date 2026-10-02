import Capacitor
import UIKit

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
        bridge?.registerPluginInstance(NativeNavigationPlugin())
        bridge?.registerPluginInstance(AppIconPlugin())
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
 * Switches the home-screen icon for the App icon preference.
 *
 * `name` is an alternate icon set (`AppIconBlurple`, `AppIconDark`) or null for the primary
 * icon, which carries its own light/dark/tinted appearances ("Match system"). iOS shows a
 * system alert on every change, so an unchanged request resolves without calling it.
 */
@objc(AppIconPlugin)
class AppIconPlugin: CAPInstancePlugin, CAPBridgedPlugin {
    let identifier = "AppIconPlugin"
    let jsName = "AppIcon"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise)
    ]

    @objc func set(_ call: CAPPluginCall) {
        let name = call.getString("name")
        DispatchQueue.main.async {
            let app = UIApplication.shared
            guard app.supportsAlternateIcons, app.alternateIconName != name else {
                call.resolve()
                return
            }
            app.setAlternateIconName(name) { error in
                if let error = error {
                    call.reject(error.localizedDescription)
                } else {
                    call.resolve()
                }
            }
        }
    }
}
