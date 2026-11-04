import Foundation
import TrinityPush

/// The two sides of a race over one account: the real refresher, lease, grant client and renderer,
/// over a file standing in for the keychain, which a macOS tool without entitlements cannot share.
/// Each prints `ready` and then acts on a line from stdin, so a test can start them together.
/// Prints outcomes only, never a token.

private func say(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

/// One account's record in one file. Writes are atomic, as a keychain item's are.
/// `stopsAfterFirstRead` freezes this process after its first read, which in the app is the one under
/// the lease, before any grant.
private final class FileVault: TokenVault, @unchecked Sendable {
    let file: URL
    private var stopsAfterRead: Bool

    init(container: String, stopsAfterFirstRead: Bool = false) {
        file = URL(fileURLWithPath: container).appendingPathComponent("vault.json")
        stopsAfterRead = stopsAfterFirstRead
    }

    func read(_ userId: String) -> TokenVaultRead {
        let answer: TokenVaultRead
        do {
            answer = .record(try JSONDecoder().decode(TokenRecord.self, from: Data(contentsOf: file)))
        } catch CocoaError.fileReadNoSuchFile {
            answer = .absent
        } catch {
            answer = .unavailable
        }
        if stopsAfterRead {
            stopsAfterRead = false
            say("read")
            raise(SIGSTOP)
        }
        return answer
    }

    func write(_ record: TokenRecord, for userId: String) -> Bool {
        guard let data = try? JSONEncoder().encode(record) else { return false }
        return (try? data.write(to: file, options: .atomic)) != nil
    }

    func update(_ record: TokenRecord, for userId: String) -> TokenVaultWrite {
        guard FileManager.default.fileExists(atPath: file.path) else { return .absent }
        return write(record, for: userId) ? .written : .failed
    }

    func remove(_ userId: String) -> Bool { (try? FileManager.default.removeItem(at: file)) != nil }
    func removeAll() -> Bool { remove("") }
    func accounts() -> [String]? { nil }
}

/// The handoff entry an OAuth account has: no token of its own, overlaid by the vault on every read.
private struct FileHandoff: HandoffReading {
    let vault: FileVault
    let homeserver: String

    func account(_ userId: String) -> HandoffAccount? {
        HandoffAccount(homeserverUrl: homeserver, accessToken: "", sound: true).overlaid(by: vault.read(userId))
    }

    func room(_ userId: String, _ roomId: String) -> HandoffRoom? {
        HandoffRoom(name: "Team", direct: false, encrypted: false)
    }

    func notificationText() -> NotificationTextMode { .show }
}

/// The real lease, able to play a suspended process: a short lifetime lapses without a long test,
/// and `stopsHolding` freezes this process, for real, the moment it holds the lease.
private final class ProbeLease: TokenLease {
    private let lease: AppGroupTokenLease
    private let lifetime: TimeInterval?
    private let stopsHolding: Bool

    init(container: String, lifetime: TimeInterval?, stopsHolding: Bool) {
        lease = AppGroupTokenLease(containerURL: URL(fileURLWithPath: container))
        self.lifetime = lifetime
        self.stopsHolding = stopsHolding
    }

    func take(_ account: String, lifetime asked: TimeInterval, wait: TimeInterval) async -> LeaseTake {
        let answer = await lease.take(account, lifetime: lifetime ?? asked, wait: wait)
        if stopsHolding, case .taken = answer {
            say("holding")
            raise(SIGSTOP)
        }
        return answer
    }

    func holds(_ ticket: LeaseTicket) -> Bool { lease.holds(ticket) }
    func release(_ ticket: LeaseTicket) { lease.release(ticket) }
    func discard(_ ticket: LeaseTicket) { lease.discard(ticket) }
    func discardAll() { lease.discardAll() }
}

/// waiter <container> <account> <lifetime> <wait>: prints `waiting` only after finding the lease
/// held, so a test knows this process really waits, then the answer. Exits without releasing.
func runWaiter(_ arguments: [String]) async {
    let lease = AppGroupTokenLease(containerURL: URL(fileURLWithPath: arguments[0]))
    let lifetime = Double(arguments[2])!
    guard await lease.take(arguments[1], lifetime: lifetime, wait: 0) == .busy else { return say("taken") }
    say("waiting")
    if case .taken = await lease.take(arguments[1], lifetime: lifetime, wait: Double(arguments[3])!) {
        say("taken")
    } else {
        say("busy")
    }
}

/// stalled-taker <container> <account> <lifetime>: prints `read` at its first rename, having read
/// the lease, waits for a line, renames, and dies at once, as a taker killed mid-take does.
func runStalledTaker(_ arguments: [String]) async {
    let lease = AppGroupTokenLease(containerURL: URL(fileURLWithPath: arguments[0]), rename: { from, to, flags in
        say("read")
        _ = readLine()
        _ = AppGroupTokenLease.systemRename(from, to, flags)
        _exit(0)
    })
    _ = await lease.take(arguments[1], lifetime: Double(arguments[2])!, wait: 0)
}

/// app <container> <account> <tokenSeen> [<lease lifetime> [stop|stop-after-read]]: one refresh,
/// and its answer. `stop` freezes it on taking the lease, `stop-after-read` once it has read the
/// vault under it.
func runApp(_ arguments: [String]) async {
    let stop = arguments.count > 4 ? arguments[4] : nil
    let refresher = TokenRefresher(
        vault: FileVault(container: arguments[0], stopsAfterFirstRead: stop == "stop-after-read"),
        lease: ProbeLease(
            container: arguments[0], lifetime: arguments.count > 3 ? Double(arguments[3]) : nil,
            stopsHolding: stop == "stop"),
        client: URLSessionTokenGrantClient())
    say("ready")
    _ = readLine()
    say("\(await refresher.refresh(account: arguments[1], lineage: "L", tokenSeen: arguments[2], budget: TokenBudgets.appGrant))")
}

/// push <container> <account> <homeserver> [<clock offset>]: one rendered body per line of stdin.
/// One process, one refresher, because iOS reuses a notification process for later pushes. The
/// offset moves this process's wall clock, as a clock change does after another took the lease;
/// the lease reads no wall clock.
func runPush(_ arguments: [String]) async {
    let vault = FileVault(container: arguments[0])
    let store = FileHandoff(vault: vault, homeserver: arguments[2])
    let offset = arguments.count > 3 ? Double(arguments[3])! : 0
    let wallClock: @Sendable () -> Date = { Date() + offset }
    let refresher = TokenRefresher(
        vault: vault, lease: AppGroupTokenLease(containerURL: URL(fileURLWithPath: arguments[0])),
        client: URLSessionTokenGrantClient(), now: wallClock)
    let userInfo: [AnyHashable: Any] = ["trinity_user_id": arguments[1], "room_id": "!r:hs", "event_id": "$e"]
    say("ready")
    while readLine() != nil {
        let render = PushRender(userInfo: userInfo, store: store, api: URLSessionMatrixPushAPI(), tokens: refresher)
        say(await render?.resolve().body ?? "unchanged")
    }
}
