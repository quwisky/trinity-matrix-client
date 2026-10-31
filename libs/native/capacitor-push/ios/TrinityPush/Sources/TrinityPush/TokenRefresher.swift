import Foundation

/// What a push renderer may do with an account's tokens.
public protocol PushTokenRefreshing: Sendable {
    func refreshForPush(account: String, tokenSeen: String, budget: TimeInterval) async -> TokenRefreshResult
}

/// The one place an account's tokens rotate. The order of `refreshUnderLease` is what keeps someone
/// signed in: read under the lease, send what was read, compare again before any write. Failures
/// are answers, and nothing here throws. Logs nothing.
public final class TokenRefresher: PushTokenRefreshing, @unchecked Sendable {
    private struct Unsaved {
        let base: TokenRecord
        let next: TokenRecord
    }

    private static let retakeFloor: TimeInterval = 1
    private static let shared: TokenRefresher? = {
        guard let store = PushHandoffStore.fromMainBundle(),
              let appGroup = Bundle.main.object(forInfoDictionaryKey: "TrinityAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else { return nil }
        return TokenRefresher(
            vault: store, lease: AppGroupTokenLease(containerURL: container), client: URLSessionTokenGrantClient())
    }()

    private let vault: TokenVault
    private let lease: TokenLease
    private let client: TokenGrantClient
    private let now: @Sendable () -> Date
    private let pendingLock = NSLock()
    // A pair the vault would not take. It lives as long as this process, and `current` reads it
    // without the lease.
    private var pending: [String: Unsaved] = [:]

    public init(
        vault: TokenVault, lease: TokenLease, client: TokenGrantClient, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.vault = vault
        self.lease = lease
        self.client = client
        self.now = now
    }

    /// One instance per process: every caller in it must see the same unsaved pair.
    public static func fromMainBundle() -> TokenRefresher? { shared }

    /// A grant spends the refresh token. If the app suspends before the answer arrives the answer
    /// is lost, the next refresh is refused, and that signs the account out.
    public static func mayStartAppGrant(hasBackgroundTime: Bool, appIsActive: Bool) -> Bool {
        hasBackgroundTime || appIsActive
    }

    public func refresh(
        account: String, lineage: String, tokenSeen: String, budget: TimeInterval
    ) async -> TokenRefreshResult {
        await refreshUnderLease(account, lineage, tokenSeen, budget, recordsRefusal: true)
    }

    /// Only the app records a refusal. A lapsed lease lets a push reuse a token the suspended app
    /// already spent, and a provider with no reuse tolerance refuses it though the session is fine.
    public func refreshForPush(account: String, tokenSeen: String, budget: TimeInterval) async -> TokenRefreshResult {
        switch vault.read(account) {
        case .absent: return .gone
        case .unavailable: return .transient
        case .record(let record):
            return await refreshUnderLease(account, record.lineage, tokenSeen, budget, recordsRefusal: false)
        }
    }

    private func refreshUnderLease(
        _ account: String, _ lineage: String, _ tokenSeen: String, _ budget: TimeInterval, recordsRefusal: Bool
    ) async -> TokenRefreshResult {
        let deadline = now().addingTimeInterval(budget)
        var ticket: LeaseTicket
        switch await lease.take(account, lifetime: budget + TokenBudgets.leaseMargin, wait: budget) {
        case .taken(let taken): ticket = taken
        case .busy: return .busy
        case .unavailable: return .transient
        }
        defer { lease.release(ticket) }
        flushPending(account)
        let onDisk: TokenRecord
        switch vault.read(account) {
        case .absent: return .gone
        case .unavailable: return .transient
        case .record(let read): onDisk = read
        }
        // A write that still fails: the unsaved pair stays the truth here.
        let record = unsaved(account)?.next ?? onDisk
        if record.lineage != lineage { return .gone }
        if record.state == .refused { return .refused }
        if record.accessToken != tokenSeen { return .current(record) }
        guard record.refreshToken != nil, record.tokenEndpoint != nil, record.clientId != nil else {
            return .unavailable
        }
        let started = now()
        switch await client.grant(record, deadline: deadline) {
        case .failed:
            return .transient
        case .refused:
            // After a lapse the refusal may be another process's overlap: only the next try can tell.
            if recordsRefusal && !lease.holds(ticket) { return .transient }
            guard let retaken = await retake(ticket, account, deadline) else { return .transient }
            ticket = retaken
            switch vault.read(account) {
            case .absent: return .gone
            case .unavailable: return .transient
            case .record(let stored):
                guard stored.samePair(as: onDisk), stored.lineage == lineage else {
                    return storedOrGone(stored, lineage)
                }
                if recordsRefusal {
                    _ = vault.update(stored.marked(.refused), for: account)
                    // A later flush must not overwrite the refused state.
                    clearPending(account)
                }
                return .refused
            }
        case .tokens(let access, let refresh, let expiresIn):
            let next = record.rotated(access, refresh, expiresAt: expiresIn.map { started.addingTimeInterval($0) })
            // Tokens in hand are never dropped: without the lease, still compare and write. The old
            // token is spent, and a writer racing this compare is far rarer than losing the answer.
            if let retaken = await retake(ticket, account, deadline) { ticket = retaken }
            switch vault.read(account) {
            case .absent: return .gone
            case .unavailable: return keepUnsaved(account, base: onDisk, next)
            case .record(let stored):
                // Discard the late answer.
                guard stored.samePair(as: onDisk), stored.lineage == lineage else {
                    return storedOrGone(stored, lineage)
                }
                // Update-only: never recreates a removed record.
                switch vault.update(next, for: account) {
                case .written:
                    clearPending(account)
                    return .rotated(next, unsaved: false)
                case .absent: return .gone
                case .failed: return keepUnsaved(account, base: onDisk, next)
                }
            }
        }
    }

    public func current(account: String, lineage: String) async -> TokenRefreshResult {
        if unsaved(account) != nil, case .taken(let ticket) = await lease.take(
            account, lifetime: TokenBudgets.leaseMargin, wait: TokenBudgets.removalWait) {
            flushPending(account)
            lease.release(ticket)
        }
        if let next = unsaved(account)?.next, next.lineage == lineage { return .current(next) }
        switch vault.read(account) {
        case .absent: return .gone
        case .unavailable: return .transient
        case .record(let record):
            if record.lineage != lineage { return .gone }
            return record.state == .refused ? .refused : .current(record)
        }
    }

    /// False means nothing was stored. A record of this lineage that has a refresh token stays:
    /// it may be newer.
    public func migrate(_ record: TokenRecord, for account: String) async -> Bool {
        await migrateRevokingOverwritten(record, for: account).stored
    }

    /// `revocation` is the unawaited revoke of an overwritten pair, if one started.
    func migrateRevokingOverwritten(
        _ record: TokenRecord, for account: String
    ) async -> (stored: Bool, revocation: Task<Void, Never>?) {
        guard case .taken(let ticket) = await lease.take(
            account, lifetime: TokenBudgets.appGrant + TokenBudgets.leaseMargin, wait: TokenBudgets.appGrant)
        else { return (false, nil) }
        let overwritten: TokenRecord?
        do {
            defer { lease.release(ticket) }
            switch vault.read(account) {
            case .unavailable: return (false, nil)
            case .absent: overwritten = nil
            case .record(let stored):
                if stored.lineage == record.lineage && stored.refreshToken != nil { return (true, nil) }
                overwritten = stored
            }
            guard vault.write(record, for: account) else { return (false, nil) }
        }
        if let overwritten, overwritten.refreshToken != nil, overwritten.deviceId != record.deviceId,
           !overwritten.samePair(as: record) {
            let deadline = now().addingTimeInterval(TokenBudgets.revokeRequest)
            return (true, Task { [client] in _ = await client.revoke(overwritten, deadline: deadline) })
        }
        return (true, nil)
    }

    public func revoke(account: String, lineage: String) async -> TokenRevokeResult {
        guard case .taken(let ticket) = await lease.take(
            account, lifetime: TokenBudgets.revokeRequest + TokenBudgets.leaseMargin, wait: TokenBudgets.revokeWait)
        else { return .transient }
        defer { lease.release(ticket) }
        flushPending(account)
        var record: TokenRecord
        switch vault.read(account) {
        case .absent: return .gone
        case .unavailable: return .transient
        case .record(let stored): record = stored
        }
        if let next = unsaved(account)?.next, next.lineage == lineage { record = next }
        guard record.lineage == lineage, record.revocationEndpoint != nil, record.clientId != nil else { return .gone }
        let revoked = await client.revoke(record, deadline: now().addingTimeInterval(TokenBudgets.revokeRequest))
        return revoked ? .revoked : .transient
    }

    /// One account, or every record when `account` is nil. Deletes even when the lease stays busy.
    public func remove(account: String?) async -> Bool {
        guard let account else {
            pendingLock.withLock { pending.removeAll() }
            defer { lease.discardAll() }
            return vault.removeAll()
        }
        let take = await lease.take(account, lifetime: TokenBudgets.leaseMargin, wait: TokenBudgets.removalWait)
        defer { if case .taken(let ticket) = take { lease.discard(ticket) } }
        clearPending(account)
        return vault.remove(account)
    }

    /// A stored pair still equal to the unsaved pair's base gets the unsaved pair.
    private func flushPending(_ account: String) {
        guard let unsaved = unsaved(account) else { return }
        switch vault.read(account) {
        case .absent:
            clearPending(account)
        case .unavailable:
            break
        case .record(let stored):
            let stillTheBase = stored.samePair(as: unsaved.base) && stored.lineage == unsaved.base.lineage
            if !stillTheBase || vault.update(unsaved.next, for: account) != .failed { clearPending(account) }
        }
    }

    private func retake(_ ticket: LeaseTicket, _ account: String, _ deadline: Date) async -> LeaseTicket? {
        if lease.holds(ticket) { return ticket }
        let wait = max(deadline.timeIntervalSince(now()), Self.retakeFloor)
        guard case .taken(let retaken) = await lease.take(
            account, lifetime: wait + TokenBudgets.leaseMargin, wait: wait)
        else { return nil }
        return retaken
    }

    private func storedOrGone(_ stored: TokenRecord, _ lineage: String) -> TokenRefreshResult {
        stored.lineage == lineage ? .current(stored) : .gone
    }

    private func keepUnsaved(_ account: String, base: TokenRecord, _ next: TokenRecord) -> TokenRefreshResult {
        pendingLock.withLock { pending[account] = Unsaved(base: base, next: next) }
        return .rotated(next, unsaved: true)
    }

    private func unsaved(_ account: String) -> Unsaved? {
        pendingLock.withLock { pending[account] }
    }

    private func clearPending(_ account: String) {
        _ = pendingLock.withLock { pending.removeValue(forKey: account) }
    }
}
