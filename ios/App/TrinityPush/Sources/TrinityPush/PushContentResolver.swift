import Foundation

public enum PushResolution: Equatable {
    /// The account is not in the store: show the gateway's alert as delivered.
    case unchanged
    case rendered(RenderedNotification, sound: Bool)
}

/// Turns a gateway push into the notification to show. Never refreshes a token: an expired
/// one reads as a failed fetch and the room-name fallback.
public struct PushContentResolver {
    private let store: HandoffReading
    private let api: MatrixPushAPI
    private let budget: TimeInterval

    public init(store: HandoffReading, api: MatrixPushAPI, budget: TimeInterval = 5) {
        self.store = store
        self.api = api
        self.budget = budget
    }

    /// What to show if time runs out: the stored room name (else "Trinity") and "New message".
    /// Nil for an account the store does not know.
    public func fallback(for payload: PushPayload) -> RenderedNotification? {
        guard store.account(payload.accountId) != nil else { return nil }
        let title = PushRenderRules.nonBlank(store.room(payload.accountId, payload.roomId)?.name)
            ?? PushRenderRules.fallbackTitle
        return RenderedNotification(title: title, subtitle: "", body: PushRenderRules.fallbackBody)
    }

    /// One deadline covers every read of the push.
    public func resolve(_ payload: PushPayload) async -> PushResolution {
        guard let account = store.account(payload.accountId) else { return .unchanged }
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
