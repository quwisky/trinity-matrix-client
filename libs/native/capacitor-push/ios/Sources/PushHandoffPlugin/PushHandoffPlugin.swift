import Capacitor
import TrinityPush
import UIKit
import UserNotifications

/**
 * Writes the push handoff store the NotificationService extension reads: each account's
 * homeserver, sound choice and, for a password account, access token (with its expiry, when it
 * has one), and its room names; an OAuth account's token lives in the token vault.
 * PushHandoffService in data-access/notifications is the only caller of those (debug
 * builds add renderProbe for the e2e suite), and it also holds background run time through it
 * while a token refresh reaches the store. Also exposes the native token refresher, whose calls
 * answer the access token and expiry only: the refresh token never crosses back to the app.
 * Never logs what it stores.
 *
 * Without a store (a build lacking the app group), removing and clearing resolve, since there
 * is nothing to remove, so sign-out and clear-all-data never wait on it; writes reject, and the
 * token calls answer as though no refresher could run. Removing an account also removes its
 * delivered pushes, and clearing removes every delivered push, so no message text outlives a
 * sign-out; that removal never rejects.
 *
 * `cap sync` registers this class from the @trinity/capacitor-push package, so it is a public
 * CAPPlugin: Capacitor's automatic registration skips CAPInstancePlugin subclasses.
 */
@objc(PushHandoffPlugin)
public class PushHandoffPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PushHandoffPlugin"
    public let jsName = "PushHandoff"
    public let pluginMethods: [CAPPluginMethod] = {
        var methods: [CAPPluginMethod] = [
            CAPPluginMethod(name: "setAccount", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "setRooms", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "removeAccount", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "clearRoom", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "registrationAvailable", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "beginBackgroundWork", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "endBackgroundWork", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "setNotificationText", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "clearDelivered", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "refreshTokens", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "currentTokens", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "migrateTokens", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "revokeTokens", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "removeTokens", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "removeTokensExcept", returnType: CAPPluginReturnPromise),
        ]
        #if DEBUG
        methods.append(CAPPluginMethod(name: "renderProbe", returnType: CAPPluginReturnPromise))
        #endif
        return methods
    }()
    /// How long after iOS announces that protected data will become unavailable the device
    /// counts as locking: iOS discards the key for data protected until the device locks
    /// about 10 s after the lock.
    private static let lockingWindow: TimeInterval = 10
    private let store = PushHandoffStore.fromMainBundle()
    private let tokens = TokenRefresher.fromMainBundle()
    /// Background tasks begun and not yet ended. Main thread only.
    private var backgroundTasks = Set<UIBackgroundTaskIdentifier>()
    /// System uptime when iOS last announced that protected data will become unavailable, until
    /// it is available again. Main thread only.
    private var protectedDataLockingSince: TimeInterval?
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(
                forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.protectedDataLockingSince = ProcessInfo.processInfo.systemUptime
            },
            center.addObserver(
                forName: UIApplication.protectedDataDidBecomeAvailableNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.protectedDataLockingSince = nil
            },
        ]
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    @objc func setAccount(_ call: CAPPluginCall) {
        guard let store else {
            call.reject("Push handoff storage is unavailable")
            return
        }
        guard let userId = call.getString("userId"),
              let homeserverUrl = call.getString("homeserverUrl"),
              let sound = call.getBool("sound")
        else {
            call.reject("Must provide userId, homeserverUrl and sound")
            return
        }
        // Absent for an account whose token lives in the token vault.
        let accessToken = call.getString("accessToken") ?? ""
        // Epoch milliseconds from the app; absent for a token that does not expire on a schedule.
        let expiresAt = HandoffAccount.expiry(fromEpochMilliseconds: call.getValue("accessTokenExpiresAt"))
        do {
            try store.setAccount(
                HandoffAccount(
                    homeserverUrl: homeserverUrl,
                    accessToken: accessToken,
                    sound: sound,
                    accessTokenExpiresAt: expiresAt
                ),
                for: userId
            )
            call.resolve()
        } catch {
            call.reject("Could not store the push account")
        }
    }

    @objc func setRooms(_ call: CAPPluginCall) {
        guard let store else {
            call.reject("Push handoff storage is unavailable")
            return
        }
        guard let userId = call.getString("userId"), let rooms = call.getArray("rooms", JSObject.self) else {
            call.reject("Must provide userId and rooms")
            return
        }
        var parsed: [String: HandoffRoom] = [:]
        for room in rooms {
            guard let roomId = room["roomId"] as? String,
                  let name = room["name"] as? String,
                  let direct = room["direct"] as? Bool
            else {
                call.reject("Rooms must carry roomId, name and direct")
                return
            }
            // A room the app sent without the flag counts as encrypted.
            parsed[roomId] = HandoffRoom(name: name, direct: direct, encrypted: room["encrypted"] as? Bool ?? true)
        }
        do {
            try store.mergeRooms(parsed, for: userId)
            call.resolve()
        } catch {
            call.reject("Could not store the push rooms")
        }
    }

    @objc func removeAccount(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId") else {
            call.reject("Must provide userId")
            return
        }
        removeDelivered { DeliveredPushes.identifiers(in: $0, accountId: userId) }
        guard let store else {
            call.resolve()
            return
        }
        do {
            try store.removeAccount(userId)
            call.resolve()
        } catch {
            call.reject("Could not remove the push account")
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        removeDelivered { DeliveredPushes.pushIdentifiers(in: $0) }
        guard let store else {
            call.resolve()
            return
        }
        do {
            try store.clear()
            call.resolve()
        } catch {
            call.reject("Could not clear the push handoff")
        }
    }

    /// App lock's effective Notification text, for the NotificationService extension.
    @objc func setNotificationText(_ call: CAPPluginCall) {
        guard let raw = call.getString("mode"), let mode = NotificationTextMode(rawValue: raw) else {
            call.reject("Must provide a known mode")
            return
        }
        guard let store else {
            call.reject("Push handoff storage is unavailable")
            return
        }
        do {
            try store.setNotificationText(mode)
            call.resolve()
        } catch {
            call.reject("Could not store the notification text")
        }
    }

    /// The text became more private: take down every notification Trinity delivered, pushes
    /// and the running app's own alike, so no earlier text stays in Notification Center.
    @objc func clearDelivered(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        call.resolve()
    }

    /// The room was opened: remove that account's delivered notifications for it.
    @objc func clearRoom(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"), let roomId = call.getString("roomId") else {
            call.reject("Must provide userId and roomId")
            return
        }
        removeDelivered({ DeliveredPushes.identifiers(in: $0, accountId: userId, roomId: roomId) }) {
            call.resolve()
        }
    }

    /// Remove the delivered notifications `select` picks, then run `completion`. Best effort:
    /// the notification center reports no failure, so neither does this.
    private func removeDelivered(
        _ select: @escaping ([DeliveredPush]) -> [String],
        completion: (() -> Void)? = nil
    ) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { notifications in
            let delivered = notifications.map {
                DeliveredPush(
                    identifier: $0.request.identifier,
                    threadIdentifier: $0.request.content.threadIdentifier,
                    accountId: $0.request.content.userInfo["trinity_user_id"] as? String,
                    fromPush: $0.request.trigger is UNPushNotificationTrigger
                )
            }
            let identifiers = select(delivered)
            if !identifiers.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: identifiers)
            }
            completion?()
        }
    }

    /// iOS can always ask for a token: AppDelegate reports the FCM token when Firebase is
    /// configured and the APNs token otherwise, and neither path can crash the app.
    @objc func registrationAvailable(_ call: CAPPluginCall) {
        call.resolve(["value": true])
    }

    /// Ask iOS for background run time, so a token refresh begun as the app leaves can reach
    /// the store before the app is suspended. Resolves the task's identifier for
    /// endBackgroundWork; when iOS ends the granted time first, the task ends itself. Also
    /// resolves whether protected data, which holds the session's tokens, is available now and
    /// whether the device is locking (iOS announced within lockingWindow that it will become
    /// unavailable), so the app starts no refresh it could not save. Both are read on the main
    /// thread, after every notification delivered before this call ran.
    @objc func beginBackgroundWork(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let task = self.beginBackgroundTask()
            let locking = self.protectedDataLockingSince.map {
                ProcessInfo.processInfo.systemUptime - $0 < Self.lockingWindow
            } ?? false
            call.resolve([
                "id": task.rawValue,
                "protectedDataAvailable": UIApplication.shared.isProtectedDataAvailable,
                "locking": locking,
            ])
        }
    }

    /// End background run time that beginBackgroundWork began. An unknown or already ended
    /// identifier is a no-op.
    @objc func endBackgroundWork(_ call: CAPPluginCall) {
        guard let id = call.getInt("id") else {
            call.reject("Must provide id")
            return
        }
        DispatchQueue.main.async {
            self.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: id))
            call.resolve()
        }
    }

    /// Main thread only. iOS ending the granted time ends the task.
    private func beginBackgroundTask() -> UIBackgroundTaskIdentifier {
        var task = UIBackgroundTaskIdentifier.invalid
        task = UIApplication.shared.beginBackgroundTask(withName: "Trinity token refresh") {
            self.endBackgroundTask(task)
        }
        if task != .invalid {
            backgroundTasks.insert(task)
        }
        return task
    }

    /// Main thread only. Ends `task` once, whether the app or iOS asks first.
    private func endBackgroundTask(_ task: UIBackgroundTaskIdentifier) {
        guard backgroundTasks.remove(task) != nil else { return }
        UIApplication.shared.endBackgroundTask(task)
    }

    /// `resolve` queues its delivery to JS on the main queue: suspending before that runs would
    /// hold the answer until the app resumes.
    private func endBackgroundTaskAfterQueuedWork(_ task: UIBackgroundTaskIdentifier) {
        DispatchQueue.main.async { self.endBackgroundTask(task) }
    }

    /// Holds background run time until it answers or iOS ends the granted time: suspended
    /// mid-grant, the app loses the answer after the provider has spent the refresh token.
    @objc func refreshTokens(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"), let lineage = call.getString("lineage"),
              let tokenSeen = call.getString("tokenSeen")
        else {
            call.reject("Must provide userId, lineage and tokenSeen")
            return
        }
        guard let tokens else {
            call.resolve(TokenRefreshResult.unavailable.wire)
            return
        }
        Task { @MainActor in
            let task = self.beginBackgroundTask()
            guard TokenRefresher.mayStartAppGrant(
                hasBackgroundTime: task != .invalid,
                appIsActive: UIApplication.shared.applicationState == .active
            ) else {
                call.resolve(TokenRefreshResult.transient.wire)
                return
            }
            let result = await tokens.refresh(
                account: userId, lineage: lineage, tokenSeen: tokenSeen, budget: TokenBudgets.appGrant)
            call.resolve(result.wire)
            self.endBackgroundTaskAfterQueuedWork(task)
        }
    }

    @objc func currentTokens(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"), let lineage = call.getString("lineage") else {
            call.reject("Must provide userId and lineage")
            return
        }
        guard let tokens else {
            call.resolve(TokenRefreshResult.unavailable.wire)
            return
        }
        Task { call.resolve(await tokens.current(account: userId, lineage: lineage).wire) }
    }

    @objc func migrateTokens(_ call: CAPPluginCall) {
        guard let (userId, record) = TokenRecord.fromPluginCall(call.jsObjectRepresentation) else {
            call.reject("Must provide userId, lineage, accessToken, refreshToken, tokenEndpoint, clientId and deviceId")
            return
        }
        guard let tokens else {
            call.resolve(["stored": false])
            return
        }
        Task { call.resolve(["stored": await tokens.migrate(record, for: userId)]) }
    }

    @objc func revokeTokens(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"), let lineage = call.getString("lineage") else {
            call.reject("Must provide userId and lineage")
            return
        }
        guard let tokens else {
            call.resolve(TokenRevokeResult.gone.wire)
            return
        }
        Task { call.resolve(await tokens.revoke(account: userId, lineage: lineage).wire) }
    }

    @objc func removeTokens(_ call: CAPPluginCall) {
        guard let options = call.options as? [String: Any], let removal = TokenRemoval.fromPluginCall(options) else {
            call.reject("Must provide a userId or all: true")
            return
        }
        guard let tokens else {
            call.resolve()
            return
        }
        Task {
            if await tokens.remove(account: removal.account) {
                call.resolve()
            } else {
                call.reject("Could not remove the tokens")
            }
        }
    }

    @objc func removeTokensExcept(_ call: CAPPluginCall) {
        guard let options = call.options as? [String: Any],
              let keeping = TokenRemoval.keptUserIds(fromPluginCall: options)
        else {
            call.reject("Must provide userIds as a list of user ids")
            return
        }
        guard let tokens else {
            call.resolve(["removed": 0])
            return
        }
        Task {
            if let removed = await tokens.remove(except: keeping) {
                call.resolve(["removed": removed])
            } else {
                call.reject("Could not remove the tokens")
            }
        }
    }

    #if DEBUG
    /// Debug builds only, for the installed-app e2e suite: renders `payload`, shaped like the
    /// gateway's APNs push, through the NotificationService extension's path (PushRender over
    /// this store and URLSessionMatrixPushAPI) and resolves what it would show. The Simulator
    /// does not run the extension for `xcrun simctl push`, so the suite calls this instead.
    /// A push the extension leaves alone resolves the gateway's own alert.
    @objc func renderProbe(_ call: CAPPluginCall) {
        guard let payload = call.getObject("payload") else {
            call.reject("Must provide payload")
            return
        }
        let userInfo: [AnyHashable: Any] = payload
        let resolve = { [store] (probe: ProbeContent) in
            PushRenderRules.present(NotificationTextMode.mirrored(by: store), on: probe)
            call.resolve(probe.result)
        }
        guard PushRenderRules.rendersMessage(store: store),
              let render = PushRender(userInfo: userInfo, store: store, api: URLSessionMatrixPushAPI(), tokens: tokens)
        else {
            let aps = payload["aps"] as? JSObject
            let alert = aps?["alert"] as? JSObject
            resolve(ProbeContent(
                title: alert?["title"] as? String ?? "",
                subtitle: alert?["subtitle"] as? String ?? "",
                body: alert?["body"] as? String ?? "",
                threadIdentifier: aps?["thread-id"] as? String ?? "",
                sound: aps?["sound"] != nil
            ))
            return
        }
        Task {
            let content = await render.resolve()
            resolve(ProbeContent(
                title: content.title,
                subtitle: content.subtitle,
                body: content.body,
                threadIdentifier: content.threadIdentifier,
                sound: content.sound
            ))
        }
    }
    #endif
}

#if DEBUG
/// What the render probe answers, after the same presentation step as the extension.
private final class ProbeContent: PushTextContent {
    var title: String
    var subtitle: String
    var body: String
    var categoryIdentifier = ""
    let threadIdentifier: String
    let sound: Bool

    init(title: String, subtitle: String, body: String, threadIdentifier: String, sound: Bool) {
        self.title = title
        self.subtitle = subtitle
        self.body = body
        self.threadIdentifier = threadIdentifier
        self.sound = sound
    }

    var result: [String: Any] {
        [
            "title": title,
            "subtitle": subtitle,
            "body": body,
            "threadIdentifier": threadIdentifier,
            "sound": sound,
            "categoryIdentifier": categoryIdentifier,
        ]
    }
}
#endif
