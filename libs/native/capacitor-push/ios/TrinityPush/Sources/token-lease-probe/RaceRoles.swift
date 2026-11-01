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
private struct FileVault: TokenVault {
    let file: URL

    init(container: String) {
        file = URL(fileURLWithPath: container).appendingPathComponent("vault.json")
    }

    func read(_ userId: String) -> TokenVaultRead {
        do {
            return .record(try JSONDecoder().decode(TokenRecord.self, from: Data(contentsOf: file)))
        } catch CocoaError.fileReadNoSuchFile {
            return .absent
        } catch {
            return .unavailable
        }
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

/// app <container> <account> <tokenSeen> [<lease lifetime> [stop]]: one refresh, and its answer.
func runApp(_ arguments: [String]) async {
    let refresher = TokenRefresher(
        vault: FileVault(container: arguments[0]),
        lease: ProbeLease(
            container: arguments[0], lifetime: arguments.count > 3 ? Double(arguments[3]) : nil,
            stopsHolding: arguments.count > 4),
        client: URLSessionTokenGrantClient())
    say("ready")
    _ = readLine()
    say("\(await refresher.refresh(account: arguments[1], lineage: "L", tokenSeen: arguments[2], budget: TokenBudgets.appGrant))")
}

/// push <container> <account> <homeserver>: one rendered body per line of stdin. One process, one
/// refresher, because iOS reuses a notification process for later pushes.
func runPush(_ arguments: [String]) async {
    let vault = FileVault(container: arguments[0])
    let store = FileHandoff(vault: vault, homeserver: arguments[2])
    let refresher = TokenRefresher(
        vault: vault, lease: AppGroupTokenLease(containerURL: URL(fileURLWithPath: arguments[0])),
        client: URLSessionTokenGrantClient())
    let userInfo: [AnyHashable: Any] = ["trinity_user_id": arguments[1], "room_id": "!r:hs", "event_id": "$e"]
    say("ready")
    while readLine() != nil {
        let render = PushRender(userInfo: userInfo, store: store, api: URLSessionMatrixPushAPI(), tokens: refresher)
        say(await render?.resolve().body ?? "unchanged")
    }
}
