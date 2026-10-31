import Foundation
import Security

/// One account's credentials as the app stored them; never a refresh token.
public struct HandoffAccount: Codable, Equatable {
    public let homeserverUrl: String
    public let accessToken: String
    public let sound: Bool
    /// When `accessToken` stops working, for an OAuth account whose server gave it a
    /// lifetime; nil when it does not expire on a schedule. Items stored before this field
    /// existed decode as nil (synthesized `Codable` decodes optionals with `decodeIfPresent`).
    public let accessTokenExpiresAt: Date?

    public init(homeserverUrl: String, accessToken: String, sound: Bool, accessTokenExpiresAt: Date? = nil) {
        self.homeserverUrl = homeserverUrl
        self.accessToken = accessToken
        self.sound = sound
        self.accessTokenExpiresAt = accessTokenExpiresAt
    }

    /// The expiry for a value the app sent as epoch milliseconds. Nil for anything that is
    /// not a usable instant, matching the Android store: a missing or non-numeric value, a
    /// boolean (which bridges as an `NSNumber`), a non-finite number and a number below one
    /// once truncated to whole milliseconds, as Android truncates it. A bad value must not
    /// make every push read as expired.
    public static func expiry(fromEpochMilliseconds raw: Any?) -> Date? {
        guard let number = raw as? NSNumber,
              CFGetTypeID(number as CFTypeRef) != CFBooleanGetTypeID()
        else { return nil }
        let milliseconds = number.doubleValue.rounded(.towardZero)
        guard milliseconds.isFinite, milliseconds >= 1 else { return nil }
        return Date(timeIntervalSince1970: milliseconds / 1000)
    }

    /// Whether the token had expired at `now`. A token without an expiry never has.
    public func tokenExpired(at now: Date) -> Bool {
        guard let accessTokenExpiresAt else { return false }
        return now >= accessTokenExpiresAt
    }
}

/// App lock's effective Notification text as the app mirrored it. Missing reads as `show`
/// (nothing written yet); anything unreadable reads as `alwaysHide`, so a damaged file never
/// reveals text.
public enum NotificationTextMode: String, Codable, Equatable {
    case show
    case hideOnLockScreen = "hide-on-lock-screen"
    case alwaysHide = "always-hide"
}

private struct HandoffSettings: Codable {
    let notificationText: NotificationTextMode
}

/// Read side of the push handoff store.
public protocol HandoffReading {
    func account(_ userId: String) -> HandoffAccount?
    func room(_ userId: String, _ roomId: String) -> HandoffRoom?
    /// What a rendered push may show; see ``NotificationTextMode``. No default: every reader,
    /// a wrapper included, must answer, so none can fall open to `show` by forgetting to.
    func notificationText() -> NotificationTextMode
}

public enum PushHandoffStoreError: Error {
    case keychain(OSStatus)
}

/// The push handoff store shared by the app (writes, through the PushHandoff plugin) and the
/// NotificationService extension (reads). Accounts live in the shared keychain access group
/// with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so a locked phone can still render
/// after its first unlock, and an encrypted backup restored onto another phone does not bring
/// the tokens along (the policy the app's own secrets follow). `SecItemUpdate` sets the class
/// too, so an item written with an older class moves over at the next write; the app writes
/// every account when it starts. Room names live in the app-group file `push-handoff/rooms.json`,
/// and App lock's Notification text in `push-handoff/settings.json` beside it; every write
/// keeps that directory out of backups.
/// Reads never throw: a keychain or file error reads as "no account" or "no room", and an
/// unreadable Notification text as `alwaysHide`.
/// Never logs what it stores.
public final class PushHandoffStore: HandoffReading {
    static let service = "dev.trinityproject.trinity.push-handoff"
    let keychainGroup: String
    private let roomsURL: URL
    private let settingsURL: URL
    let queue = DispatchQueue(label: "dev.trinityproject.trinity.push-handoff")

    public init(keychainGroup: String, containerURL: URL) {
        self.keychainGroup = keychainGroup
        let directory = containerURL.appendingPathComponent("push-handoff", isDirectory: true)
        roomsURL = directory.appendingPathComponent("rooms.json")
        settingsURL = directory.appendingPathComponent("settings.json")
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
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
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
            for url in [roomsURL, settingsURL] where FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw PushHandoffStoreError.keychain(status)
            }
        }
    }

    public func setNotificationText(_ mode: NotificationTextMode) throws {
        try queue.sync {
            try write(JSONEncoder().encode(HandoffSettings(notificationText: mode)), to: settingsURL)
        }
    }

    public func notificationText() -> NotificationTextMode {
        queue.sync {
            guard FileManager.default.fileExists(atPath: settingsURL.path) else { return .show }
            guard let data = try? Data(contentsOf: settingsURL),
                  let settings = try? JSONDecoder().decode(HandoffSettings.self, from: data)
            else { return .alwaysHide }
            return settings.notificationText
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
        try write(JSONEncoder().encode(rooms), to: roomsURL)
    }

    private func write(_ data: Data, to url: URL) throws {
        var directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Room and contact names stay on this device: no iCloud or computer backup.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        try data.write(to: url, options: options)
    }
}
