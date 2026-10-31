import Foundation
import XCTest
@testable import TrinityPush

final class TokenPluginArgumentsTests: XCTestCase {
    private let complete: [String: Any] = [
        "userId": "@a:hs", "lineage": "L", "accessToken": "a0", "refreshToken": "r0",
        "accessTokenExpiresAt": 1_700_000_300_000, "tokenEndpoint": "https://op.example/token",
        "revocationEndpoint": "https://op.example/revoke", "clientId": "c", "deviceId": "D",
    ]

    func testAMigrationNeedsUserIdLineageTokensEndpointClientAndDevice() throws {
        let parsed = try XCTUnwrap(TokenRecord.fromPluginCall(complete))
        XCTAssertEqual(parsed.userId, "@a:hs")
        XCTAssertEqual(
            parsed.record,
            TokenRecord(
                accessToken: "a0", refreshToken: "r0", expiresAt: Date(timeIntervalSince1970: 1_700_000_300),
                tokenEndpoint: "https://op.example/token", revocationEndpoint: "https://op.example/revoke",
                clientId: "c", deviceId: "D", lineage: "L", state: .active))

        let required = ["userId", "lineage", "accessToken", "refreshToken", "tokenEndpoint", "clientId", "deviceId"]
        for field in required {
            var options = complete
            options[field] = nil
            XCTAssertNil(TokenRecord.fromPluginCall(options), "missing \(field)")
            options[field] = 7
            XCTAssertNil(TokenRecord.fromPluginCall(options), "\(field) not a string")
        }
        for field in required where field != "lineage" {
            var options = complete
            options[field] = ""
            XCTAssertNil(TokenRecord.fromPluginCall(options), "empty \(field)")
        }

        for bad: Any in ["soon", true, 0, Double.nan] {
            var options = complete
            options["accessTokenExpiresAt"] = bad
            XCTAssertNil(try XCTUnwrap(TokenRecord.fromPluginCall(options)).record.expiresAt)
        }
        var noExpiry = complete
        noExpiry["accessTokenExpiresAt"] = nil
        XCTAssertNil(try XCTUnwrap(TokenRecord.fromPluginCall(noExpiry)).record.expiresAt)

        for bad: Any? in [nil, "", 7] {
            var options = complete
            options["revocationEndpoint"] = bad
            XCTAssertNil(try XCTUnwrap(TokenRecord.fromPluginCall(options)).record.revocationEndpoint)
        }
    }

    func testLineageMayBeEmpty() throws {
        var options = complete
        options["lineage"] = ""
        XCTAssertEqual(try XCTUnwrap(TokenRecord.fromPluginCall(options)).record.lineage, "")
    }

    func testARemovalNamesOneAccountOrAsksForAll() {
        XCTAssertEqual(TokenRemoval.fromPluginCall(["userId": "@a:hs"]), TokenRemoval(account: "@a:hs"))
        XCTAssertEqual(TokenRemoval.fromPluginCall(["all": true]), TokenRemoval(account: nil))
        XCTAssertEqual(TokenRemoval.fromPluginCall(["all": NSNumber(value: true)]), TokenRemoval(account: nil))
    }

    func testAMalformedUserIdRemovesNothing() {
        for bad: Any in [NSNull(), "", 7, true, ["@a:hs"]] {
            XCTAssertNil(TokenRemoval.fromPluginCall(["userId": bad]))
        }
    }

    func testOnlyALiteralTrueRemovesEverything() {
        for bad: Any in [NSNull(), false, 1, NSNumber(value: 1), "true"] {
            XCTAssertNil(TokenRemoval.fromPluginCall(["all": bad]), "\(bad)")
        }
    }

    func testARemovalWithNeitherOrBothRemovesNothing() {
        XCTAssertNil(TokenRemoval.fromPluginCall([:]))
        XCTAssertNil(TokenRemoval.fromPluginCall(["userId": "@a:hs", "all": true]))
        XCTAssertNil(TokenRemoval.fromPluginCall(["userId": "@a:hs", "all": false]))
        XCTAssertNil(TokenRemoval.fromPluginCall(["userId": NSNull(), "all": true]))
    }

    func testAGrantNeedsBackgroundTimeUnlessTheAppIsActive() {
        XCTAssertTrue(TokenRefresher.mayStartAppGrant(hasBackgroundTime: true, appIsActive: true))
        XCTAssertTrue(TokenRefresher.mayStartAppGrant(hasBackgroundTime: true, appIsActive: false))
        XCTAssertTrue(TokenRefresher.mayStartAppGrant(hasBackgroundTime: false, appIsActive: true))
        XCTAssertFalse(TokenRefresher.mayStartAppGrant(hasBackgroundTime: false, appIsActive: false))
    }
}
