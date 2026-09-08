import Capacitor
import FirebaseCore

@objc(TrinityPushRegistrationPlugin)
final class TrinityPushRegistrationPlugin: CAPInstancePlugin, CAPBridgedPlugin {
    let identifier = "TrinityPushRegistrationPlugin"
    let jsName = "TrinityPushRegistration"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise)
    ]

    private static let configurationError = "Push notifications are not configured for this iOS build"

    override func load() {
        super.load()
        TrinityPushRegistration.shared.configureMessaging()
    }

    @objc func register(_ call: CAPPluginCall) {
        guard TrinityPushRegistration.shared.isConfigured else {
            call.reject(Self.configurationError)
            return
        }
        TrinityPushRegistration.shared.register()
        call.resolve()
    }

    static func configureFirebaseIfAvailable() {
        guard FirebaseApp.app() == nil,
              let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
              let options = FirebaseOptions(contentsOfFile: path),
              !options.googleAppID.isEmpty,
              options.projectID?.isEmpty == false else { return }
        FirebaseApp.configure(options: options)
        TrinityPushRegistration.shared.configureMessaging()
    }

    static func didRegisterForRemoteNotifications(_ deviceToken: Data) {
        DispatchQueue.main.async {
            guard FirebaseApp.app() != nil else { return }
            TrinityPushRegistration.shared.setAPNsToken(deviceToken)
        }
    }
}
