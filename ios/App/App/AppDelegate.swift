import UIKit
import Capacitor
import FirebaseCore
import FirebaseMessaging
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    // Window, foreground/background and URL-open callbacks belong to SceneDelegate under
    // the scene manifest in Info.plist; iOS no longer calls their AppDelegate counterparts.

    /// Firebase runs only in builds that ship a GoogleService-Info.plist (git-ignored; see
    /// docs-internal/maintenance/push-notifications.md). Without it the APNs token is
    /// reported as before, which the Trinity gateway cannot deliver to. Info.plist turns off
    /// Firebase's app-delegate proxy, so the APNs token is handed over below, by hand.
    private var firebaseConfigured = false

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
            FirebaseApp.configure()
            firebaseConfigured = true
        }
        // App lock's "Hide on the lock screen": iOS shows this placeholder while it hides
        // previews, and only for a category registered before the notification arrives.
        // This set replaces all categories; Trinity registers no others (Capacitor's
        // LocalNotifications would only through registerActionTypes, which Trinity never calls).
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(
                identifier: "trinity.message.private",
                actions: [],
                intentIdentifiers: [],
                hiddenPreviewsBodyPlaceholder: "New message",
                options: []
            ),
        ])
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard firebaseConfigured else {
            NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
            return
        }
        // The gateway sends through FCM, so the pusher's pushkey must be the FCM token
        // (Capacitor's "Firebase on iOS" setup). The plugin accepts a String token.
        Messaging.messaging().apnsToken = deviceToken
        Messaging.messaging().token { token, error in
            if let error {
                NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
            } else if let token {
                NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: token)
            } else {
                // Neither a token nor an error: fail, so the registration never hangs.
                let error = NSError(
                    domain: "dev.trinityproject.trinity.push",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Firebase returned no registration token"]
                )
                NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
            }
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

}
