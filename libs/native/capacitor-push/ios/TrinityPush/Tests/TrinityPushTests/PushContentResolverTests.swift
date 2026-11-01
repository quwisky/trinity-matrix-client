import Foundation
import XCTest
@testable import TrinityPush

private struct FakeStore: HandoffReading {
    var accounts: [String: HandoffAccount]
    var rooms: [String: [String: HandoffRoom]] = [:]
    func account(_ userId: String) -> HandoffAccount? { accounts[userId] }
    func room(_ userId: String, _ roomId: String) -> HandoffRoom? { rooms[userId]?[roomId] }
    /// The resolver doesn't read the mirror yet; the fake answers explicitly.
    func notificationText() -> NotificationTextMode { .show }
}

private final class FakeAPI: MatrixPushAPI, @unchecked Sendable {
    private let lock = NSLock()
    private var recordedAccounts: [HandoffAccount] = []
    private var recordedRoomNameDeadlines: [Date] = []
    private var recordedMemberDeadlines: [Date] = []
    private var recordedEventDeadlines: [Date] = []
    private var eventReads: [PushEventRead]
    let memberName: String?
    let roomName: String?
    var eventDelay: UInt64 = 0

    var accounts: [HandoffAccount] { lock.withLock { recordedAccounts } }
    var roomNameDeadlines: [Date] { lock.withLock { recordedRoomNameDeadlines } }
    var memberDeadlines: [Date] { lock.withLock { recordedMemberDeadlines } }
    var eventDeadlines: [Date] { lock.withLock { recordedEventDeadlines } }
    var eventCalls: Int { eventDeadlines.count }

    init(event: [String: Any]? = nil, memberName: String? = nil, roomName: String? = nil) {
        eventReads = [event.map { .event($0) } ?? .failed]
        self.memberName = memberName
        self.roomName = roomName
    }

    /// Answers each read in turn, then fails, so a resolver that keeps retrying still ends.
    init(eventReads: [PushEventRead], memberName: String? = nil) {
        self.eventReads = eventReads + [.failed]
        self.memberName = memberName
        roomName = nil
    }

    func event(account: HandoffAccount, roomId: String, eventId: String, deadline: Date) async -> PushEventRead {
        let read = lock.withLock { () -> PushEventRead in
            recordedAccounts.append(account)
            recordedEventDeadlines.append(deadline)
            return eventReads.count > 1 ? eventReads.removeFirst() : eventReads.first ?? .failed
        }
        if eventDelay > 0 { try? await Task.sleep(nanoseconds: eventDelay) }
        return read
    }

    func memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Date) async -> String? {
        lock.withLock {
            recordedAccounts.append(account)
            recordedMemberDeadlines.append(deadline)
        }
        return memberName
    }

    func roomName(account: HandoffAccount, roomId: String, deadline: Date) async -> String? {
        lock.withLock {
            recordedAccounts.append(account)
            recordedRoomNameDeadlines.append(deadline)
        }
        return roomName
    }
}

private final class FakeTokens: PushTokenRefreshing, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String] = []
    private var budgets: [TimeInterval] = []
    private let answer: TokenRefreshResult
    private let delay: Duration

    var tokensSeen: [String] { lock.withLock { seen } }
    var calls: Int { tokensSeen.count }
    var lastBudget: TimeInterval? { lock.withLock { budgets.last } }

    init(answer: TokenRefreshResult, delay: Duration = .zero) {
        self.answer = answer
        self.delay = delay
    }

    func refreshForPush(account: String, tokenSeen: String, budget: TimeInterval) async -> TokenRefreshResult {
        lock.withLock {
            seen.append(tokenSeen)
            budgets.append(budget)
        }
        try? await Task.sleep(for: delay)
        return answer
    }
}

final class PushContentResolverTests: XCTestCase {
    private let alice = HandoffAccount(homeserverUrl: "https://a.example", accessToken: "token-a", sound: true)
    private let bob = HandoffAccount(homeserverUrl: "https://b.example", accessToken: "token-b", sound: false)

    private func payload(user: String = "@alice:hs") -> PushPayload {
        PushPayload(userInfo: ["trinity_user_id": user, "room_id": "!r:hs", "event_id": "$e"])!
    }

    private func message(sender: String = "@carol:hs", body: String = "hello") -> [String: Any] {
        ["type": "m.room.message", "sender": sender, "content": ["msgtype": "m.text", "body": body]]
    }

    func testUnknownAccountLeavesTheGatewaysContentUnchanged() async {
        let api = FakeAPI(event: message())
        let resolver = PushContentResolver(store: FakeStore(accounts: [:]), api: api)

        let resolution = await resolver.resolve(payload())

        XCTAssertEqual(resolution, .unchanged)
        XCTAssertNil(resolver.fallback(for: payload()))
        XCTAssertTrue(api.accounts.isEmpty)
    }

    func testUnauthorizedFetchKeepsTheStoredRoomName() async {
        let store = FakeStore(accounts: ["@alice:hs": alice], rooms: ["@alice:hs": ["!r:hs": HandoffRoom(name: "Team", direct: false)]])
        let resolution = await PushContentResolver(store: store, api: FakeAPI(event: nil)).resolve(payload())

        XCTAssertEqual(resolution, .rendered(RenderedNotification(title: "Team", subtitle: "", body: "New message"), sound: true))
    }

    func testExpiredTokenShowsTheOpenTrinityTextWithoutAnyRead() async {
        let expired = HandoffAccount(
            homeserverUrl: "https://a.example",
            accessToken: "token-a",
            sound: true,
            accessTokenExpiresAt: Date(timeIntervalSince1970: 1_000)
        )
        let store = FakeStore(accounts: ["@alice:hs": expired], rooms: ["@alice:hs": ["!r:hs": HandoffRoom(name: "Team", direct: false)]])
        let api = FakeAPI(event: message(), memberName: "Carol", roomName: "Lobby")
        let resolver = PushContentResolver(store: store, api: api, now: { Date(timeIntervalSince1970: 1_000) })
        let expected = RenderedNotification(title: "Team", subtitle: "", body: "Open Trinity to read this message")

        let resolution = await resolver.resolve(payload())

        XCTAssertEqual(resolution, .rendered(expected, sound: true))
        XCTAssertEqual(resolver.fallback(for: payload()), expected)
        XCTAssertTrue(api.accounts.isEmpty)
    }

    func testExpiredTokenForARoomNotStoredReadsNoRoomState() async {
        let expired = HandoffAccount(
            homeserverUrl: "https://a.example",
            accessToken: "token-a",
            sound: false,
            accessTokenExpiresAt: Date(timeIntervalSince1970: 1_000)
        )
        let api = FakeAPI(event: message(), roomName: "Lobby")
        let resolver = PushContentResolver(store: FakeStore(accounts: ["@alice:hs": expired]), api: api, now: { Date(timeIntervalSince1970: 5_000) })

        let resolution = await resolver.resolve(payload())

        XCTAssertEqual(resolution, .rendered(RenderedNotification(title: "Trinity", subtitle: "", body: "Open Trinity to read this message"), sound: false))
        XCTAssertTrue(api.accounts.isEmpty)
    }

    func testATokenBeforeItsExpiryIsStillUsed() async {
        let fresh = HandoffAccount(
            homeserverUrl: "https://a.example",
            accessToken: "token-a",
            sound: true,
            accessTokenExpiresAt: Date(timeIntervalSince1970: 1_001)
        )
        let store = FakeStore(accounts: ["@alice:hs": fresh], rooms: ["@alice:hs": ["!r:hs": HandoffRoom(name: "Team", direct: false, encrypted: false)]])
        let api = FakeAPI(event: message(), memberName: "Carol")

        let resolution = await PushContentResolver(store: store, api: api, now: { Date(timeIntervalSince1970: 1_000) }).resolve(payload())

        XCTAssertEqual(resolution, .rendered(RenderedNotification(title: "Team", subtitle: "Carol", body: "hello"), sound: true))
        XCTAssertFalse(api.accounts.isEmpty)
    }

    func testFallbackUsesTheStoredRoomNameBeforeAnyFetch() {
        let store = FakeStore(accounts: ["@alice:hs": alice], rooms: ["@alice:hs": ["!r:hs": HandoffRoom(name: "Team", direct: false)]])

        XCTAssertEqual(
            PushContentResolver(store: store, api: FakeAPI()).fallback(for: payload()),
            RenderedNotification(title: "Team", subtitle: "", body: "New message")
        )
    }

    func testTimeoutSpendsTheOneBudgetForLaterReads() async {
        let api = FakeAPI(event: nil)
        api.eventDelay = 200_000_000
        let resolver = PushContentResolver(store: FakeStore(accounts: ["@alice:hs": alice]), api: api, budget: 0.05)

        let resolution = await resolver.resolve(payload())

        XCTAssertEqual(resolution, .rendered(RenderedNotification(title: "Trinity", subtitle: "", body: "New message"), sound: true))
        XCTAssertEqual(api.roomNameDeadlines.count, 1)
        XCTAssertLessThan(api.roomNameDeadlines[0].timeIntervalSinceNow, 0)
    }

    func testRoomMissingFromTheStoreTakesItsNameFromStateOrFallsBack() async {
        let store = FakeStore(accounts: ["@alice:hs": alice])

        let named = await PushContentResolver(store: store, api: FakeAPI(event: message(), roomName: "Lobby")).resolve(payload())
        let unnamed = await PushContentResolver(store: store, api: FakeAPI(event: message())).resolve(payload())

        XCTAssertEqual(named, .rendered(RenderedNotification(title: "Lobby", subtitle: "@carol:hs", body: "New message"), sound: true))
        XCTAssertEqual(unnamed, .rendered(RenderedNotification(title: "Trinity", subtitle: "@carol:hs", body: "New message"), sound: true))
    }

    func testDirectMessageHasNoSubtitle() async {
        let store = FakeStore(accounts: ["@alice:hs": alice], rooms: ["@alice:hs": ["!r:hs": HandoffRoom(name: "Bob", direct: true, encrypted: false)]])
        let api = FakeAPI(event: message(sender: "@bob:hs", body: "hi"), memberName: "Bob")

        let resolution = await PushContentResolver(store: store, api: api).resolve(payload())

        XCTAssertEqual(resolution, .rendered(RenderedNotification(title: "Bob", subtitle: "", body: "hi"), sound: true))
    }

    func testEncryptedEventShowsRoomAndSender() async {
        let store = FakeStore(accounts: ["@alice:hs": alice], rooms: ["@alice:hs": ["!r:hs": HandoffRoom(name: "Secret", direct: false)]])
        let encrypted: [String: Any] = ["type": "m.room.encrypted", "sender": "@carol:hs", "content": [String: Any]()]

        let resolution = await PushContentResolver(store: store, api: FakeAPI(event: encrypted, memberName: "Carol")).resolve(payload())

        XCTAssertEqual(resolution, .rendered(RenderedNotification(title: "Secret", subtitle: "Carol", body: "Encrypted message"), sound: true))
    }

    func testUsesTheTaggedAccountsCredentialsAndSound() async {
        let api = FakeAPI(event: message(), memberName: "Carol")
        let store = FakeStore(
            accounts: ["@alice:hs": alice, "@bob:hs": bob],
            rooms: [
                "@alice:hs": ["!r:hs": HandoffRoom(name: "Alice's room", direct: false, encrypted: false)],
                "@bob:hs": ["!r:hs": HandoffRoom(name: "Bob's room", direct: false, encrypted: false)],
            ]
        )

        let resolution = await PushContentResolver(store: store, api: api).resolve(payload(user: "@bob:hs"))

        XCTAssertFalse(api.accounts.isEmpty)
        XCTAssertTrue(api.accounts.allSatisfy { $0 == bob })
        XCTAssertEqual(resolution, .rendered(RenderedNotification(title: "Bob's room", subtitle: "Carol", body: "hello"), sound: false))
    }

    // MARK: Tokens

    private let team = ["@alice:hs": ["!r:hs": HandoffRoom(name: "Team", direct: false, encrypted: false)]]
    private let longPast = Date(timeIntervalSince1970: 1_000)

    private func entry(token: String = "old", expired: Bool) -> HandoffAccount {
        HandoffAccount(
            homeserverUrl: "https://a.example", accessToken: token, sound: true,
            accessTokenExpiresAt: expired ? longPast : nil)
    }

    private func body(_ resolution: PushResolution) -> String? {
        if case .rendered(let rendered, _) = resolution { return rendered.body }
        return nil
    }

    private func refreshAnswer(_ name: String?) throws -> TokenRefreshResult {
        let renewed = tokenRecord(accessToken: "new")
        switch name {
        case nil: return .gone // A row with no refresh must never ask for one.
        case "rotated": return .rotated(renewed, unsaved: false)
        case "unsaved": return .rotated(renewed, unsaved: true)
        case "current": return .current(renewed)
        case "busy": return .busy
        case "transient": return .transient
        case "unavailable": return .unavailable
        case "refused": return .refused
        case "gone": return .gone
        default: throw CocoaError(.coderInvalidValue)
        }
    }

    private func eventRead(_ name: String) throws -> PushEventRead {
        switch name {
        case "ok": return .event(message(sender: "@alice:hs"))
        case "unauthorized": return .unauthorized
        case "failed": return .failed
        default: throw CocoaError(.coderInvalidValue)
        }
    }

    /// The `tokenFlows` of native/push-render/push-render-cases.json, which the Android suite runs too.
    func testEverySharedTokenFlow() async throws {
        let fixture = try XCTUnwrap(PushRenderRulesTests.sharedFixture())
        let document = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])
        let flows = try XCTUnwrap(document["tokenFlows"] as? [[String: Any]])
        XCTAssertEqual(flows.count, 19)
        for row in flows {
            let name = try XCTUnwrap(row["name"] as? String)
            let refresh = row["refresh"] as? String
            let reads = try [row["firstFetch"], row["secondFetch"]].compactMap { $0 as? String }.map(eventRead)
            let answer = try refreshAnswer(refresh)
            let api = FakeAPI(eventReads: reads, memberName: "Alice")
            let tokens = FakeTokens(answer: answer)
            let store = FakeStore(
                accounts: ["@alice:hs": entry(expired: try XCTUnwrap(row["tokenExpired"] as? Bool))], rooms: team)

            let resolution = await PushContentResolver(store: store, api: api, tokens: tokens).resolve(payload())

            guard case .rendered(let rendered, let sound) = resolution else {
                XCTFail("\(name): \(resolution)")
                continue
            }
            XCTAssertEqual(rendered.body, row["body"] as? String, name)
            XCTAssertEqual(rendered.title, "Team", name)
            XCTAssertTrue(sound, name)
            XCTAssertEqual(api.eventCalls, row["fetches"] as? Int, name)
            XCTAssertEqual(tokens.calls, refresh == nil ? 0 : 1, name)
            XCTAssertEqual(tokens.tokensSeen, refresh == nil ? [] : ["old"], name)
            switch answer {
            case .current, .rotated:
                XCTAssertEqual(api.accounts.last?.accessToken, "new", name)
            default:
                XCTAssertTrue(api.accounts.allSatisfy { $0.accessToken == "old" }, name)
            }
        }
    }

    /// The third read would succeed: only the one-retry rule keeps it from being made.
    func testASecond401MakesNoSecondRefreshOrThirdFetch() async {
        let store = FakeStore(accounts: ["@alice:hs": entry(expired: false)], rooms: team)
        let api = FakeAPI(eventReads: [.unauthorized, .unauthorized, .event(message())], memberName: "Carol")
        let tokens = FakeTokens(answer: .rotated(tokenRecord(accessToken: "new"), unsaved: false))

        let resolution = await PushContentResolver(store: store, api: api, tokens: tokens).resolve(payload())

        XCTAssertEqual(body(resolution), "New message")
        XCTAssertEqual(tokens.calls, 1)
        XCTAssertEqual(api.eventCalls, 2)
    }

    func testATokenlessEntryShowsTheOpenTrinityTextWithoutAFetch() async {
        let tokenless = HandoffAccount(homeserverUrl: "https://a.example", accessToken: "", sound: true)
            .overlaid(by: .absent)
        let store = FakeStore(accounts: ["@alice:hs": tokenless], rooms: team)
        let api = FakeAPI(event: message())
        let client = FakeClient()
        let refresher = TokenRefresher(vault: FakeVault(nil), lease: FakeLease(), client: client)

        let resolver = PushContentResolver(store: store, api: api, tokens: refresher)
        let resolution = await resolver.resolve(payload())

        XCTAssertEqual(body(resolution), "Open Trinity to read this message")
        XCTAssertEqual(resolver.fallback(for: payload())?.body, "Open Trinity to read this message")
        XCTAssertEqual(api.eventCalls, 0)
        XCTAssertTrue(client.grants.isEmpty)
    }

    func testAVaultRecordWithNoHandoffEntryIsNotRefreshed() async {
        let vault = FakeVault(tokenRecord(expiresAt: longPast))
        let client = FakeClient()
        let api = FakeAPI(event: message())
        let refresher = TokenRefresher(vault: vault, lease: FakeLease(), client: client)
        let store = FakeStore(accounts: [:])

        let resolution = await PushContentResolver(store: store, api: api, tokens: refresher).resolve(payload())

        XCTAssertEqual(resolution, .unchanged)
        XCTAssertNil(PushRender(
            userInfo: ["trinity_user_id": "@alice:hs", "room_id": "!r:hs", "event_id": "$e"],
            store: store, api: api, tokens: refresher))
        XCTAssertTrue(client.grants.isEmpty)
        XCTAssertEqual(vault.stored?.accessToken, "a0")
        XCTAssertTrue(api.accounts.isEmpty)
    }

    func testABurstSharesOneRotation() async throws {
        let container = FileManager.default.temporaryDirectory.appendingPathComponent("burst-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: container) }
        let client = FakeClient()
        client.onGrant = { try? await Task.sleep(for: .milliseconds(100)) }
        let refresher = TokenRefresher(
            vault: FakeVault(tokenRecord(expiresAt: longPast)), lease: AppGroupTokenLease(containerURL: container),
            client: client)
        let store = FakeStore(accounts: ["@alice:hs": entry(token: "a0", expired: true)], rooms: team)
        let api = FakeAPI(event: message(), memberName: "Carol")
        let resolver = PushContentResolver(store: store, api: api, tokens: refresher)

        async let first = resolver.resolve(payload())
        async let second = resolver.resolve(payload())
        let answers = await [first, second]

        XCTAssertEqual(client.grants.count, 1)
        XCTAssertEqual(answers.map(body), ["hello", "hello"])
        XCTAssertEqual(api.eventCalls, 2)
        XCTAssertTrue(api.accounts.allSatisfy { $0.accessToken == "a1" })
    }

    func testAnExpiredEntryShowsTheFallbackWhenRefreshIsGone() async {
        let store = FakeStore(accounts: ["@alice:hs": entry(expired: true)], rooms: team)
        let api = FakeAPI(event: message())
        let tokens = FakeTokens(answer: .gone)

        let resolution = await PushContentResolver(store: store, api: api, tokens: tokens).resolve(payload())

        XCTAssertEqual(
            resolution,
            .rendered(RenderedNotification(title: "Team", subtitle: "", body: "Open Trinity to read this message"), sound: true))
        XCTAssertTrue(api.accounts.isEmpty)
    }

    func testTheRefreshGetsFifteenSeconds() async {
        let store = FakeStore(accounts: ["@alice:hs": entry(expired: true)], rooms: team)
        let tokens = FakeTokens(answer: .gone)

        _ = await PushContentResolver(store: store, api: FakeAPI(), tokens: tokens).resolve(payload())

        XCTAssertEqual(tokens.lastBudget, 15)
    }

    func testNoRefreshWithNoTokensDependency() async {
        let expired = FakeStore(accounts: ["@alice:hs": entry(expired: true)], rooms: team)
        let rejected = FakeStore(accounts: ["@alice:hs": entry(expired: false)], rooms: team)
        let unusedAPI = FakeAPI(event: message())
        let oneRead = FakeAPI(eventReads: [.unauthorized])

        let shown = await PushContentResolver(store: expired, api: unusedAPI).resolve(payload())
        let afterA401 = await PushContentResolver(store: rejected, api: oneRead).resolve(payload())

        XCTAssertEqual(body(shown), "Open Trinity to read this message")
        XCTAssertEqual(unusedAPI.eventCalls, 0)
        XCTAssertEqual(body(afterA401), "New message")
        XCTAssertEqual(oneRead.eventCalls, 1)
    }

    func testTheFetchAfterARefreshGetsItsOwnDeadline() async throws {
        let store = FakeStore(accounts: ["@alice:hs": entry(expired: false)], rooms: [:])
        let api = FakeAPI(eventReads: [.unauthorized, .event(message())], memberName: "Carol")
        let tokens = FakeTokens(answer: .current(tokenRecord(accessToken: "new")), delay: .milliseconds(200))

        _ = await PushContentResolver(store: store, api: api, tokens: tokens, budget: 0.1).resolve(payload())

        XCTAssertEqual(api.eventDeadlines.count, 2)
        XCTAssertGreaterThan(api.eventDeadlines[1].timeIntervalSince(api.eventDeadlines[0]), 0.15)
        XCTAssertEqual(api.roomNameDeadlines, [api.eventDeadlines[1]])
        XCTAssertEqual(api.memberDeadlines, [api.eventDeadlines[1]])
    }

    func testEveryReadAfterARefreshUsesTheNewToken() async throws {
        let store = FakeStore(accounts: ["@alice:hs": entry(expired: false)], rooms: [:])
        let api = FakeAPI(eventReads: [.unauthorized, .event(message())], memberName: "Carol")
        let tokens = FakeTokens(answer: .rotated(tokenRecord(accessToken: "new"), unsaved: false))

        _ = await PushContentResolver(store: store, api: api, tokens: tokens).resolve(payload())

        XCTAssertEqual(api.accounts.map(\.accessToken), ["old", "new", "new", "new"])
    }

    func testPayloadNeedsAccountRoomAndEvent() {
        XCTAssertNil(PushPayload(userInfo: ["room_id": "!r:hs", "event_id": "$e"]))
        XCTAssertNil(PushPayload(userInfo: ["trinity_user_id": "@a:hs", "room_id": "!r:hs", "unread": "0"]))
    }
}

final class PushRenderTests: XCTestCase {
    private let bob = HandoffAccount(homeserverUrl: "https://b.example", accessToken: "token-b", sound: false)

    private func userInfo(user: String = "@bob:hs") -> [AnyHashable: Any] {
        [
            "aps": ["alert": ["title": "Trinity", "body": "New message"], "mutable-content": 1],
            "trinity_user_id": user,
            "room_id": "!r:hs",
            "event_id": "$e",
        ]
    }

    func testStartsFromTheRoomFallbackAndResolvesToTheMessage() async throws {
        let store = FakeStore(accounts: ["@bob:hs": bob], rooms: ["@bob:hs": ["!r:hs": HandoffRoom(name: "Team", direct: false, encrypted: false)]])
        let api = FakeAPI(event: ["type": "m.room.message", "sender": "@carol:hs", "content": ["msgtype": "m.text", "body": "hello"]], memberName: "Carol")

        let render = try XCTUnwrap(PushRender(userInfo: userInfo(), store: store, api: api))
        let resolved = await render.resolve()

        XCTAssertEqual(
            render.fallback,
            PushNotificationContent(title: "Team", subtitle: "", body: "New message", threadIdentifier: "!r:hs", sound: false)
        )
        XCTAssertEqual(
            resolved,
            PushNotificationContent(title: "Team", subtitle: "Carol", body: "hello", threadIdentifier: "!r:hs", sound: false)
        )
    }

    func testStartsAndEndsWithTheOpenTrinityTextWhenTheStoredTokenHasExpired() async throws {
        let expired = HandoffAccount(
            homeserverUrl: "https://b.example",
            accessToken: "token-b",
            sound: false,
            accessTokenExpiresAt: Date(timeIntervalSince1970: 0)
        )
        let store = FakeStore(accounts: ["@bob:hs": expired], rooms: ["@bob:hs": ["!r:hs": HandoffRoom(name: "Team", direct: false)]])
        let api = FakeAPI(event: ["type": "m.room.message", "sender": "@carol:hs", "content": ["msgtype": "m.text", "body": "hello"]], memberName: "Carol")
        let expected = PushNotificationContent(
            title: "Team",
            subtitle: "",
            body: "Open Trinity to read this message",
            threadIdentifier: "!r:hs",
            sound: false
        )

        let render = try XCTUnwrap(PushRender(userInfo: userInfo(), store: store, api: api))
        let resolved = await render.resolve()

        XCTAssertEqual(render.fallback, expected)
        XCTAssertEqual(resolved, expected)
        XCTAssertTrue(api.accounts.isEmpty)
    }

    func testResolvesThroughItsTokensAndStartsFromTheOpenTrinityText() async throws {
        let expired = HandoffAccount(
            homeserverUrl: "https://b.example", accessToken: "old", sound: false,
            accessTokenExpiresAt: Date(timeIntervalSince1970: 0))
        let store = FakeStore(accounts: ["@bob:hs": expired], rooms: ["@bob:hs": ["!r:hs": HandoffRoom(name: "Team", direct: false, encrypted: false)]])
        let api = FakeAPI(event: ["type": "m.room.message", "sender": "@carol:hs", "content": ["msgtype": "m.text", "body": "hello"]], memberName: "Carol")
        let tokens = FakeTokens(answer: .rotated(tokenRecord(accessToken: "new"), unsaved: false))

        let render = try XCTUnwrap(PushRender(userInfo: userInfo(), store: store, api: api, tokens: tokens))
        let resolved = await render.resolve()

        XCTAssertEqual(render.fallback.body, "Open Trinity to read this message")
        XCTAssertEqual(resolved.body, "hello")
        XCTAssertEqual(tokens.calls, 1)
    }

    func testLeavesOtherPushesAndUnknownAccountsToTheGatewaysAlert() {
        let store = FakeStore(accounts: ["@bob:hs": bob])
        var badgeOnly = userInfo()
        badgeOnly["event_id"] = nil

        XCTAssertNil(PushRender(userInfo: userInfo(user: "@alice:hs"), store: store, api: FakeAPI()))
        XCTAssertNil(PushRender(userInfo: badgeOnly, store: store, api: FakeAPI()))
        XCTAssertNil(PushRender(userInfo: userInfo(), store: nil, api: FakeAPI()))
    }
}
