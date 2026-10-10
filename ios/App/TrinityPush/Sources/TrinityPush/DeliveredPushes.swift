import Foundation

/// One delivered notification as `PushHandoff.clearRoom` sees it.
public struct DeliveredPush: Equatable {
    public let identifier: String
    public let threadIdentifier: String
    /// The gateway's `trinity_user_id`, which the extension keeps in the content's userInfo.
    public let accountId: String?

    public init(identifier: String, threadIdentifier: String, accountId: String?) {
        self.identifier = identifier
        self.threadIdentifier = threadIdentifier
        self.accountId = accountId
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
}
