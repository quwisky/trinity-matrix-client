import Foundation
import UIKit
import Capacitor
import FirebaseCore
import FirebaseMessaging

/// Owns the Firebase/APNs token relationship for the Capacitor bridge.
final class TrinityPushRegistration: NSObject, MessagingDelegate {
    static let shared = TrinityPushRegistration()

    private override init() {
        super.init()
    }

    private static let registrationError = NSError(
        domain: "TrinityPushRegistration",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Push registration failed"]
    )

    private lazy var coordinator = TrinityPushTokenCoordinator(
        requestAPNs: {
            UIApplication.shared.registerForRemoteNotifications()
        },
        mapAPNs: { deviceToken in
            Messaging.messaging().apnsToken = deviceToken
        },
        fetchFCM: { completion in
            Messaging.messaging().token { token, error in
                DispatchQueue.main.async {
                    completion(token, error)
                }
            }
        },
        emitToken: { [weak self] token in self?.postToken(token) },
        emitFailure: { [weak self] _ in self?.postRegistrationError() }
    )

    var isConfigured: Bool {
        FirebaseApp.app() != nil
    }

    func setAPNsToken(_ token: Data) {
        onMain { [weak self] in self?.coordinator.setAPNsToken(token) }
    }

    func register() {
        onMain { [weak self] in self?.coordinator.register() }
    }

    func configureMessaging() {
        onMain { [weak self] in
            guard let self, self.isConfigured else { return }
            Messaging.messaging().delegate = self
        }
    }

    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        onMain { [weak self] in self?.coordinator.didReceiveFCMToken(fcmToken) }
    }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    private func postRegistrationError() {
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: Self.registrationError
        )
    }

    private func postToken(_ token: String) {
        // Capacitor PushNotificationsPlugin accepts String tokens. Never pass APNs Data here.
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: token
        )
    }

}
