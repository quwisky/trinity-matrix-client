import AuthenticationServices
import Capacitor
import UIKit

/**
 * Opens a sign-in page in an ASWebAuthenticationSession for the web layer (startAuthSession in
 * @trinity/capacitor-auth-session). The session hands the redirect to `callbackScheme` back to
 * this call, not to whichever app registered that scheme. It is ephemeral, as the Safari View
 * Controller is: no cookies shared with Safari, and no system prompt before it opens.
 *
 * `cap sync` registers this class from the @trinity/capacitor-auth-session package, so it is a
 * public CAPPlugin: Capacitor's automatic registration skips CAPInstancePlugin subclasses.
 */
@objc(AuthSessionPlugin)
public class AuthSessionPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "AuthSessionPlugin"
    public let jsName = "TrinityAuthSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise)
    ]
    private var session: ASWebAuthenticationSession?
    // A cancelled session completes after its replacement started; only the latest clears it.
    private var generation = 0

    @objc func start(_ call: CAPPluginCall) {
        // ASWebAuthenticationSession raises an exception for any URL that is not http(s).
        guard let url = call.getString("url").flatMap(URL.init(string:)),
              url.scheme == "https" || url.scheme == "http",
              let scheme = call.getString("callbackScheme"), !scheme.isEmpty
        else {
            call.reject("Must provide an http(s) url and a callback scheme", "invalid")
            return
        }
        DispatchQueue.main.async {
            self.session?.cancel()
            self.generation += 1
            let current = self.generation
            let complete: ASWebAuthenticationSession.CompletionHandler = { callbackURL, error in
                DispatchQueue.main.async {
                    if self.generation == current { self.session = nil }
                }
                if let callbackURL {
                    call.resolve(["url": callbackURL.absoluteString])
                } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                    call.reject("The session was cancelled", "cancelled")
                } else {
                    call.reject("The session failed", "failed")
                }
            }
            let session: ASWebAuthenticationSession
            if #available(iOS 17.4, *) {
                session = ASWebAuthenticationSession(url: url, callback: .customScheme(scheme), completionHandler: complete)
            } else {
                session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme, completionHandler: complete)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.session = session
            if !session.start() {
                self.session = nil
                call.reject("The session could not start", "failed")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
