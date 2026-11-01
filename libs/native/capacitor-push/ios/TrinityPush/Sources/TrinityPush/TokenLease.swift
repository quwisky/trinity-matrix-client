import CryptoKit
import Foundation

public struct LeaseTicket: Equatable, Sendable {
    let account: String
    let owner: String
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

/// The lease as a file in the app group, `push-handoff/leases/<sha256 of the user id>.lease`, named
/// by a hash because a user id is not a safe file name. No lock is held at any point: a process
/// suspended holding a file lock is killed with `0xdead10cc`.
///
/// Every change to the name is one atomic `renamex_np`, and a file's contents never change once it
/// has been written. `RENAME_EXCL` creates the name. After that `RENAME_SWAP` replaces what is
/// there, so the name is never empty, not even for a process killed between two steps. A release
/// swaps in a long-expired file, and that file stays until the next take. Only a discard, when the
/// tokens are removed, empties the name; a taker or holder reads that as a free lease.
///
/// Two processes can still both believe they hold the lease until the older one next asks `holds`:
/// - The wall clock jumps forward past a live lease's expiry, so it is taken over as expired.
/// - A holder is suspended past its expiry and carries on when it wakes.
/// - A taker with an old read is killed, or stuck, after swapping out a live lease. Its candidate
///   then keeps the name until that candidate expires, which can be before the holder's own expiry.
///
/// A taker that answers `.busy` claims nothing, has removed its own file, and has left the name
/// holding the file it found, however its swaps interleaved with other takers'. The exception is a
/// taker that dies, has a swap back refused, or stalls past the put-back limit: about 3 s, or the
/// caller's remaining wait if that is shorter, but at least 0.25 s. Other takers then cannot get
/// their files back either, so the live lease can be stranded in a leftover file until the file in
/// the name expires.
public final class AppGroupTokenLease: TokenLease {
    private struct Body: Codable {
        let owner: String
        let expiresAt: Date
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

    private enum Claim {
        case won
        case busy
        case unavailable
    }

    /// Odd: a lone taker whose path holds the live file ends with it back in the name, even if it cannot read.
    private static let putBackSwaps = 201
    private static let putBackPause: useconds_t = 10_000
    /// What a put-back may take past its caller's deadline, and all a release may take. A refresh
    /// can spend it twice, and its 12 s worst case must stay under JavaScript's 13 s call timeout.
    private static let putBackFloor: Duration = .milliseconds(250)

    private let directory: URL
    private let now: @Sendable () -> Date
    private let rename: @Sendable (String, String, UInt32) -> Int32

    public convenience init(containerURL: URL, now: @escaping @Sendable () -> Date = { Date() }) {
        self.init(containerURL: containerURL, now: now, rename: Self.systemRename)
    }

    /// - Parameter rename: `renamex_np`, answering 0 or the errno; a test replaces it to force a race.
    init(
        containerURL: URL, now: @escaping @Sendable () -> Date = { Date() },
        rename: @escaping @Sendable (String, String, UInt32) -> Int32
    ) {
        directory = containerURL.appendingPathComponent("push-handoff/leases", isDirectory: true)
        self.now = now
        self.rename = rename
    }

    static let systemRename: @Sendable (String, String, UInt32) -> Int32 = { from, to, flags in
        renamex_np(from, to, flags) == 0 ? 0 : errno
    }

    public func take(_ account: String, lifetime: TimeInterval, wait: TimeInterval) async -> LeaseTake {
        // Monotonic: the wall clock can jump, and this wait must not.
        let clock = ContinuousClock()
        let deadline = clock.now + .seconds(wait)
        while true {
            let answer = attempt(account, lifetime: lifetime, putBackUntil: deadline)
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
        guard case .contents(let data) = read(leaseURL(ticket.account)), let body = decoded(data) else { return false }
        return body.owner == ticket.owner && body.expiresAt > now()
    }

    public func release(_ ticket: LeaseTicket) {
        let lease = leaseURL(ticket.account)
        guard case .contents(let mine) = read(lease), decoded(mine)?.owner == ticket.owner,
              let expired = writeCandidate(Body(owner: UUID().uuidString, expiresAt: .distantPast), beside: lease)
        else { return }
        _ = replace(lease, seen: mine, with: expired, putBackUntil: .now)
    }

    public func discard(_ ticket: LeaseTicket) {
        let lease = leaseURL(ticket.account)
        guard case .contents(let mine) = read(lease), decoded(mine)?.owner == ticket.owner else { return }
        unlink(lease.path)
    }

    /// Leaves another taker's candidate alone: its rename would otherwise fail as a platform refusal.
    public func discardAll() {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name.hasSuffix(".lease") {
            unlink(directory.appendingPathComponent(name).path)
        }
    }

    /// Reads first, so polling a held lease writes nothing.
    private func attempt(
        _ account: String, lifetime: TimeInterval, putBackUntil limit: ContinuousClock.Instant
    ) -> LeaseTake {
        let lease = leaseURL(account)
        let seen: Data?
        switch read(lease) {
        case .failed:
            return .unavailable
        case .absent:
            seen = nil
        case .contents(let data):
            guard isStale(data) else { return .busy }
            seen = data
        }
        let owner = UUID().uuidString
        // Above the longest lifetime a lease would read as a clock change, and be taken at once.
        let expiresAt = now() + min(lifetime, TokenBudgets.longestLifetime)
        guard let candidate = writeCandidate(Body(owner: owner, expiresAt: expiresAt), beside: lease) else {
            return .unavailable
        }
        switch seen.map({ replace(lease, seen: $0, with: candidate, putBackUntil: limit) })
            ?? create(lease, with: candidate) {
        case .won: return .taken(LeaseTicket(account: account, owner: owner))
        case .busy: return .busy
        case .unavailable: return .unavailable
        }
    }

    private func create(_ lease: URL, with candidate: Candidate) -> Claim {
        let result = rename(candidate.url.path, lease.path, UInt32(RENAME_EXCL))
        if result == 0 { return .won }
        unlink(candidate.url.path)
        return result == EEXIST ? .busy : .unavailable
    }

    /// Swaps `candidate` into the lease's name. Its path then holds what was there, and that is
    /// the only copy: nobody else can get this file, so only one process wins a stale lease.
    private func replace(
        _ lease: URL, seen: Data, with candidate: Candidate, putBackUntil limit: ContinuousClock.Instant
    ) -> Claim {
        let result = rename(candidate.url.path, lease.path, UInt32(RENAME_SWAP))
        guard result == 0 else {
            unlink(candidate.url.path)
            return result == ENOENT ? .busy : .unavailable
        }
        if case .contents(seen) = read(candidate.url) {
            unlink(candidate.url.path)
            return .won
        }
        putBack(lease, candidate, until: limit)
        return .busy
    }

    /// A live holder was swapped out by mistake, so it goes back. Takers doing this at once can
    /// finish in any order and leave one another's files in each other's paths. Each therefore
    /// swaps until its path holds its own file again, and when every taker has its own, the file
    /// left in the lease's name is the live holder's.
    private func putBack(_ lease: URL, _ candidate: Candidate, until limit: ContinuousClock.Instant) {
        let limit = max(limit, ContinuousClock.now + Self.putBackFloor)
        for swap in 1...Self.putBackSwaps {
            guard rename(candidate.url.path, lease.path, UInt32(RENAME_SWAP)) == 0 else { return }
            if case .contents(candidate.contents) = read(candidate.url) {
                unlink(candidate.url.path)
                return
            }
            // Only on an odd swap, for the reason at `putBackSwaps`.
            if !swap.isMultiple(of: 2), ContinuousClock.now >= limit { break }
            // This taker's file is in another's path, so swapping again cannot help until that one
            // runs. Without a pause the swaps run out while it is off the CPU for about 2 ms.
            usleep(Self.putBackPause)
        }
        // shortcut: a taker dead or stalled past the limit can strand the live lease until the file
        // in the name expires, and what is in this path stays behind as one small file. If devices
        // show that, move to generation-named files made with `RENAME_EXCL`, which never swap a
        // live lease out.
    }

    private func writeCandidate(_ body: Body, beside lease: URL) -> Candidate? {
        let url = lease.appendingPathExtension(UUID().uuidString)
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

    /// Undecodable, expired, or further ahead than any lease can be, which means the clock moved
    /// back: such a lease must not look held for hours.
    private func isStale(_ data: Data) -> Bool {
        guard let body = decoded(data) else { return true }
        let now = now()
        return body.expiresAt <= now || body.expiresAt > now + TokenBudgets.longestLifetime
    }

    private func leaseURL(_ account: String) -> URL {
        let hash = SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(hash + ".lease")
    }
}
