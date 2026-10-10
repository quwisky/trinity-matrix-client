import Foundation

/// The gateway's data keys for a push about one event (top level of the APNs payload).
public struct PushPayload: Equatable {
    public let accountId: String
    public let roomId: String
    public let eventId: String

    /// Nil unless the push names an account, a room and an event.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let accountId = userInfo["trinity_user_id"] as? String,
              let roomId = userInfo["room_id"] as? String,
              let eventId = userInfo["event_id"] as? String
        else { return nil }
        self.accountId = accountId
        self.roomId = roomId
        self.eventId = eventId
    }
}
