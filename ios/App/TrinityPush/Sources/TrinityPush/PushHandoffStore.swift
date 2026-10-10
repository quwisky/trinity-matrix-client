import Foundation
import Security

/// One account's credentials as the app stored them; never a refresh token.
public struct HandoffAccount: Codable, Equatable {
    public let homeserverUrl: String
    public let accessToken: String
    public let sound: Bool

    public init(homeserverUrl: String, accessToken: String, sound: Bool) {
        self.homeserverUrl = homeserverUrl
        self.accessToken = accessToken
        self.sound = sound
    }
}

/// Read side of the push handoff store.
public protocol HandoffReading {
    func account(_ userId: String) -> HandoffAccount?
    func room(_ userId: String, _ roomId: String) -> HandoffRoom?
}

public enum PushHandoffStoreError: Error {
    case keychain(OSStatus)
}

/// The push handoff store shared by the app (writes, through the PushHandoff plugin) and the
/// NotificationService extension (reads). Accounts live in the shared keychain access group
/// with `kSecAttrAccessibleAfterFirstUnlock`, so a locked phone can still render after its
/// first unlock; room names live in the app-group file `push-handoff/rooms.json`.
/// Reads never throw: a keychain or file error reads as "no account" or "no room".
/// Never logs what it stores.
public final class PushHandoffStore: HandoffReading {
    static let service = "dev.trinityproject.trinity.push-handoff"
    private let keychainGroup: String
    private let roomsURL: URL
    private let queue = DispatchQueue(label: "dev.trinityproject.trinity.push-handoff")

    public init(keychainGroup: String, containerURL: URL) {
        self.keychainGroup = keychainGroup
        roomsURL = containerURL
            .appendingPathComponent("push-handoff", isDirectory: true)
            .appendingPathComponent("rooms.json")
    }

    /// The store named by the bundle's `TrinityKeychainGroup` and `TrinityAppGroup` keys.
    public static func fromMainBundle() -> PushHandoffStore? {
        guard let keychainGroup = Bundle.main.object(forInfoDictionaryKey: "TrinityKeychainGroup") as? String,
              !keychainGroup.isEmpty,
              let appGroup = Bundle.main.object(forInfoDictionaryKey: "TrinityAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else { return nil }
        return PushHandoffStore(keychainGroup: keychainGroup, containerURL: container)
    }

    public func setAccount(_ account: HandoffAccount, for userId: String) throws {
        let data = try JSONEncoder().encode(account)
        try queue.sync {
            let query = baseQuery(userId)
            let attributes: [String: Any] = [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            ]
            var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
            }
            guard status == errSecSuccess else { throw PushHandoffStoreError.keychain(status) }
        }
    }

    /// Upserts the given rooms; rooms not listed keep their entries.
    public func mergeRooms(_ rooms: [String: HandoffRoom], for userId: String) throws {
        try queue.sync {
            var all = readRooms()
            all[userId, default: [:]].merge(rooms) { $1 }
            try writeRooms(all)
        }
    }

    /// Deletes the account's token and its rooms. The rooms go even when the keychain fails,
    /// and the keychain error is then thrown.
    public func removeAccount(_ userId: String) throws {
        try queue.sync {
            let status = SecItemDelete(baseQuery(userId) as CFDictionary)
            var all = readRooms()
            if all[userId] != nil {
                all[userId] = nil
                try writeRooms(all)
            }
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw PushHandoffStoreError.keychain(status)
            }
        }
    }

    public func clear() throws {
        try queue.sync {
            let status = SecItemDelete(baseQuery(nil) as CFDictionary)
            if FileManager.default.fileExists(atPath: roomsURL.path) {
                try FileManager.default.removeItem(at: roomsURL)
            }
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw PushHandoffStoreError.keychain(status)
            }
        }
    }

    public func account(_ userId: String) -> HandoffAccount? {
        queue.sync {
            var query = baseQuery(userId)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
                  let data = result as? Data
            else { return nil }
            return try? JSONDecoder().decode(HandoffAccount.self, from: data)
        }
    }

    public func room(_ userId: String, _ roomId: String) -> HandoffRoom? {
        queue.sync { readRooms()[userId]?[roomId] }
    }

    private func baseQuery(_ userId: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccessGroup as String: keychainGroup,
        ]
        if let userId { query[kSecAttrAccount as String] = userId }
        return query
    }

    private func readRooms() -> [String: [String: HandoffRoom]] {
        guard let data = try? Data(contentsOf: roomsURL) else { return [:] }
        return (try? JSONDecoder().decode([String: [String: HandoffRoom]].self, from: data)) ?? [:]
    }

    private func writeRooms(_ rooms: [String: [String: HandoffRoom]]) throws {
        try FileManager.default.createDirectory(
            at: roomsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        try JSONEncoder().encode(rooms).write(to: roomsURL, options: options)
    }
}
