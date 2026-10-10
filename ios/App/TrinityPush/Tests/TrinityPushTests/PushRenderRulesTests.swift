import Foundation
import XCTest
@testable import TrinityPush

/// Runs native/push-render/push-render-cases.json, the fixture the Android JUnit suite runs too.
final class PushRenderRulesTests: XCTestCase {
    func testEverySharedFixtureCaseRendersAsExpected() throws {
        // Tests/TrinityPushTests/<file> → repository root is six levels up.
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }
        let fixture = root.appendingPathComponent("native/push-render/push-render-cases.json")
        let document = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any]
        )
        let cases = try XCTUnwrap(document["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for testCase in cases {
            let name = try XCTUnwrap(testCase["name"] as? String)
            let storedRoom = (testCase["storedRoom"] as? [String: Any]).map {
                HandoffRoom(name: $0["name"] as? String ?? "", direct: $0["direct"] as? Bool ?? false)
            }
            let expected = try XCTUnwrap(testCase["expected"] as? [String: String])
            let actual = PushRenderRules.render(
                event: testCase["event"] as? [String: Any],
                storedRoom: storedRoom,
                stateRoomName: testCase["stateRoomName"] as? String,
                senderName: testCase["senderName"] as? String
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
}
