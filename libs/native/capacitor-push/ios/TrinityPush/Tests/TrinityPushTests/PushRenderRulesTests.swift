import Foundation
import XCTest
@testable import TrinityPush

/// Runs native/push-render/push-render-cases.json, the fixture the Android JUnit suite runs too.
final class PushRenderRulesTests: XCTestCase {
    func testEverySharedFixtureCaseRendersAsExpected() throws {
        let fixture = try XCTUnwrap(
            Self.sharedFixture(),
            "native/push-render/push-render-cases.json not found above \(#filePath)"
        )
        let document = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any]
        )
        let cases = try XCTUnwrap(document["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for testCase in cases {
            let name = try XCTUnwrap(testCase["name"] as? String)
            let storedRoom = (testCase["storedRoom"] as? [String: Any]).map {
                HandoffRoom(
                    name: $0["name"] as? String ?? "",
                    direct: $0["direct"] as? Bool ?? false,
                    encrypted: $0["encrypted"] as? Bool ?? true
                )
            }
            let expected = try XCTUnwrap(testCase["expected"] as? [String: String])
            let actual = PushRenderRules.render(
                event: testCase["event"] as? [String: Any],
                storedRoom: storedRoom,
                stateRoomName: testCase["stateRoomName"] as? String,
                senderName: testCase["senderName"] as? String,
                tokenExpired: testCase["tokenExpired"] as? Bool ?? false,
                mode: try XCTUnwrap(
                    NotificationTextMode(rawValue: testCase["mode"] as? String ?? "show"),
                    "\(name): unknown mode"
                )
            )
            XCTAssertEqual(
                actual,
                RenderedNotification(
                    title: expected["title"] ?? "",
                    subtitle: expected["subtitle"] ?? "",
                    body: expected["body"] ?? ""
                ),
                name
            )
        }
    }

    func testAlwaysHideNeverReadsTheEvent() {
        let rendered = PushRenderRules.render(
            event: ["type": "m.room.message", "content": ["msgtype": "m.text", "body": "Secret plans"]],
            storedRoom: HandoffRoom(name: "Team", direct: false),
            stateRoomName: "Team",
            senderName: "Alice",
            mode: .alwaysHide
        )
        XCTAssertEqual(rendered, RenderedNotification(title: "", subtitle: "", body: "New message"))
    }

    private final class FakeContent: PushTextContent {
        var title = "Team"
        var subtitle = "Alice"
        var body = "Secret plans"
        var categoryIdentifier = "other"
    }

    func testAlwaysHideLeavesOnlyNewMessageAndNoCategory() {
        let content = FakeContent()
        PushRenderRules.present(.alwaysHide, on: content)
        XCTAssertEqual(
            [content.title, content.subtitle, content.body, content.categoryIdentifier],
            ["", "", "New message", ""]
        )
    }

    func testHideOnTheLockScreenKeepsTheTextInThePrivateCategory() {
        let content = FakeContent()
        PushRenderRules.present(.hideOnLockScreen, on: content)
        XCTAssertEqual(
            [content.title, content.subtitle, content.body, content.categoryIdentifier],
            ["Team", "Alice", "Secret plans", "trinity.message.private"]
        )
    }

    func testShowChangesNothing() {
        let content = FakeContent()
        PushRenderRules.present(.show, on: content)
        XCTAssertEqual(
            [content.title, content.subtitle, content.body, content.categoryIdentifier],
            ["Team", "Alice", "Secret plans", "other"]
        )
    }

    private struct FixedReader: HandoffReading {
        let mode: NotificationTextMode
        func account(_ userId: String) -> HandoffAccount? { nil }
        func room(_ userId: String, _ roomId: String) -> HandoffRoom? { nil }
        func notificationText() -> NotificationTextMode { mode }
    }

    func testNoStoreHidesEverythingAndAStoreSaysWhatItHolds() {
        XCTAssertEqual(NotificationTextMode.mirrored(by: nil), .alwaysHide)
        for mode in [NotificationTextMode.show, .hideOnLockScreen, .alwaysHide] {
            XCTAssertEqual(NotificationTextMode.mirrored(by: FixedReader(mode: mode)), mode)
        }
    }

    private final class ChangingReader: HandoffReading {
        var mode: NotificationTextMode
        init(_ mode: NotificationTextMode) { self.mode = mode }
        func account(_ userId: String) -> HandoffAccount? { nil }
        func room(_ userId: String, _ roomId: String) -> HandoffRoom? { nil }
        func notificationText() -> NotificationTextMode { mode }
    }

    func testAChangeMadeWhileAPushResolvesAppliesWhenTimeRunsOut() {
        let reader = ChangingReader(.show)
        var delivered: [FakeContent] = []
        let deliveries = PushDeliveries<FakeContent>()
        XCTAssertTrue(PushRenderRules.rendersMessage(store: reader))
        _ = deliveries.begin(FakeContent(), handler: PushRenderRules.presenting(store: reader) { delivered.append($0) })
        reader.mode = .alwaysHide
        deliveries.finishAll()
        XCTAssertEqual(delivered.count, 1)
        XCTAssertEqual(
            delivered.map { [$0.title, $0.subtitle, $0.body, $0.categoryIdentifier] },
            [["", "", "New message", ""]]
        )
    }

    func testTheModeAtHandOverWinsOverTheModeAtTheStart() {
        let reader = ChangingReader(.alwaysHide)
        XCTAssertFalse(PushRenderRules.rendersMessage(store: reader))
        var delivered: [FakeContent] = []
        let present: (FakeContent) -> Void = PushRenderRules.presenting(store: reader) { delivered.append($0) }
        reader.mode = .hideOnLockScreen
        present(FakeContent())
        XCTAssertEqual(delivered.first?.categoryIdentifier, "trinity.message.private")
        XCTAssertEqual(delivered.first?.body, "Secret plans")
    }

    func testWithNoStoreNothingIsRenderedAndEverythingIsHidden() {
        XCTAssertFalse(PushRenderRules.rendersMessage(store: nil))
        var delivered: [FakeContent] = []
        let present: (FakeContent) -> Void = PushRenderRules.presenting(store: nil) { delivered.append($0) }
        present(FakeContent())
        XCTAssertEqual(delivered.first?.body, "New message")
        XCTAssertEqual(delivered.first?.title, "")
    }

    /// The repository's shared fixture, found by walking up from this file, so moving the
    /// package cannot point the suite at a path that does not exist.
    private static func sharedFixture(from file: String = #filePath) -> URL? {
        var directory = URL(fileURLWithPath: file).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent("native/push-render/push-render-cases.json")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            directory.deleteLastPathComponent()
        }
        return nil
    }
}
