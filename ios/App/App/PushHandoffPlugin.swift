import Capacitor
import TrinityPush
import UserNotifications

/**
 * Writes the push handoff store the NotificationService extension reads: each account's
 * homeserver, access token and sound choice, and its room names. PushHandoffService in
 * data-access/notifications is the only caller. Never logs what it stores.
 *
 * Without a store (a build lacking the app group), removing and clearing resolve, since there
 * is nothing to remove, so sign-out and clear-all-data never wait on it; writes reject.
 */
@objc(PushHandoffPlugin)
class PushHandoffPlugin: CAPInstancePlugin, CAPBridgedPlugin {
    let identifier = "PushHandoffPlugin"
    let jsName = "PushHandoff"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setAccount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRooms", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeAccount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearRoom", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registrationAvailable", returnType: CAPPluginReturnPromise),
    ]
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
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { notifications in
            let delivered = notifications.map {
                DeliveredPush(
                    identifier: $0.request.identifier,
                    threadIdentifier: $0.request.content.threadIdentifier,
                    accountId: $0.request.content.userInfo["trinity_user_id"] as? String
                )
            }
            let identifiers = DeliveredPushes.identifiers(in: delivered, accountId: userId, roomId: roomId)
            if !identifiers.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: identifiers)
            }
            call.resolve()
        }
    }

    /// iOS can always ask for a token: AppDelegate reports the FCM token when Firebase is
    /// configured and the APNs token otherwise, and neither path can crash the app.
    @objc func registrationAvailable(_ call: CAPPluginCall) {
        call.resolve(["value": true])
    }
}
