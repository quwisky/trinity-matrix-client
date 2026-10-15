import XCTest
@testable import TrinityAppLockCore

final class PinPolicyTests: XCTestCase {
    private static let failureAt: Double = 1_700_000_000_000
    private static let failureUptime: Double = 5_000

    func testSharedFormats() throws {
        let fixture = try Self.fixture()
        let formats = try XCTUnwrap(fixture["formats"] as? [[String: Any]])
        XCTAssertFalse(formats.isEmpty)
        for row in formats {
            let name = try XCTUnwrap(row["name"] as? String)
            let pin = try XCTUnwrap(row["pin"] as? String)
            let valid = try XCTUnwrap(row["valid"] as? Bool)
            XCTAssertEqual(PinPolicy.isValid(pin), valid, name)
        }
    }

    /// The whole string, ASCII only: no other Unicode digit class, no combining mark.
    func testRefusesEveryNonAsciiDigit() {
        XCTAssertFalse(PinPolicy.isValid("\u{1D7CF}\u{1D7D0}\u{1D7D1}\u{1D7D2}"), "mathematical digits")
        XCTAssertFalse(PinPolicy.isValid("\u{0967}\u{0968}\u{0969}\u{096A}"), "Devanagari digits")
        XCTAssertFalse(PinPolicy.isValid("1234\u{0301}"), "combining mark")
        XCTAssertFalse(PinPolicy.isValid(" 1234"), "leading space")
        XCTAssertFalse(PinPolicy.isValid("1234\u{0000}"), "trailing NUL")
    }

    func testSharedDelays() throws {
        let delays = try XCTUnwrap(try Self.fixture()["delays"] as? [[String: Int]])
        for row in delays {
            XCTAssertEqual(
                PinPolicy.waitSeconds(afterFailures: row["failures"] ?? -1),
                row["waitSeconds"],
                "failures \(row["failures"] ?? -1)"
            )
        }
    }

    func testSharedAttempts() throws {
        let attempts = try XCTUnwrap(try Self.fixture()["attempts"] as? [[String: Any]])
        for row in attempts {
            let name = try XCTUnwrap(row["name"] as? String)
            let failures = try XCTUnwrap(row["failures"] as? Int)
            let wall = try XCTUnwrap(row["wallElapsedSeconds"] as? Double)
            let uptime = try XCTUnwrap(row["uptimeElapsedSeconds"] as? Double)
            let rebooted = try XCTUnwrap(row["rebooted"] as? Bool)
            let allowed = try XCTUnwrap(row["allowed"] as? Bool)
            let state = PinFailureState(
                failures: failures,
                failureAtMs: failures > 0 ? Self.failureAt : nil,
                failureUptimeS: failures > 0 ? Self.failureUptime : nil
            )
            let clock = PinClockReading(
                nowMs: Self.failureAt + wall * 1000,
                uptimeS: rebooted ? 3 : Self.failureUptime + uptime
            )
            XCTAssertEqual(PinPolicy.attemptAllowed(state, at: clock), allowed, name)
        }
    }

    /// The since-boot reading comes from CLOCK_MONOTONIC_RAW (mach_continuous_time), not the
    /// wall-derived CLOCK_MONOTONIC; why that clock counts sleep is on PinVerifier.systemClock.
    /// Sleep itself cannot be shown here: that stays an owner check on a device.
    func testSystemClockReadsTheContinuousClock() {
        let continuous = Double(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1_000_000_000
        let reading = PinVerifier.systemClock()
        XCTAssertEqual(reading.uptimeS, continuous, accuracy: 0.05)
        XCTAssertEqual(reading.nowMs, Date().timeIntervalSince1970 * 1000, accuracy: 1000)
    }

    /// The repository's shared fixture, found by walking up from this file.
    static func fixture(from file: String = #filePath) throws -> [String: Any] {
        var directory = URL(fileURLWithPath: file).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent("native/app-lock/pin-policy-cases.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try XCTUnwrap(
                    JSONSerialization.jsonObject(with: Data(contentsOf: candidate)) as? [String: Any]
                )
            }
            directory.deleteLastPathComponent()
        }
        throw XCTSkip("native/app-lock/pin-policy-cases.json not found above \(file)")
    }
}
