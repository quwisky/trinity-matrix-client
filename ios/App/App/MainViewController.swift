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
