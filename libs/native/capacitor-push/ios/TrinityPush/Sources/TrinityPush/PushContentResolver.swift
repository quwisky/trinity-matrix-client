import Foundation

public enum PushResolution: Equatable {
    /// The account is not in the store: show the gateway's alert as delivered.
    case unchanged
    case rendered(RenderedNotification, sound: Bool)
}

/// Turns a gateway push into the notification to show. Never refreshes a token. A token the
/// store marks expired is not sent at all, because only the app can renew it: the push shows
/// the room name with the expired-token text. Any other failed read shows "New message".
public struct PushContentResolver {
    private let store: HandoffReading
    private let api: MatrixPushAPI
    private let budget: TimeInterval
    private let now: () -> Date

    public init(
        store: HandoffReading,
        api: MatrixPushAPI,
        budget: TimeInterval = 5,
        now: @escaping () -> Date = Date.init
    ) {
        self.store = store
        self.api = api
        self.budget = budget
        self.now = now
    }

    /// What to show if time runs out: the stored room name (else "Trinity") with "New
    /// message", or with the expired-token text when the stored token has expired. Nil for an
    /// account the store does not know.
    public func fallback(for payload: PushPayload) -> RenderedNotification? {
        guard let account = store.account(payload.accountId) else { return nil }
        return PushRenderRules.render(
            event: nil,
            storedRoom: store.room(payload.accountId, payload.roomId),
            stateRoomName: nil,
            senderName: nil,
            tokenExpired: account.tokenExpired(at: now())
        )
    }

    /// One deadline covers every read of the push; an expired token makes no read.
    public func resolve(_ payload: PushPayload) async -> PushResolution {
        guard let account = store.account(payload.accountId) else { return .unchanged }
        if account.tokenExpired(at: now()) {
            let expired = PushRenderRules.render(
                event: nil,
                storedRoom: store.room(payload.accountId, payload.roomId),
                stateRoomName: nil,
                senderName: nil,
                tokenExpired: true
            )
            return .rendered(expired, sound: account.sound)
        }
        let deadline = Date().addingTimeInterval(budget)
        let event = await api.event(account: account, roomId: payload.roomId, eventId: payload.eventId, deadline: deadline)
        let storedRoom = store.room(payload.accountId, payload.roomId)
        var stateRoomName: String?
        if storedRoom == nil {
            stateRoomName = await api.roomName(account: account, roomId: payload.roomId, deadline: deadline)
        }
        var senderName: String?
        if let sender = event?["sender"] as? String {
            senderName = await api.memberDisplayName(account: account, roomId: payload.roomId, userId: sender, deadline: deadline)
        }
        let rendered = PushRenderRules.render(
            event: event,
            storedRoom: storedRoom,
            stateRoomName: stateRoomName,
            senderName: senderName
        )
        return .rendered(rendered, sound: account.sound)
    }
}
