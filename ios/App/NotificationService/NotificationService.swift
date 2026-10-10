import Foundation
import TrinityPush
import UserNotifications

/// Rewrites Trinity's device-render pushes (`mutable-content: 1`) with the room name, the
/// sender and the message text, read through the push handoff store the app keeps. It edits a
/// copy of the delivered content, so the gateway's badge and `trinity_user_id` (which
/// `PushHandoff.clearRoom` matches on) stay. Logs nothing.
final class NotificationService: UNNotificationServiceExtension {
    private let delivery = Delivery()

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
        delivery.begin(content, handler: contentHandler)
        let delivery = self.delivery
        Task {
            if case let .rendered(rendered, sound) = await resolver.resolve(payload) {
                delivery.update { content in
                    Self.apply(rendered, threadIdentifier: payload.roomId, to: content)
                    content.sound = sound ? .default : nil
                }
            }
            delivery.finish()
        }
    }

    /// Delivers whatever is ready: the rendered text, or the room-name fallback.
    override func serviceExtensionTimeWillExpire() {
        delivery.finish()
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

/// Hands the content to the system exactly once: when rendering finishes or time runs out.
private final class Delivery: @unchecked Sendable {
    private let lock = NSLock()
    private var content: UNMutableNotificationContent?
    private var handler: ((UNNotificationContent) -> Void)?

    func begin(_ content: UNMutableNotificationContent, handler: @escaping (UNNotificationContent) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        self.content = content
        self.handler = handler
    }

    func update(_ change: (UNMutableNotificationContent) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        if let content { change(content) }
    }

    func finish() {
        lock.lock()
        let content = self.content
        let handler = self.handler
        self.content = nil
        self.handler = nil
        lock.unlock()
        if let content, let handler { handler(content) }
    }
}
