import Foundation
import Security

/// OAuth token records in the shared keychain group, beside the handoff accounts but under their
/// own service. `AfterFirstUnlockThisDeviceOnly`: a locked phone can refresh after its first
/// unlock, and a restored backup does not carry the tokens.
extension PushHandoffStore: TokenVault {
    static let tokenService = "dev.trinityproject.trinity.push-tokens"

    public func read(_ userId: String) -> TokenVaultRead {
        queue.sync {
            var query = tokenQuery(userId)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            return .from(status: status, data: result as? Data)
        }
    }

    public func write(_ record: TokenRecord, for userId: String) -> Bool {
        guard let attributes = tokenAttributes(record) else { return false }
        return queue.sync {
            let query = tokenQuery(userId)
            var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(tokenItem(userId, attributes) as CFDictionary, nil)
            }
            return status == errSecSuccess
        }
    }

    public func update(_ record: TokenRecord, for userId: String) -> TokenVaultWrite {
        guard let attributes = tokenAttributes(record) else { return .failed }
        return queue.sync {
            switch SecItemUpdate(tokenQuery(userId) as CFDictionary, attributes as CFDictionary) {
            case errSecSuccess: .written
            case errSecItemNotFound: .absent
            default: .failed
            }
        }
    }

    public func remove(_ userId: String) -> Bool { delete(tokenQuery(userId)) }

    public func removeAll() -> Bool { delete(tokenQuery(nil)) }

    private func delete(_ query: [String: Any]) -> Bool {
        queue.sync {
            let status = SecItemDelete(query as CFDictionary)
            return status == errSecSuccess || status == errSecItemNotFound
        }
    }

    func tokenAttributes(_ record: TokenRecord) -> [String: Any]? {
        guard let data = try? JSONEncoder().encode(record) else { return nil }
        return [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
    }

    /// What `SecItemAdd` gets.
    func tokenItem(_ userId: String, _ attributes: [String: Any]) -> [String: Any] {
        tokenQuery(userId).merging(attributes) { $1 }
    }

    func tokenQuery(_ userId: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.tokenService,
            kSecAttrAccessGroup as String: keychainGroup,
        ]
        if let userId { query[kSecAttrAccount as String] = userId }
        return query
    }
}
