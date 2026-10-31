import Foundation
import Security

public enum TokenState: String, Codable {
    case active
    case refused
}

/// One OAuth account's tokens and the endpoint they are refreshed at. Its descriptions
/// never show a token or an endpoint, so a stray print or a failed assertion cannot leak one.
public struct TokenRecord: Codable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable {
    public let accessToken: String
    public let refreshToken: String?
    public let expiresAt: Date?
    public let tokenEndpoint: String?
    public let revocationEndpoint: String?
    public let clientId: String?
    public let deviceId: String?
    public let lineage: String
    public let state: TokenState

    public init(
        accessToken: String, refreshToken: String?, expiresAt: Date?, tokenEndpoint: String?,
        revocationEndpoint: String?, clientId: String?, deviceId: String?, lineage: String, state: TokenState
    ) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.tokenEndpoint = tokenEndpoint
        self.revocationEndpoint = revocationEndpoint
        self.clientId = clientId
        self.deviceId = deviceId
        self.lineage = lineage
        self.state = state
    }

    public var description: String { "TokenRecord(lineage: \(lineage), state: \(state.rawValue))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["lineage": lineage, "state": state.rawValue]) }

    /// Whether both records hold the same access and refresh token.
    public func samePair(as other: TokenRecord) -> Bool {
        accessToken == other.accessToken && refreshToken == other.refreshToken
    }

    public func marked(_ state: TokenState) -> TokenRecord {
        TokenRecord(
            accessToken: accessToken, refreshToken: refreshToken, expiresAt: expiresAt, tokenEndpoint: tokenEndpoint,
            revocationEndpoint: revocationEndpoint, clientId: clientId, deviceId: deviceId, lineage: lineage,
            state: state)
    }

    /// The record after a grant: active, with the new access token and expiry. An answer with no
    /// refresh token keeps the old one (a provider that does not rotate).
    public func rotated(_ access: String, _ refresh: String?, expiresAt: Date?) -> TokenRecord {
        TokenRecord(
            accessToken: access, refreshToken: refresh ?? refreshToken, expiresAt: expiresAt,
            tokenEndpoint: tokenEndpoint, revocationEndpoint: revocationEndpoint, clientId: clientId,
            deviceId: deviceId, lineage: lineage, state: .active)
    }
}

public enum TokenVaultRead: Equatable {
    case absent
    /// The keychain could not answer (locked, or an item that does not decode): never "absent".
    case unavailable
    case record(TokenRecord)

    public static func from(status: OSStatus, data: Data?) -> TokenVaultRead {
        if status == errSecItemNotFound { return .absent }
        guard status == errSecSuccess, let data,
              let record = try? JSONDecoder().decode(TokenRecord.self, from: data)
        else { return .unavailable }
        return .record(record)
    }
}

public enum TokenVaultWrite: Equatable {
    case written
    case absent
    case failed
}

public enum TokenGrantAnswer: Equatable, CustomStringConvertible, CustomReflectable {
    case tokens(accessToken: String, refreshToken: String?, expiresIn: TimeInterval?)
    case refused
    case failed

    public var customMirror: Mirror { Mirror(self, children: []) }

    public var description: String {
        switch self {
        case .tokens: "tokens"
        case .refused: "refused"
        case .failed: "failed"
        }
    }
}

/// What the plugin resolves. The wire carries the access token and its expiry only.
public enum TokenRefreshResult: Equatable, CustomStringConvertible {
    case busy, gone, refused, transient, unavailable
    case current(TokenRecord)
    case rotated(TokenRecord, unsaved: Bool)

    public var wire: [String: Any] {
        switch self {
        case .busy: ["kind": "busy"]
        case .gone: ["kind": "gone"]
        case .refused: ["kind": "refused"]
        case .transient: ["kind": "transient"]
        case .unavailable: ["kind": "unavailable"]
        case .current(let record): Self.tokens("current", record)
        case .rotated(let record, let unsaved):
            Self.tokens("rotated", record).merging(unsaved ? ["unsaved": true] : [:]) { $1 }
        }
    }

    public var description: String { wire["kind"] as? String ?? "" }

    private static func tokens(_ kind: String, _ record: TokenRecord) -> [String: Any] {
        var wire: [String: Any] = ["kind": kind, "accessToken": record.accessToken]
        // A value no Int holds (huge or non-finite) is left out: the app reads that as no expiry.
        if let expiresAt = record.expiresAt,
           let milliseconds = Int(exactly: (expiresAt.timeIntervalSince1970 * 1000).rounded()) {
            wire["accessTokenExpiresAt"] = milliseconds
        }
        return wire
    }
}

public enum TokenRevokeResult: String {
    case revoked, gone, transient

    public var wire: [String: Any] { ["kind": rawValue] }
}

/// Seconds.
public enum TokenBudgets {
    public static let appGrant: TimeInterval = 8
    public static let serviceRefresh: TimeInterval = 15
    public static let leaseMargin: TimeInterval = 5
    public static let longestLifetime: TimeInterval = 30
    public static let removalWait: TimeInterval = 1
    public static let revokeWait: TimeInterval = 1
    public static let revokeRequest: TimeInterval = 2
}

public protocol TokenVault {
    func read(_ userId: String) -> TokenVaultRead
    /// Adds or updates.
    func write(_ record: TokenRecord, for userId: String) -> Bool
    /// `SecItemUpdate` only: never adds an item.
    func update(_ record: TokenRecord, for userId: String) -> TokenVaultWrite
    func remove(_ userId: String) -> Bool
    func removeAll() -> Bool
}
