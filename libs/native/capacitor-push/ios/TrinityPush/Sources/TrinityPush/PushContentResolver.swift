import Foundation

public enum PushResolution: Equatable {
    /// The account is not in the store: show the gateway's alert as delivered.
    case unchanged
    case rendered(RenderedNotification, sound: Bool)
}

/// Turns a gateway push into the notification to show. A token the store marks expired is not
/// sent: it is refreshed first, and a 401 refreshes once too. The push shows the room name with
/// the expired-token text when an expired token could not be refreshed. Any other failed read
/// shows "New message". Worst case 5 s + 15 s + 3 s grace + 1 s retake + 5 s, inside the
/// extension's 30 s, and the extension's fallback still covers running out of it.
public struct PushContentResolver {
    private let store: HandoffReading
    private let api: MatrixPushAPI
    private let tokens: PushTokenRefreshing?
    private let budget: TimeInterval
    private let refreshBudget: TimeInterval
    private let now: () -> Date

    public init(
        store: HandoffReading,
        api: MatrixPushAPI,
        tokens: PushTokenRefreshing? = nil,
        budget: TimeInterval = 5,
        refreshBudget: TimeInterval = TokenBudgets.serviceRefresh,
        now: @escaping () -> Date = Date.init
    ) {
        self.store = store
        self.api = api
        self.tokens = tokens
        self.budget = budget
        self.refreshBudget = refreshBudget
        self.now = now
    }

    /// What to show if time runs out: the stored room name (else "Trinity") with "New
    /// message", or with the expired-token text when the stored token has expired. Nil for an
    /// account the store does not know.
    public func fallback(for payload: PushPayload) -> RenderedNotification? {
        guard let account = store.account(payload.accountId) else { return nil }
        return fallback(for: payload, tokenExpired: account.tokenExpired(at: now()))
    }

    /// Only an account with a handoff entry can refresh: a vault record may outlive sign-out while
    /// its revocation is pending. One deadline covers every read made with the same token.
    public func resolve(_ payload: PushPayload) async -> PushResolution {
        guard var account = store.account(payload.accountId) else { return .unchanged }
        let expired = account.tokenExpired(at: now())
        if expired {
            guard let renewed = await refreshed(account, payload) else {
                return .rendered(fallback(for: payload, tokenExpired: true), sound: account.sound)
            }
            account = renewed
        }
        var deadline = Date().addingTimeInterval(budget)
        var read = await api.event(account: account, roomId: payload.roomId, eventId: payload.eventId, deadline: deadline)
        if case .unauthorized = read, !expired {
            guard let renewed = await refreshed(account, payload) else {
                return .rendered(fallback(for: payload, tokenExpired: false), sound: account.sound)
            }
            account = renewed
            deadline = Date().addingTimeInterval(budget)
            read = await api.event(account: account, roomId: payload.roomId, eventId: payload.eventId, deadline: deadline)
        }
        var event: [String: Any]?
        if case .event(let object) = read { event = object }
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

    /// The account with a usable token; nil for every other answer, which shows the fallback.
    private func refreshed(_ account: HandoffAccount, _ payload: PushPayload) async -> HandoffAccount? {
        let answer = await tokens?.refreshForPush(
            account: payload.accountId, tokenSeen: account.accessToken, budget: refreshBudget)
        switch answer {
        case .current(let record), .rotated(let record, _): return account.with(record: record)
        default: return nil
        }
    }

    /// The notification from what the store holds alone, without reading anything.
    private func fallback(for payload: PushPayload, tokenExpired: Bool) -> RenderedNotification {
        PushRenderRules.render(
            event: nil,
            storedRoom: store.room(payload.accountId, payload.roomId),
            stateRoomName: nil,
            senderName: nil,
            tokenExpired: tokenExpired
        )
    }
}
