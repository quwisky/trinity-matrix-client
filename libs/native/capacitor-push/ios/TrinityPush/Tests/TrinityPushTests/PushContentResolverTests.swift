import Foundation
import XCTest
@testable import TrinityPush

private struct FakeStore: HandoffReading {
    var accounts: [String: HandoffAccount]
    var rooms: [String: [String: HandoffRoom]] = [:]
    func account(_ userId: String) -> HandoffAccount? { accounts[userId] }
    func room(_ userId: String, _ roomId: String) -> HandoffRoom? { rooms[userId]?[roomId] }
}

private final class FakeAPI: MatrixPushAPI, @unchecked Sendable {
    private let lock = NSLock()
    private var recordedAccounts: [HandoffAccount] = []
    private var recordedRoomNameDeadlines: [Date] = []
    let event: [String: Any]?
    let memberName: String?
    let roomName: String?
    var eventDelay: UInt64 = 0

    var accounts: [HandoffAccount] { lock.withLock { recordedAccounts } }
    var roomNameDeadlines: [Date] { lock.withLock { recordedRoomNameDeadlines } }

    init(event: [String: Any]? = nil, memberName: String? = nil, roomName: String? = nil) {
        self.event = event
        self.memberName = memberName
        self.roomName = roomName
    }

    func event(account: HandoffAccount, roomId: String, eventId: String, deadline: Date) async -> [String: Any]? {
        lock.withLock { recordedAccounts.append(account) }
        if eventDelay > 0 { try? await Task.sleep(nanoseconds: eventDelay) }
        return event
    }

    func memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Date) async -> String? {
        lock.withLock { recordedAccounts.append(account) }
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

        XCTAssertEqual(named, .rendered(RenderedNotification(title: "Lobby", subtitle: "@carol:hs", body: "hello"), sound: true))
        XCTAssertEqual(unnamed, .rendered(RenderedNotification(title: "Trinity", subtitle: "@carol:hs", body: "hello"), sound: true))
    }

    func testDirectMessageHasNoSubtitle() async {
        let store = FakeStore(accounts: ["@alice:hs": alice], rooms: ["@alice:hs": ["!r:hs": HandoffRoom(name: "Bob", direct: true)]])
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
                "@alice:hs": ["!r:hs": HandoffRoom(name: "Alice's room", direct: false)],
                "@bob:hs": ["!r:hs": HandoffRoom(name: "Bob's room", direct: false)],
            ]
        )

        let resolution = await PushContentResolver(store: store, api: api).resolve(payload(user: "@bob:hs"))

        XCTAssertFalse(api.accounts.isEmpty)
        XCTAssertTrue(api.accounts.allSatisfy { $0 == bob })
        XCTAssertEqual(resolution, .rendered(RenderedNotification(title: "Bob's room", subtitle: "Carol", body: "hello"), sound: false))
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
        let store = FakeStore(accounts: ["@bob:hs": bob], rooms: ["@bob:hs": ["!r:hs": HandoffRoom(name: "Team", direct: false)]])
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

    func testLeavesOtherPushesAndUnknownAccountsToTheGatewaysAlert() {
        let store = FakeStore(accounts: ["@bob:hs": bob])
        var badgeOnly = userInfo()
        badgeOnly["event_id"] = nil

        XCTAssertNil(PushRender(userInfo: userInfo(user: "@alice:hs"), store: store, api: FakeAPI()))
        XCTAssertNil(PushRender(userInfo: badgeOnly, store: store, api: FakeAPI()))
        XCTAssertNil(PushRender(userInfo: userInfo(), store: nil, api: FakeAPI()))
    }
}
