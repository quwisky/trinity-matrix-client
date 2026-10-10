import Foundation

/// What a push shows: its text, the thread it groups under and whether it plays a sound.
public struct PushNotificationContent: Equatable {
    public let title: String
    public let subtitle: String
    public let body: String
    public let threadIdentifier: String
    public let sound: Bool

    public init(title: String, subtitle: String, body: String, threadIdentifier: String, sound: Bool) {
        self.title = title
        self.subtitle = subtitle
        self.body = body
        self.threadIdentifier = threadIdentifier
        self.sound = sound
    }

    init(_ rendered: RenderedNotification, threadIdentifier: String, sound: Bool) {
        self.init(
            title: rendered.title,
            subtitle: rendered.subtitle,
            body: rendered.body,
            threadIdentifier: threadIdentifier,
            sound: sound
        )
    }
}

/// The NotificationService extension's rendering of one push, kept free of UserNotifications
/// so the app's debug render probe runs the same path. The extension shows `fallback` at once
/// and replaces it with `resolve()` when that finishes in time.
public struct PushRender {
    /// What to show if time runs out: the stored room name (else "Trinity") and "New message".
    public let fallback: PushNotificationContent
    private let payload: PushPayload
    private let resolver: PushContentResolver

    /// Nil when the push does not name an account, a room and an event, when there is no
    /// store, or when the store does not know the account: the gateway's alert then shows as
    /// delivered.
    public init?(userInfo: [AnyHashable: Any], store: HandoffReading?, api: MatrixPushAPI) {
        guard let payload = PushPayload(userInfo: userInfo),
              let store,
              let account = store.account(payload.accountId)
        else { return nil }
        let resolver = PushContentResolver(store: store, api: api)
        guard let fallback = resolver.fallback(for: payload) else { return nil }
        self.fallback = PushNotificationContent(fallback, threadIdentifier: payload.roomId, sound: account.sound)
        self.payload = payload
        self.resolver = resolver
    }

    /// The rendered notification, within the resolver's one budget; the fallback if the
    /// account left the store meanwhile.
    public func resolve() async -> PushNotificationContent {
        guard case let .rendered(rendered, sound) = await resolver.resolve(payload) else { return fallback }
        return PushNotificationContent(rendered, threadIdentifier: payload.roomId, sound: sound)
    }
}
