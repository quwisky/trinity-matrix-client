import Foundation

/// One delivered notification as `PushHandoff` sees it when it removes some.
public struct DeliveredPush: Equatable {
    public let identifier: String
    public let threadIdentifier: String
    /// The gateway's `trinity_user_id`, which the extension keeps in the content's userInfo.
    public let accountId: String?
    /// Whether a push delivered it (`UNPushNotificationTrigger`), not the running app.
    public let fromPush: Bool

    public init(identifier: String, threadIdentifier: String, accountId: String?, fromPush: Bool) {
        self.identifier = identifier
        self.threadIdentifier = threadIdentifier
        self.accountId = accountId
        self.fromPush = fromPush
    }
}

public enum DeliveredPushes {
    /// Identifiers of the delivered notifications for one account's room. Trinity's pushes
    /// carry the room as `threadIdentifier` (the extension sets it; the gateway sends it as
    /// `thread-id` too) and the account as `trinity_user_id`; a notification without that tag
    /// matches on the room alone.
    public static func identifiers(in delivered: [DeliveredPush], accountId: String, roomId: String) -> [String] {
        delivered
            .filter { $0.threadIdentifier == roomId && ($0.accountId == nil || $0.accountId == accountId) }
            .map(\.identifier)
    }

    /// Identifiers of the delivered pushes for one account that signed out: they carry its
    /// message text. Only pushes carry `trinity_user_id`, so the app's own notifications stay.
    public static func identifiers(in delivered: [DeliveredPush], accountId: String) -> [String] {
        delivered.filter { $0.accountId == accountId }.map(\.identifier)
    }

    /// Identifiers of every delivered push, for clear-all-data. The app's own notifications stay.
    public static func pushIdentifiers(in delivered: [DeliveredPush]) -> [String] {
        delivered.filter(\.fromPush).map(\.identifier)
    }
}
