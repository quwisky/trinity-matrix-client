import Foundation
import TrinityPush
import UserNotifications

/// Rewrites Trinity's device-render pushes (`mutable-content: 1`) with the room name, the
/// sender and the message text, read through the push handoff store the app keeps. It edits a
/// copy of the delivered content, so the gateway's badge and `trinity_user_id` (which
/// `PushHandoff.clearRoom` matches on) stay. Each request has its own delivery, since iOS may
/// hand one instance overlapping requests. Logs nothing.
final class NotificationService: UNNotificationServiceExtension {
    private let deliveries = PushDeliveries<UNMutableNotificationContent>()

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        let store = PushHandoffStore.fromMainBundle()
        // App lock's Notification text is read again just before iOS gets the content, on time
        // or when time runs out, so a change made meanwhile still applies.
        let present: (UNMutableNotificationContent) -> Void = { content in
            PushRenderRules.present(NotificationTextMode.mirrored(by: store), on: content)
            contentHandler(content)
        }
        // Always hide: no fallback (it names the room) and no fetch at all.
        guard NotificationTextMode.mirrored(by: store) != .alwaysHide,
              let render = PushRender(userInfo: request.content.userInfo, store: store, api: URLSessionMatrixPushAPI())
        else {
            // Or an unknown or removed account, or another kind of push: the gateway's alert,
            // which carries no message text.
            present(content)
            return
        }
        Self.apply(render.fallback, to: content)
        let delivery = deliveries.begin(content, handler: present)
        delivery.track(Task {
            let rendered = await render.resolve()
            delivery.update { Self.apply(rendered, to: $0) }
            delivery.finish()
        })
    }

    /// Delivers whatever each pending request has ready: its rendered text, or its room-name
    /// fallback.
    override func serviceExtensionTimeWillExpire() {
        deliveries.finishAll()
    }

    private static func apply(_ rendered: PushNotificationContent, to content: UNMutableNotificationContent) {
        content.title = rendered.title
        content.subtitle = rendered.subtitle
        content.body = rendered.body
        content.threadIdentifier = rendered.threadIdentifier
        content.sound = rendered.sound ? .default : nil
    }
}

extension UNMutableNotificationContent: @retroactive PushTextContent {}
