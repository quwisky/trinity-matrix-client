import XCTest
@testable import TrinityPush

/// What PushHandoff.clearRoom removes when a room is opened.
final class DeliveredPushesTests: XCTestCase {
    func testClearsOnlyTheOpeningAccountsNotificationsForTheRoom() {
        let delivered = [
            DeliveredPush(identifier: "mine", threadIdentifier: "!r:hs", accountId: "@a:hs"),
            DeliveredPush(identifier: "other-account", threadIdentifier: "!r:hs", accountId: "@b:hs"),
            DeliveredPush(identifier: "other-room", threadIdentifier: "!o:hs", accountId: "@a:hs"),
            DeliveredPush(identifier: "untagged", threadIdentifier: "!r:hs", accountId: nil),
        ]

        XCTAssertEqual(
            DeliveredPushes.identifiers(in: delivered, accountId: "@a:hs", roomId: "!r:hs"),
            ["mine", "untagged"]
        )
    }

    func testClearsNothingWhenTheRoomHasNoNotifications() {
        let delivered = [DeliveredPush(identifier: "1", threadIdentifier: "!o:hs", accountId: "@a:hs")]

        XCTAssertEqual(DeliveredPushes.identifiers(in: delivered, accountId: "@a:hs", roomId: "!r:hs"), [])
    }
}
