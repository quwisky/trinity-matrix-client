import Foundation
import Security
import XCTest
@testable import TrinityPush

/// The pure half of the token vault. The keychain calls (`write`, `update`, `read`, `remove`,
/// `removeAll`) are not run here: the macOS test host would put real items in the developer's
/// login keychain, and an access group needs a signed app. Those are only compiled.
final class TokenVaultTests: XCTestCase {
    private let r0 = TokenRecord(
        accessToken: "a0", refreshToken: "r0", expiresAt: Date(timeIntervalSince1970: 1_700_000_300),
        tokenEndpoint: "https://op.example/token", revocationEndpoint: "https://op.example/revoke",
        clientId: "c", deviceId: "D", lineage: "L", state: .active)

    func testAMissingItemReadsAsAbsent() {
        XCTAssertEqual(TokenVaultRead.from(status: errSecItemNotFound, data: nil), .absent)
    }

    func testALockedKeychainReadsAsUnavailableNeverAbsent() {
        XCTAssertEqual(TokenVaultRead.from(status: errSecInteractionNotAllowed, data: nil), .unavailable)
    }

    func testAnUndecodableItemReadsAsUnavailable() {
        XCTAssertEqual(TokenVaultRead.from(status: errSecSuccess, data: Data("x".utf8)), .unavailable)
        XCTAssertEqual(TokenVaultRead.from(status: errSecSuccess, data: nil), .unavailable)
    }

    func testTheRecordRoundTrips() throws {
        let data = try JSONEncoder().encode(r0)
        XCTAssertEqual(try JSONDecoder().decode(TokenRecord.self, from: data), r0)
        XCTAssertEqual(TokenVaultRead.from(status: errSecSuccess, data: data), .record(r0))
    }

    func testTheWireNeverCarriesARefreshToken() {
        let results: [TokenRefreshResult] = [
            .busy, .gone, .refused, .transient, .unavailable,
            .current(r0), .rotated(r0, unsaved: true), .rotated(r0, unsaved: false),
        ]
        for result in results {
            let wire = result.wire
            XCTAssertNil(wire["refreshToken"])
            XCTAssertNil(wire["tokenEndpoint"])
            XCTAssertNil(wire["clientId"])
            XCTAssertFalse(String(describing: wire).contains("r0"))
        }
        XCTAssertEqual(
            NSDictionary(dictionary: TokenRefreshResult.current(r0).wire),
            ["kind": "current", "accessToken": "a0", "accessTokenExpiresAt": 1_700_000_300_000] as NSDictionary)
        XCTAssertEqual(TokenRefreshResult.rotated(r0, unsaved: true).wire["unsaved"] as? Bool, true)
        XCTAssertNil(TokenRefreshResult.rotated(r0, unsaved: false).wire["unsaved"])
        XCTAssertEqual(TokenRefreshResult.busy.wire as NSDictionary, ["kind": "busy"] as NSDictionary)
    }

    func testAnExpiryThatDoesNotFitAnIntIsOmittedNotATrap() {
        for seconds in [1e16, -1e16, Double.infinity, -Double.infinity, Double.nan] {
            let record = r0.rotated("a1", nil, expiresAt: Date(timeIntervalSince1970: seconds))
            for result in [TokenRefreshResult.current(record), .rotated(record, unsaved: false)] {
                XCTAssertEqual(result.wire["accessToken"] as? String, "a1")
                XCTAssertNil(result.wire["accessTokenExpiresAt"], "\(seconds)")
                XCTAssertFalse(result.description.isEmpty)
            }
        }
    }

    func testTheRevocationWire() {
        XCTAssertEqual(TokenRevokeResult.revoked.wire as NSDictionary, ["kind": "revoked"] as NSDictionary)
        XCTAssertEqual(TokenRevokeResult.gone.wire as NSDictionary, ["kind": "gone"] as NSDictionary)
        XCTAssertEqual(TokenRevokeResult.transient.wire as NSDictionary, ["kind": "transient"] as NSDictionary)
    }

    func testARecordNeverPrintsItsTokens() {
        let outputs = [
            String(describing: r0), "\(r0)", String(reflecting: r0), "\(TokenVaultRead.record(r0))",
            "\(TokenRefreshResult.current(r0))",
            "\(TokenGrantAnswer.tokens(accessToken: "a1", refreshToken: "r1", expiresIn: 60))",
        ]
        var dumped = ""
        dump(r0, to: &dumped)
        let answer = TokenGrantAnswer.tokens(accessToken: "a1", refreshToken: "r1", expiresIn: 60)
        dump(answer, to: &dumped)
        XCTAssertTrue(Mirror(reflecting: answer).children.isEmpty)
        for text in outputs + [dumped] {
            for secret in ["a0", "r0", "a1", "r1"] { XCTAssertFalse(text.contains(secret), text) }
        }
    }

    func testTheTokenSourcesNeverLog() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/TrinityPush")
        let names = ["TokenRecord.swift", "PushHandoffStore+TokenVault.swift"]
        for name in names {
            let text = try String(contentsOf: sources.appendingPathComponent(name), encoding: .utf8)
            for call in ["print(", "NSLog", "os_log", "Logger(", "dump("] {
                XCTAssertFalse(text.contains(call), "\(name) contains \(call)")
            }
        }
    }

    func testRecordHelpers() {
        XCTAssertTrue(r0.samePair(as: r0.marked(.refused)))
        XCTAssertEqual(r0.marked(.refused).state, .refused)
        let rotated = r0.marked(.refused).rotated("a1", nil, expiresAt: nil)
        XCTAssertEqual(rotated.refreshToken, "r0", "a missing refresh token keeps the old one")
        XCTAssertEqual(rotated.state, .active)
        XCTAssertNil(rotated.expiresAt)
        XCTAssertFalse(r0.samePair(as: rotated))
        XCTAssertEqual(r0.rotated("a1", "r1", expiresAt: nil).refreshToken, "r1")
    }

    func testBudgets() {
        XCTAssertEqual(TokenBudgets.appGrant, 8)
        XCTAssertEqual(TokenBudgets.serviceRefresh, 15)
        XCTAssertEqual(TokenBudgets.leaseMargin, 5)
        XCTAssertEqual(TokenBudgets.longestLifetime, 30)
        XCTAssertEqual(TokenBudgets.removalWait, 1)
        XCTAssertEqual(TokenBudgets.revokeWait, 1)
        XCTAssertEqual(TokenBudgets.revokeRequest, 2)
        XCTAssertEqual(TokenBudgets.grace, 3)
    }
}
