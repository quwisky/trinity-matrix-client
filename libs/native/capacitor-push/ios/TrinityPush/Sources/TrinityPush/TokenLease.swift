import CryptoKit
import Foundation

public struct LeaseTicket: Equatable, Sendable {
    let account: String
    let owner: String
    let generation: UInt64

    init(account: String, owner: String, generation: UInt64 = 0) {
        self.account = account
        self.owner = owner
        self.generation = generation
    }
}

public enum LeaseTake: Equatable, Sendable {
    case taken(LeaseTicket)
    /// Another holder kept it for the whole wait, or the waiting task was cancelled. This taker
    /// claims nothing; ``AppGroupTokenLease`` says what else holds, and when it does not.
    case busy
    /// The platform refused a file operation, which is not contention: waiting would not help.
    case unavailable
}

/// Stops the app and the notification process refreshing one account at once. Two holders are
/// still possible (see ``AppGroupTokenLease``), so a holder compares before it writes.
public protocol TokenLease: Sendable {
    func take(_ account: String, lifetime: TimeInterval, wait: TimeInterval) async -> LeaseTake
    func holds(_ ticket: LeaseTicket) -> Bool
    func release(_ ticket: LeaseTicket)
    /// Releases and leaves nothing behind, for an account whose tokens are going.
    func discard(_ ticket: LeaseTicket)
    /// Every account's lease, held or not.
    func discardAll()
}

/// The lease as numbered files in the app group, `push-handoff/leases/<sha256 of the user id>.<n>.lease`,
/// named by a hash because a user id is not a safe file name. The highest number is the lease. No
/// lock is held at any point: a process suspended holding a file lock is killed with `0xdead10cc`.
///
/// A file's contents never change once it has been written, and a number is claimed once, with
/// `RENAME_EXCL`: a taker that finds `n` expired claims `n + 1`, and of several such takers one
/// gets it. Nothing ever moves a live lease out of its name, so a taker killed or stalled at any
/// point can strand nothing. A taker whose read was so old that it claims a number below the lease
/// sees the higher one when it lists again, removes its own file and answers `.busy`. A release
/// claims the next number with an expired file, so when a taker got there first the release does
/// nothing. The winner of `n` removes the files below it.
///
/// Expiry runs on the system's continuous clock, which every process shares, which counts time
/// asleep, and which no one can set: a wall-clock change cannot make a live lease look expired, and
/// a holder suspended past its expiry no longer holds it when it wakes. A restart begins it again
/// near zero, so an older lease reads as further ahead than any lease can be, and is stale.
///
/// What is left: a holder learns it lost the lease only when it next asks `holds`, which the
/// refresher does just before it sends a grant. A holder suspended from that check until its answer
/// is written lets the lease lapse while its grant is in flight, and another process can then read
/// the unchanged vault and send the same refresh token. Compare-before-write keeps the vault
/// consistent, but the provider has seen the token twice; only the provider can fence that. The app
/// starts a grant only with background time (`mayStartAppGrant`), and iOS ends the extension rather
/// than suspending it, which is the lost answer instead. And a discard empties the
/// names, so numbering starts again: a taker with a read from before the discard can then claim a
/// number above a new holder's. A discard removes the account's tokens, so neither has any to send.
public final class AppGroupTokenLease: TokenLease {
    private struct Body: Codable {
        let owner: String
        /// Seconds of the continuous clock.
        let expiresAt: TimeInterval
    }

    private struct Candidate {
        let url: URL
        let contents: Data
    }

    private enum LeaseRead {
        case absent
        case contents(Data)
        case failed
    }

    private let directory: URL
    private let uptime: @Sendable () -> TimeInterval
    private let rename: @Sendable (String, String, UInt32) -> Int32

    public convenience init(containerURL: URL) {
        self.init(containerURL: containerURL, uptime: Self.continuousUptime, rename: Self.systemRename)
    }

    /// - Parameter rename: `renamex_np`, answering 0 or the errno; a test replaces it to force a race.
    package init(
        containerURL: URL, uptime: @escaping @Sendable () -> TimeInterval = AppGroupTokenLease.continuousUptime,
        rename: @escaping @Sendable (String, String, UInt32) -> Int32 = AppGroupTokenLease.systemRename
    ) {
        directory = containerURL.appendingPathComponent("push-handoff/leases", isDirectory: true)
        self.uptime = uptime
        self.rename = rename
    }

    package static let systemRename: @Sendable (String, String, UInt32) -> Int32 = { from, to, flags in
        renamex_np(from, to, flags) == 0 ? 0 : errno
    }

    /// Since boot, counting sleep, never adjusted: the same value in every process.
    package static let continuousUptime: @Sendable () -> TimeInterval = {
        TimeInterval(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1_000_000_000
    }

    public func take(_ account: String, lifetime: TimeInterval, wait: TimeInterval) async -> LeaseTake {
        // Monotonic: the wall clock can jump, and this wait must not.
        let clock = ContinuousClock()
        let deadline = clock.now + .seconds(wait)
        while true {
            let answer = attempt(account, lifetime: lifetime)
            guard answer == .busy else { return answer }
            let left = clock.now.duration(to: deadline)
            guard left > .zero else { return .busy }
            do {
                try await clock.sleep(for: min(left, .milliseconds(50)))
            } catch {
                return .busy
            }
        }
    }

    public func holds(_ ticket: LeaseTicket) -> Bool {
        guard generations(ticket.account)?.max() == ticket.generation,
              case .contents(let data) = read(leaseURL(ticket.account, ticket.generation)),
              let body = decoded(data)
        else { return false }
        return body.owner == ticket.owner && !isStale(body)
    }

    public func release(_ ticket: LeaseTicket) {
        guard isNewest(ticket),
              let expired = writeCandidate(Body(owner: UUID().uuidString, expiresAt: 0), for: ticket.account)
        else { return }
        if rename(expired.url.path, leaseURL(ticket.account, ticket.generation + 1).path, UInt32(RENAME_EXCL)) != 0 {
            unlink(expired.url.path)
        }
    }

    public func discard(_ ticket: LeaseTicket) {
        guard isNewest(ticket), let all = generations(ticket.account) else { return }
        for generation in all { unlink(leaseURL(ticket.account, generation).path) }
    }

    /// Leaves another taker's candidate alone: its rename would otherwise fail as a platform refusal.
    public func discardAll() {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name.hasSuffix(".lease") {
            unlink(directory.appendingPathComponent(name).path)
        }
    }

    /// Reads first, so polling a held lease writes nothing.
    private func attempt(_ account: String, lifetime: TimeInterval) -> LeaseTake {
        guard let found = generations(account) else { return .unavailable }
        let seen = found.max() ?? 0
        if seen > 0 {
            switch read(leaseURL(account, seen)) {
            case .failed: return .unavailable
            // Removed by the taker of a higher number since the listing.
            case .absent: return .busy
            case .contents(let data):
                guard decoded(data).map(isStale) ?? true else { return .busy }
            }
        }
        let owner = UUID().uuidString
        // Above the longest lifetime a lease would read as a restart, and be taken at once.
        let expiresAt = uptime() + min(lifetime, TokenBudgets.longestLifetime)
        guard let candidate = writeCandidate(Body(owner: owner, expiresAt: expiresAt), for: account) else {
            return .unavailable
        }
        let claimed = leaseURL(account, seen + 1)
        let result = rename(candidate.url.path, claimed.path, UInt32(RENAME_EXCL))
        guard result == 0 else {
            unlink(candidate.url.path)
            return result == EEXIST ? .busy : .unavailable
        }
        guard let all = generations(account) else {
            unlink(claimed.path)
            return .unavailable
        }
        guard all.max() == seen + 1 else {
            unlink(claimed.path)
            return .busy
        }
        for generation in all where generation <= seen { unlink(leaseURL(account, generation).path) }
        removeOrphanedCandidates(account)
        return .taken(LeaseTicket(account: account, owner: owner, generation: seen + 1))
    }

    /// The ticket's file is still the newest and still its owner's, expired or not.
    private func isNewest(_ ticket: LeaseTicket) -> Bool {
        guard generations(ticket.account)?.max() == ticket.generation,
              case .contents(let data) = read(leaseURL(ticket.account, ticket.generation))
        else { return false }
        return decoded(data)?.owner == ticket.owner
    }

    /// A taker killed between writing its candidate and claiming leaves it. One that old can't be
    /// in use: no take lasts longer than a lease. The wall clock is enough for tidying.
    private func removeOrphanedCandidates(_ account: String) {
        let prefix = Self.hash(account) + ".lease."
        let cutoff = Date().addingTimeInterval(-TokenBudgets.longestLifetime)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name.hasPrefix(prefix) {
            let path = directory.appendingPathComponent(name).path
            guard let modified = (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date,
                  modified < cutoff
            else { continue }
            unlink(path)
        }
    }

    /// The account's lease numbers, empty when there are none; nil when the directory can't be listed.
    private func generations(_ account: String) -> [UInt64]? {
        let prefix = Self.hash(account) + "."
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        } catch CocoaError.fileReadNoSuchFile {
            return []
        } catch {
            return nil
        }
        return names.compactMap { name in
            guard name.hasPrefix(prefix), name.hasSuffix(".lease") else { return nil }
            return UInt64(name.dropFirst(prefix.count).dropLast(".lease".count))
        }
    }

    private func writeCandidate(_ body: Body, for account: String) -> Candidate? {
        let url = directory.appendingPathComponent(Self.hash(account) + ".lease." + UUID().uuidString)
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
            let contents = try JSONEncoder().encode(body)
            try contents.write(to: url, options: options)
            return Candidate(url: url, contents: contents)
        } catch {
            unlink(url.path)
            return nil
        }
    }

    /// Only a missing file is absent: any other failure (EMFILE, EIO, a locked phone) says nothing
    /// about the lease, which may be live.
    private func read(_ url: URL) -> LeaseRead {
        do {
            return .contents(try Data(contentsOf: url))
        } catch CocoaError.fileReadNoSuchFile {
            return .absent
        } catch {
            return .failed
        }
    }

    private func decoded(_ data: Data) -> Body? {
        try? JSONDecoder().decode(Body.self, from: data)
    }

    /// Expired, or further ahead than any lease can be, which means the device restarted.
    private func isStale(_ body: Body) -> Bool {
        let now = uptime()
        return body.expiresAt <= now || body.expiresAt > now + TokenBudgets.longestLifetime
    }

    private func leaseURL(_ account: String, _ generation: UInt64) -> URL {
        directory.appendingPathComponent("\(Self.hash(account)).\(generation).lease")
    }

    private static func hash(_ account: String) -> String {
        SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
