import Capacitor
import UIKit

/**
 * The app's web view controller, subclassed for one setting.
 *
 * WKWebView ships with `allowsBackForwardNavigationGestures` off, and Capacitor does not turn
 * it on — the string appears nowhere in `@capacitor/ios`. So an iOS build had no back gesture
 * at all, while Android has had one all along: Capacitor's bridge routes the system back
 * (button and gesture alike) to the `backButton` event `AppComponent` already listens for.
 * That left the edge swipe, which is how people leave a screen on iOS, doing nothing here.
 *
 * Enabled rather than reimplemented in JavaScript. The platform gesture is interruptible,
 * rubber-bands correctly, and matches every other app on the device; a hand-rolled one would
 * be a pointer-gesture engine competing with native scrolling — including the horizontally
 * scrollable code blocks in the timeline — for a worse result.
 *
 * It drives WEB VIEW history, which since the room moved into the URL is the router's own
 * history, so a swipe lands on the same paths the Back chain already handles.
 *
 * KNOWN GAP, deliberately accepted: unlike Android's `backButton`, this gesture cannot be
 * intercepted, so it navigates rather than first closing an open right-hand panel. A swipe
 * with the thread panel open therefore leaves the room instead of closing the panel. The
 * alternative is reimplementing the gesture to route through `BackInterceptorService`, which
 * trades a correct platform gesture for a worse one to fix a second-order case; the in-app
 * close button is unaffected, and Android keeps the full chain.
 */
class MainViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
    }
}
