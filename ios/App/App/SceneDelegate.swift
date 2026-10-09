import UIKit
import Capacitor

/**
 * The app's scene delegate, required by the UIScene lifecycle that iOS 27 enforces.
 *
 * `UISceneStoryboardFile` in Info.plist makes UIKit build the window from `Main.storyboard`
 * (rooted at `MainViewController`) and assign it to `window` before `willConnectTo` runs, so
 * this delegate only forwards to Capacitor. Under the scene manifest iOS delivers custom URL
 * scheme opens (the authentication redirect) and universal links here instead of to
 * `AppDelegate`; `SceneDelegateProxy` re-posts them as the notifications the App plugin observes.
 */
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

}
