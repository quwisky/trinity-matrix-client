import Capacitor
import TrinityPush
import UserNotifications

/**
 * Writes the push handoff store the NotificationService extension reads: each account's
 * homeserver, access token and sound choice, and its room names. PushHandoffService in
 * data-access/notifications is the only caller (debug builds add renderProbe for the e2e
 * suite). Never logs what it stores.
 *
 * Without a store (a build lacking the app group), removing and clearing resolve, since there
 * is nothing to remove, so sign-out and clear-all-data never wait on it; writes reject.
 * Removing an account also removes its delivered pushes, and clearing removes every delivered
 * push, so no message text outlives a sign-out; that removal never rejects.
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
        ]
        #if DEBUG
        methods.append(CAPPluginMethod(name: "renderProbe", returnType: CAPPluginReturnPromise))
        #endif
        return methods
    }()
    private let store = PushHandoffStore.fromMainBundle()

    @objc func setAccount(_ call: CAPPluginCall) {
        guard let store else {
            call.reject("Push handoff storage is unavailable")
            return
        }
        guard let userId = call.getString("userId"),
              let homeserverUrl = call.getString("homeserverUrl"),
              let accessToken = call.getString("accessToken"),
              let sound = call.getBool("sound")
        else {
            call.reject("Must provide userId, homeserverUrl, accessToken and sound")
            return
        }
        do {
            try store.setAccount(
                HandoffAccount(homeserverUrl: homeserverUrl, accessToken: accessToken, sound: sound),
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
            parsed[roomId] = HandoffRoom(name: name, direct: direct)
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
        guard let render = PushRender(userInfo: userInfo, store: store, api: URLSessionMatrixPushAPI()) else {
            let aps = payload["aps"] as? JSObject
            let alert = aps?["alert"] as? JSObject
            call.resolve([
                "title": alert?["title"] as? String ?? "",
                "subtitle": alert?["subtitle"] as? String ?? "",
                "body": alert?["body"] as? String ?? "",
                "threadIdentifier": aps?["thread-id"] as? String ?? "",
                "sound": aps?["sound"] != nil,
            ])
            return
        }
        Task {
            let content = await render.resolve()
            call.resolve([
                "title": content.title,
                "subtitle": content.subtitle,
                "body": content.body,
                "threadIdentifier": content.threadIdentifier,
                "sound": content.sound,
            ])
        }
    }
    #endif
}
