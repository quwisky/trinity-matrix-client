import XCTest
@testable import TrinityPush

/// What PushHandoff removes when a room is opened, an account signs out or all data is cleared.
final class DeliveredPushesTests: XCTestCase {
    private let delivered = [
        DeliveredPush(identifier: "mine", threadIdentifier: "!r:hs", accountId: "@a:hs", fromPush: true),
        DeliveredPush(identifier: "other-account", threadIdentifier: "!r:hs", accountId: "@b:hs", fromPush: true),
        DeliveredPush(identifier: "other-room", threadIdentifier: "!o:hs", accountId: "@a:hs", fromPush: true),
        DeliveredPush(identifier: "untagged", threadIdentifier: "!r:hs", accountId: nil, fromPush: true),
        // The running app's own notification for the room.
        DeliveredPush(identifier: "local", threadIdentifier: "!o:hs", accountId: nil, fromPush: false),
    ]

    func testClearsOnlyTheOpeningAccountsNotificationsForTheRoom() {
        XCTAssertEqual(
            DeliveredPushes.identifiers(in: delivered, accountId: "@a:hs", roomId: "!r:hs"),
            ["mine", "untagged"]
        )
    }

    func testClearsNothingWhenTheRoomHasNoNotifications() {
        XCTAssertEqual(DeliveredPushes.identifiers(in: delivered, accountId: "@a:hs", roomId: "!x:hs"), [])
    }

    func testSigningOutRemovesOnlyThatAccountsPushes() {
        XCTAssertEqual(DeliveredPushes.identifiers(in: delivered, accountId: "@a:hs"), ["mine", "other-room"])
        XCTAssertEqual(DeliveredPushes.identifiers(in: delivered, accountId: "@b:hs"), ["other-account"])
        XCTAssertEqual(DeliveredPushes.identifiers(in: delivered, accountId: "@c:hs"), [])
    }

    func testClearingAllDataRemovesEveryPushButNotTheAppsOwnNotifications() {
        XCTAssertEqual(
            DeliveredPushes.pushIdentifiers(in: delivered),
            ["mine", "other-account", "other-room", "untagged"]
        )
    }
}
