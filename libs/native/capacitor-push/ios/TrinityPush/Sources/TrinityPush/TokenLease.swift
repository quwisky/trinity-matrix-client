import CryptoKit
import Foundation

public struct LeaseTicket: Equatable, Sendable {
    let account: String
    let owner: String
}

/// Stops the app and the notification process refreshing one account at once. A lease can lapse
/// while its holder is suspended, so a holder still compares before it writes.
public protocol TokenLease: Sendable {
    /// Nil when the lease stayed busy for `wait` seconds, or the waiting task was cancelled.
    func take(_ account: String, lifetime: TimeInterval, wait: TimeInterval) async -> LeaseTicket?
    func holds(_ ticket: LeaseTicket) -> Bool
    func release(_ ticket: LeaseTicket)
}

/// The lease as a file in the app group, `push-handoff/leases/<sha256 of the user id>.lease`, named
/// by a hash because a user id is not a safe file name. No lock is held at any point: a process
/// suspended holding a file lock is killed with `0xdead10cc`.
///
/// Every step is one atomic system call on a private name. `link` publishes a complete file and
/// fails if the lease exists; `rename` moves the lease out of the way for exactly one process.
public final class AppGroupTokenLease: TokenLease {
    private struct Body: Codable {
        let owner: String
        let expiresAt: Date
    }

    private let directory: URL
    private let now: @Sendable () -> Date

    public init(containerURL: URL, now: @escaping @Sendable () -> Date = { Date() }) {
        directory = containerURL.appendingPathComponent("push-handoff/leases", isDirectory: true)
        self.now = now
    }

    public func take(_ account: String, lifetime: TimeInterval, wait: TimeInterval) async -> LeaseTicket? {
        // Monotonic: the wall clock can jump, and this wait must not.
        let clock = ContinuousClock()
        let deadline = clock.now + .seconds(wait)
        var justTookOver = false
        while true {
            let owner = UUID().uuidString
            if create(account, owner: owner, lifetime: lifetime) {
                return LeaseTicket(account: account, owner: owner)
            }
            let seen = read(leaseURL(account))
            if !justTookOver, isStale(seen) {
                takeOver(account, seenOwner: seen?.owner)
                justTookOver = true
                continue
            }
            justTookOver = false
            let left = clock.now.duration(to: deadline)
            guard left > .zero else { return nil }
            do {
                try await clock.sleep(for: min(left, .milliseconds(50)))
            } catch {
                return nil
            }
        }
    }

    public func holds(_ ticket: LeaseTicket) -> Bool {
        guard let body = read(leaseURL(ticket.account)) else { return false }
        return body.owner == ticket.owner && body.expiresAt > now()
    }

    public func release(_ ticket: LeaseTicket) {
        guard read(leaseURL(ticket.account))?.owner == ticket.owner else { return }
        // Not a plain unlink: the lease may have passed to another holder since that read.
        takeOver(ticket.account, seenOwner: ticket.owner)
    }

    /// Removes the lease if it is still the one seen. `rename` gives this process alone the file
    /// to compare, so a fresh holder that took the lease since the read is put back, not deleted.
    /// The lease is absent for the microseconds that takes; two holders there are safe, because
    /// a holder compares before it writes.
    func takeOver(_ account: String, seenOwner: String?) {
        let lease = leaseURL(account)
        let moved = privateName(for: lease)
        guard rename(lease.path, moved.path) == 0 else { return }
        defer { unlink(moved.path) }
        if read(moved)?.owner != seenOwner {
            link(moved.path, lease.path)
        }
    }

    private func create(_ account: String, owner: String, lifetime: TimeInterval) -> Bool {
        let lease = leaseURL(account)
        let temporary = privateName(for: lease)
        // shortcut: a process killed before this unlink leaves one small file behind, sweep the
        // directory if that ever shows up on a real device.
        defer { unlink(temporary.path) }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var excluded = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try excluded.setResourceValues(values)
            var options: Data.WritingOptions = []
            #if os(iOS)
            options.insert(.completeFileProtectionUntilFirstUserAuthentication)
            #endif
            let body = Body(owner: owner, expiresAt: now() + lifetime)
            try JSONEncoder().encode(body).write(to: temporary, options: options)
        } catch {
            return false
        }
        return link(temporary.path, lease.path) == 0
    }

    private func read(_ url: URL) -> Body? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Body.self, from: data)
    }

    /// Unreadable, expired, or further ahead than any lease can be, which means the clock moved
    /// back: such a lease must not look held for hours.
    private func isStale(_ body: Body?) -> Bool {
        guard let body else { return true }
        let now = now()
        return body.expiresAt <= now || body.expiresAt > now + TokenBudgets.longestLifetime
    }

    private func leaseURL(_ account: String) -> URL {
        let hash = SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(hash + ".lease")
    }

    private func privateName(for lease: URL) -> URL {
        lease.appendingPathExtension(UUID().uuidString)
    }
}
