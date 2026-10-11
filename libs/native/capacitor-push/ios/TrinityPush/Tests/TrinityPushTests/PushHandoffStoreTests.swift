import Foundation
import XCTest
@testable import TrinityPush

/// The app-group file half of the store, and the rule that keychain faults never crash.
/// Keychain writes are not exercised here: the macOS test host would put real items in the
/// developer's login keychain.
final class PushHandoffStoreTests: XCTestCase {
    private var container: URL!
    private var store: PushHandoffStore!

    override func setUpWithError() throws {
        container = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        store = PushHandoffStore(keychainGroup: "invalid.group.for.tests", containerURL: container)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: container)
    }

    private var roomsFile: URL { container.appendingPathComponent("push-handoff/rooms.json") }

    func testMergesRoomsPerAccountAndKeepsTheOnesNotListed() throws {
        try store.mergeRooms(["!a:hs": HandoffRoom(name: "A", direct: false), "!b:hs": HandoffRoom(name: "B", direct: true)], for: "@u:hs")
        try store.mergeRooms(["!a:hs": HandoffRoom(name: "A2", direct: false)], for: "@u:hs")
        try store.mergeRooms(["!a:hs": HandoffRoom(name: "Other", direct: false)], for: "@v:hs")

        XCTAssertEqual(store.room("@u:hs", "!a:hs"), HandoffRoom(name: "A2", direct: false))
        XCTAssertEqual(store.room("@u:hs", "!b:hs"), HandoffRoom(name: "B", direct: true))
        XCTAssertEqual(store.room("@v:hs", "!a:hs"), HandoffRoom(name: "Other", direct: false))
        XCTAssertNil(store.room("@u:hs", "!missing:hs"))
    }

    func testRemovingAnAccountDeletesItsRoomsAndOnlyItsRooms() throws {
        try store.mergeRooms(["!a:hs": HandoffRoom(name: "A", direct: false)], for: "@u:hs")
        try store.mergeRooms(["!a:hs": HandoffRoom(name: "Other", direct: false)], for: "@v:hs")

        _ = try? store.removeAccount("@u:hs")

        XCTAssertNil(store.room("@u:hs", "!a:hs"))
        XCTAssertEqual(store.room("@v:hs", "!a:hs"), HandoffRoom(name: "Other", direct: false))
    }

    func testClearEmptiesTheRoomsFile() throws {
        try store.mergeRooms(["!a:hs": HandoffRoom(name: "A", direct: false)], for: "@u:hs")

        _ = try? store.clear()

        XCTAssertFalse(FileManager.default.fileExists(atPath: roomsFile.path))
        XCTAssertNil(store.room("@u:hs", "!a:hs"))
    }

    func testAMissingOrCorruptRoomsFileReadsAsNoRoom() throws {
        XCTAssertNil(store.room("@u:hs", "!a:hs"))

        try FileManager.default.createDirectory(at: roomsFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: roomsFile)

        XCTAssertNil(store.room("@u:hs", "!a:hs"))
    }

    func testAnAccountThatWasNeverStoredReadsAsNoAccount() {
        XCTAssertNil(store.account("@never-stored:hs"))
    }
}

/// The stored account record: items written before expiries existed must still decode.
final class HandoffAccountTests: XCTestCase {
    func testAnAccountStoredBeforeExpiriesExistedDecodesWithoutOne() throws {
        let legacy = Data(#"{"homeserverUrl":"https://hs.example","accessToken":"token","sound":false}"#.utf8)

        let account = try JSONDecoder().decode(HandoffAccount.self, from: legacy)

        XCTAssertEqual(account, HandoffAccount(homeserverUrl: "https://hs.example", accessToken: "token", sound: false))
        XCTAssertNil(account.accessTokenExpiresAt)
        XCTAssertFalse(account.tokenExpired(at: .distantFuture))
    }

    func testTheExpiryRoundTripsThroughTheStoredEncoding() throws {
        let account = HandoffAccount(
            homeserverUrl: "https://hs.example",
            accessToken: "token",
            sound: true,
            accessTokenExpiresAt: Date(timeIntervalSince1970: 1_760_000_000)
        )

        let decoded = try JSONDecoder().decode(HandoffAccount.self, from: JSONEncoder().encode(account))

        XCTAssertEqual(decoded, account)
    }

    func testTheExpiryParsesLikeAndroidDoes() {
        XCTAssertNil(HandoffAccount.expiry(fromEpochMilliseconds: nil))
        XCTAssertNil(HandoffAccount.expiry(fromEpochMilliseconds: "1760000000000"))
        XCTAssertNil(HandoffAccount.expiry(fromEpochMilliseconds: NSNumber(value: 0)))
        XCTAssertNil(HandoffAccount.expiry(fromEpochMilliseconds: NSNumber(value: -1)))
        XCTAssertNil(HandoffAccount.expiry(fromEpochMilliseconds: NSNumber(value: true)))
        XCTAssertNil(HandoffAccount.expiry(fromEpochMilliseconds: NSNumber(value: false)))
        XCTAssertNil(HandoffAccount.expiry(fromEpochMilliseconds: NSNumber(value: Double.nan)))
        XCTAssertNil(HandoffAccount.expiry(fromEpochMilliseconds: NSNumber(value: Double.infinity)))
        XCTAssertEqual(
            HandoffAccount.expiry(fromEpochMilliseconds: NSNumber(value: 1_760_000_000_000.0)),
            Date(timeIntervalSince1970: 1_760_000_000)
        )
    }

    func testAnAbsurdlyLargeExpiryIsAFarFutureDateAndNeverExpired() throws {
        let expiry = try XCTUnwrap(HandoffAccount.expiry(fromEpochMilliseconds: NSNumber(value: 1e30)))
        let account = HandoffAccount(homeserverUrl: "https://hs.example", accessToken: "token", sound: true, accessTokenExpiresAt: expiry)

        XCTAssertFalse(account.tokenExpired(at: Date(timeIntervalSince1970: 4_000_000_000)))
    }

    func testATokenHasExpiredFromItsExpiryInstantOn() {
        let expiry = Date(timeIntervalSince1970: 1_000)
        let account = HandoffAccount(homeserverUrl: "https://hs.example", accessToken: "token", sound: true, accessTokenExpiresAt: expiry)

        XCTAssertFalse(account.tokenExpired(at: expiry.addingTimeInterval(-0.001)))
        XCTAssertTrue(account.tokenExpired(at: expiry))
        XCTAssertTrue(account.tokenExpired(at: expiry.addingTimeInterval(60)))
    }
}
