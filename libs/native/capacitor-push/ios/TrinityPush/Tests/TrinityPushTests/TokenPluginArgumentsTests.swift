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
}
