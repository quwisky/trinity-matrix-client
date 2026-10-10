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
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent,
              let payload = PushPayload(userInfo: request.content.userInfo),
              let store = PushHandoffStore.fromMainBundle()
        else {
            contentHandler(request.content)
            return
        }
        let resolver = PushContentResolver(store: store, api: URLSessionMatrixPushAPI())
        // An unknown or removed account keeps the gateway's "Trinity" / "New message".
        guard let fallback = resolver.fallback(for: payload) else {
            contentHandler(request.content)
            return
        }
        Self.apply(fallback, threadIdentifier: payload.roomId, to: content)
        content.sound = store.account(payload.accountId)?.sound == false ? nil : .default
        let delivery = deliveries.begin(content, handler: contentHandler)
        delivery.track(Task {
            if case let .rendered(rendered, sound) = await resolver.resolve(payload) {
                delivery.update { content in
                    Self.apply(rendered, threadIdentifier: payload.roomId, to: content)
                    content.sound = sound ? .default : nil
                }
            }
            delivery.finish()
        })
    }

    /// Delivers whatever each pending request has ready: its rendered text, or its room-name
    /// fallback.
    override func serviceExtensionTimeWillExpire() {
        deliveries.finishAll()
    }

    private static func apply(
        _ rendered: RenderedNotification,
        threadIdentifier: String,
        to content: UNMutableNotificationContent
    ) {
        content.title = rendered.title
        content.subtitle = rendered.subtitle
        content.body = rendered.body
        content.threadIdentifier = threadIdentifier
    }
}

