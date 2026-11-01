import CryptoKit
import Foundation
import XCTest
@testable import TrinityPush

/// The lease across real processes: `token-lease-probe` takes it and exits without releasing,
/// the way a killed notification process leaves one behind. Races that real processes cannot be
/// made to hit are forced through the lease's `rename` seam, with the real system call underneath.
final class TokenLeaseTests: XCTestCase {
    private let account = "@a:hs"
    private var container: URL!
    private var lease: AppGroupTokenLease!

    override func setUpWithError() throws {
        container = FileManager.default.temporaryDirectory.appendingPathComponent("lease-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        lease = AppGroupTokenLease(containerURL: container)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: leasesDirectory.path)
        try FileManager.default.removeItem(at: container)
    }

    // MARK: Between processes

    func testASecondProcessCannotTakeAHeldLease() async throws {
        _ = try await held()
        XCTAssertEqual(try runProbe(), "busy")
    }

    func testASecondProcessTakesAReleasedLease() async throws {
        let ticket = try await held()
        lease.release(ticket)
        XCTAssertEqual(try runProbe(), "taken")
    }

    func testASecondProcessTakesAnExpiredLease() async throws {
        _ = try await held(lifetime: 0.1)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(try runProbe(), "taken")
    }

    func testAHolderSeesItsLeaseTakenOver() async throws {
        let ticket = try await held(lifetime: 0.1)
        XCTAssertEqual(try runProbe(wait: 1), "taken")
        XCTAssertFalse(lease.holds(ticket))
    }

    func testReleaseIsANoOpForAnotherOwner() async throws {
        let old = try await held(lifetime: 0.1)
        XCTAssertEqual(try runProbe(wait: 1), "taken")
        lease.release(old)
        XCTAssertEqual(try runProbe(), "busy")
    }

    /// matrix-rust-sdk's `test_multiple_processes`: the waiter gets it, and the old holder then can't.
    func testAWaitingProcessTakesAReleasedLeaseAndTheOldHolderThenWaitsInVain() async throws {
        let ticket = try await held()
        let waiter = try Probe(role: "waiter", container: container, arguments: [account, "30", "10"])
        XCTAssertEqual(waiter.line(), "waiting", "the probe must find the lease held")
        lease.release(ticket)
        XCTAssertEqual(waiter.line(), "taken")
        _ = waiter.finish()
        let answer = await lease.take(account, lifetime: 30, wait: 0.2)
        XCTAssertEqual(answer, .busy)
    }

    /// `RENAME_EXCL` is the whole of the exclusion here: of many racing for a free lease, one wins.
    func testOnlyOneOfManyProcessesTakesAFreeLease() throws {
        let probes = try (0..<8).map { _ in try startProbe() }
        let answers = probes.map(finish)
        XCTAssertEqual(answers.filter { $0 == "taken" }.count, 1, "\(answers)")
        XCTAssertEqual(answers.filter { $0 == "busy" }.count, 7, "\(answers)")
    }

    /// `RENAME_SWAP` hands the stale file to one process only: the others find something else.
    func testOnlyOneOfManyProcessesTakesAnExpiredLease() async throws {
        _ = try await held(lifetime: 0)
        // Far more than the floor, so that a stall on a busy runner cannot fail this.
        let probes = try (0..<8).map { _ in try startProbe(wait: 3) }
        let answers = probes.map(finish)
        XCTAssertEqual(answers.filter { $0 == "taken" }.count, 1, "\(answers)")
        XCTAssertEqual(answers.filter { $0 == "busy" }.count, 7, "\(answers)")
        XCTAssertEqual(try allFiles().count, 1)
    }

    // MARK: Waiting

    func testWaitingIsBounded() async throws {
        XCTAssertEqual(try runProbe(), "taken")
        let started = ContinuousClock.now
        let answer = await lease.take(account, lifetime: 30, wait: 0.2)
        XCTAssertEqual(answer, .busy)
        XCTAssertLessThan(started.duration(to: .now), .seconds(10))
    }

    func testAWaiterTakesTheLeaseOnceItIsReleased() async throws {
        let held = try await held()
        async let waiter = lease.take(account, lifetime: 30, wait: 5)
        try await Task.sleep(for: .milliseconds(100))
        lease.release(held)
        let answer = await waiter
        guard case .taken = answer else { return XCTFail("\(answer)") }
    }

    func testACancelledWaitEndsAtOnce() async throws {
        XCTAssertEqual(try runProbe(), "taken")
        let started = ContinuousClock.now
        let waiter = Task { [lease = lease!, account] in await lease.take(account, lifetime: 30, wait: 30) }
        try await Task.sleep(for: .milliseconds(50))
        waiter.cancel()
        let answer = await waiter.value
        XCTAssertEqual(answer, .busy)
        XCTAssertLessThan(started.duration(to: .now), .seconds(10))
    }

    /// A read-only directory fails any file write with EACCES, so `.busy` shows the polls wrote none.
    func testPollingAHeldLeaseOnlyReads() async throws {
        XCTAssertEqual(try runProbe(), "taken")
        let before = try allFiles()
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: leasesDirectory.path)
        let answer = await lease.take(account, lifetime: 30, wait: 0.2)
        XCTAssertEqual(answer, .busy)
        XCTAssertEqual(try allFiles(), before)
    }

    // MARK: Holding and releasing

    func testAHolderHoldsUntilItsExpiry() async throws {
        let ticket = try await held(lifetime: 0.1)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(lease.holds(ticket))
        let long = try await held()
        XCTAssertTrue(lease.holds(long))
    }

    func testAReleasedLeaseIsNotHeldAndLeavesOneExpiredFile() async throws {
        let ticket = try await held()
        lease.release(ticket)
        XCTAssertFalse(lease.holds(ticket))
        XCTAssertEqual(try allFiles().count, 1, "the name is never emptied once it exists")
        let next = try await held()
        XCTAssertTrue(lease.holds(next))
        XCTAssertEqual(try allFiles().count, 1)
    }

    func testADiscardedLeaseLeavesNoFileAndCanBeTakenAgain() async throws {
        let ticket = try await held()
        lease.discard(ticket)
        XCTAssertFalse(lease.holds(ticket))
        XCTAssertEqual(try allFiles(), [])
        let next = try await held()
        XCTAssertTrue(lease.holds(next))
    }

    func testDiscardIsANoOpForAnotherOwner() async throws {
        let ticket = try await held()
        lease.discard(LeaseTicket(account: account, owner: "someone else"))
        XCTAssertTrue(lease.holds(ticket))
    }

    func testDiscardAllRemovesEveryLeaseButNoOtherFile() async throws {
        let first = try await held()
        let other = await lease.take("@b:hs", lifetime: 30, wait: 0)
        guard case .taken = other else { return XCTFail("\(other)") }
        let inFlight = leaseFile.appendingPathExtension("candidate")
        try Data().write(to: inFlight)

        lease.discardAll()

        XCTAssertFalse(lease.holds(first))
        XCTAssertEqual(try allFiles().map(\.lastPathComponent), [inFlight.lastPathComponent])
    }

    func testDiscardAllWithNoDirectoryIsANoOp() {
        lease.discardAll()
    }

    func testReleasingAnExpiredLeaseStillFreesIt() async throws {
        let t = Date(timeIntervalSince1970: 1_700_000_000)
        let clock = MovableClock(t)
        let lease = AppGroupTokenLease(containerURL: container, now: { clock.now })
        let answer = await lease.take(account, lifetime: 1, wait: 0)
        guard case .taken(let ticket) = answer else { return XCTFail("\(answer)") }
        clock.now = t + 2
        lease.release(ticket)
        clock.now = t - 25 // A release marks the file long expired, not expired by this clock.
        let next = await lease.take(account, lifetime: 1, wait: 0)
        guard case .taken = next else { return XCTFail("\(next)") }
    }

    /// The holder read its own name, then the lease passed on before its swap.
    func testAReleaseThatLostARacePutsTheNewHolderBack() async throws {
        let container = container!, account = account
        let releasing = AppGroupTokenLease(containerURL: container, rename: beforeFirstSwap {
            let file = Self.leaseFile(container, account)
            try? FileManager.default.removeItem(at: file)
            XCTAssertEqual(try? Self.runProbe(container, account, lifetime: 30, wait: 0), "taken")
        })
        let answer = await releasing.take(account, lifetime: 30, wait: 0)
        guard case .taken(let ticket) = answer else { return XCTFail("\(answer)") }
        releasing.release(ticket)
        XCTAssertEqual(try runProbe(), "busy", "the new holder's lease is back")
        XCTAssertEqual(try allFiles().count, 1)
    }

    // MARK: The takeover races

    /// C read the stale lease; a fresh holder took over before C's swap.
    func testATakerWithAnOldReadPutsTheFreshLeaseBackAndClaimsNothing() async throws {
        _ = try await held(lifetime: 0)
        let container = container!, account = account
        let fresh = Box<Data>()
        let taker = AppGroupTokenLease(containerURL: container, rename: beforeFirstSwap {
            XCTAssertEqual(try? Self.runProbe(container, account, lifetime: 30, wait: 0), "taken")
            fresh.value = try? Data(contentsOf: Self.leaseFile(container, account))
        })
        let answer = await taker.take(account, lifetime: 30, wait: 0)
        XCTAssertEqual(answer, .busy)
        XCTAssertEqual(try Data(contentsOf: leaseFile), fresh.value)
        XCTAssertEqual(try allFiles().count, 1, "the taker's own file went too")
    }

    func testTheNameIsNeverEmptyAcrossATakeoverThatFails() async throws {
        _ = try await held(lifetime: 0)
        let container = container!, account = account
        let file = leaseFile
        let forward = beforeFirstSwap {
            XCTAssertEqual(try? Self.runProbe(container, account, lifetime: 30, wait: 0), "taken")
        }
        let swaps = Box<Int>(0)
        let taker = AppGroupTokenLease(containerURL: container, rename: { from, to, flags in
            let result = forward(from, to, flags)
            swaps.value! += 1
            XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
            return result
        })
        _ = await taker.take(account, lifetime: 30, wait: 0)
        XCTAssertEqual(swaps.value, 2, "out, and back")
    }

    /// The first swap landed and the swap back never came, which is what a kill looks like.
    func testATakerKilledMidTakeoverLeavesTheLeaseOccupied() async throws {
        _ = try await held(lifetime: 0)
        let container = container!, account = account
        let count = Box<Int>(0)
        let takeOver = beforeFirstSwap {
            XCTAssertEqual(try? Self.runProbe(container, account, lifetime: 30, wait: 0), "taken")
        }
        let killed = AppGroupTokenLease(containerURL: container, rename: { from, to, flags in
            count.value! += 1
            return count.value == 1 ? takeOver(from, to, flags) : EIO
        })
        let answer = await killed.take(account, lifetime: 30, wait: 0)
        XCTAssertEqual(answer, .busy)
        XCTAssertEqual(try runProbe(), "busy", "nobody else can take it")
    }

    /// B, C and E: C and E read the stale lease, B took over, then C and E swap in this order.
    func testTwoOldReadsPutBackInOrderLeaveTheFreshLease() async throws {
        try await twoTakersWithOldReads(order: ["C", "E", "E", "C"])
    }

    /// C's swap back takes E's file, and E's takes C's: each has to keep swapping.
    func testTwoOldReadsPutBackOutOfOrderLeaveTheFreshLease() async throws {
        try await twoTakersWithOldReads(order: ["C", "E", "C", "E"])
    }

    /// E takes B back out, then stalls holding C's file while C swaps alone, and then the reverse.
    /// A stall of about 2 ms is enough: neither can get its own file while the other is not running.
    func testATakerStallingMidPutBackLeavesTheFreshLease() async throws {
        let cAlone = Array(repeating: "C", count: 14), eAlone = Array(repeating: "E", count: 13)
        try await twoTakersWithOldReads(order: ["C", "E", "C", "E", "E"] + cAlone + eAlone)
    }

    /// With no time from its caller, a put-back still gets the floor, which covers a short stall.
    /// Kept short: each swap takes about 40 ms on a CI runner, and all of this must fit in the floor.
    func testATakerStallingMidPutBackWithNoTimeLeftLeavesTheFreshLease() async throws {
        try await twoTakersWithOldReads(order: ["C", "E", "C", "E", "E", "C", "C", "E"], wait: 0)
    }

    /// By default a long wait, so that the takers' time to put back outlasts any stall a busy runner adds.
    private func twoTakersWithOldReads(order: [String], wait: TimeInterval = 30) async throws {
        _ = try await held(lifetime: 0)
        let container = container!, account = account
        let turns = Turns(order: order)
        let c = AppGroupTokenLease(containerURL: container, rename: turns.rename("C"))
        let e = AppGroupTokenLease(containerURL: container, rename: turns.rename("E"))
        let first = Task.detached { await c.take(account, lifetime: 30, wait: wait) }
        let second = Task.detached { await e.take(account, lifetime: 30, wait: wait) }
        try await turns.waitForBothToHaveRead()
        XCTAssertEqual(try runProbe(), "taken")
        let fresh = try Data(contentsOf: leaseFile)
        turns.start()

        try await turns.waitForTheOrderToEnd()
        // Cancelling cuts only the poll that follows a put-back, never the put-back.
        first.cancel()
        second.cancel()
        let answers = await [first.value, second.value]
        XCTAssertEqual(answers, [.busy, .busy])
        XCTAssertEqual(try Data(contentsOf: leaseFile), fresh)
        XCTAssertEqual(try allFiles().count, 1)
        XCTAssertFalse(turns.timedOut)
    }

    /// With no time from its caller, a put-back whose file never comes back gives up at the floor,
    /// well short of the 200 swaps of its full limit, and leaves the new holder's lease in the name.
    func testAPutBackWithNoTimeLeftStopsAtTheFloor() async throws {
        _ = try await held(lifetime: 0)
        let container = container!, account = account
        let swaps = Box<Int>(0)
        let taker = AppGroupTokenLease(containerURL: container, rename: losingOwnFile(swaps) {
            XCTAssertEqual(try? Self.runProbe(container, account, lifetime: 30, wait: 0), "taken")
        })
        let answer = await taker.take(account, lifetime: 30, wait: 0)
        XCTAssertEqual(answer, .busy)
        XCTAssertLessThan(try XCTUnwrap(swaps.value), 100)
        XCTAssertEqual(try runProbe(), "busy", "the new holder's lease is back")
    }

    /// The floor passes during the second swap back, which leaves the new holder's lease out of the
    /// name: only an odd count of swaps back returns it, so this has to swap once more.
    func testAPutBackPastItsLimitAfterAnEvenSwapSwapsOnceMore() async throws {
        _ = try await held(lifetime: 0)
        let container = container!, account = account
        let swaps = Box<Int>(0)
        let taker = AppGroupTokenLease(containerURL: container, rename: losingOwnFile(swaps, stallBeforeSwap: 3) {
            XCTAssertEqual(try? Self.runProbe(container, account, lifetime: 30, wait: 0), "taken")
        })
        _ = await taker.take(account, lifetime: 30, wait: 0)
        XCTAssertEqual(try runProbe(), "busy", "the new holder's lease is back")
    }

    func testAReleasePutBackStopsAtTheFloor() async throws {
        let container = container!, account = account
        let swaps = Box<Int>(0)
        let releasing = AppGroupTokenLease(containerURL: container, rename: losingOwnFile(swaps) {
            try? FileManager.default.removeItem(at: Self.leaseFile(container, account))
            XCTAssertEqual(try? Self.runProbe(container, account, lifetime: 30, wait: 0), "taken")
        })
        let answer = await releasing.take(account, lifetime: 30, wait: 0)
        guard case .taken(let ticket) = answer else { return XCTFail("\(answer)") }
        releasing.release(ticket)
        XCTAssertLessThan(try XCTUnwrap(swaps.value), 100)
        XCTAssertEqual(try runProbe(), "busy", "the new holder's lease is back")
    }

    /// C wins the stale lease; E, with the same read, then swaps out C's fresh file.
    func testATakerThatSwapsOutTheWinnersFileGivesItBack() async throws {
        _ = try await held(lifetime: 0)
        let container = container!, account = account
        let turns = Turns(order: ["C", "E", "E"])
        let c = AppGroupTokenLease(containerURL: container, rename: turns.rename("C"))
        let e = AppGroupTokenLease(containerURL: container, rename: turns.rename("E"))
        async let first = Task.detached { await c.take(account, lifetime: 30, wait: 0) }.value
        async let second = Task.detached { await e.take(account, lifetime: 30, wait: 0) }.value
        try await turns.waitForBothToHaveRead()
        turns.start()

        let (winner, loser) = await (first, second)
        guard case .taken(let ticket) = winner else { return XCTFail("\(winner)") }
        XCTAssertEqual(loser, .busy)
        XCTAssertTrue(c.holds(ticket))
        XCTAssertEqual(try allFiles().count, 1)
        XCTAssertFalse(turns.timedOut)
    }

    func testALeaseThatVanishesBeforeTheSwapIsTakenAtTheNextPoll() async throws {
        _ = try await held(lifetime: 0)
        let file = leaseFile
        let taker = AppGroupTokenLease(containerURL: container, rename: beforeFirstSwap {
            try? FileManager.default.removeItem(at: file)
        })
        let answer = await taker.take(account, lifetime: 30, wait: 1)
        guard case .taken(let ticket) = answer else { return XCTFail("\(answer)") }
        XCTAssertTrue(taker.holds(ticket))
    }

    // MARK: A platform refusal

    func testAnErrnoOtherThanEEXISTEndsTheWaitAtOnce() async throws {
        for code in [EPERM, ENOTSUP, EACCES, EIO, ENOENT] {
            let calls = Box<Int>(0)
            let refused = AppGroupTokenLease(containerURL: container, rename: { _, _, _ in
                calls.value! += 1
                return code
            })
            let answer = await refused.take(account, lifetime: 30, wait: 1)
            XCTAssertEqual(answer, .unavailable, "errno \(code)")
            XCTAssertEqual(calls.value, 1, "errno \(code)")
            XCTAssertEqual(try allFiles().count, 0, "errno \(code)")
        }
    }

    func testARefusedSwapEndsTheWaitAtOnce() async throws {
        _ = try await held(lifetime: 0)
        let before = try Data(contentsOf: leaseFile)
        let refused = AppGroupTokenLease(containerURL: container, rename: { _, _, _ in EPERM })
        let answer = await refused.take(account, lifetime: 30, wait: 1)
        XCTAssertEqual(answer, .unavailable)
        XCTAssertEqual(try Data(contentsOf: leaseFile), before)
        XCTAssertEqual(try allFiles().count, 1)
    }

    func testACandidateThatCannotBeWrittenEndsTheWaitAtOnce() async throws {
        try FileManager.default.createDirectory(at: leasesDirectory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: leasesDirectory.path)
        let answer = await lease.take(account, lifetime: 30, wait: 1)
        XCTAssertEqual(answer, .unavailable)
    }

    // MARK: Reading a lease

    /// Mode 000 fails the open with EACCES: a real read error, standing in for EMFILE and EIO.
    func testAReadErrorIsNeverTakenForAStaleLease() async throws {
        let ticket = try await held()
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: leaseFile.path)
        let answer = await lease.take(account, lifetime: 30, wait: 1)
        XCTAssertEqual(answer, .unavailable)
        XCTAssertFalse(lease.holds(ticket))
        lease.release(ticket)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: leaseFile.path)
        XCTAssertTrue(lease.holds(ticket), "still the holder's file")
    }

    func testAnUndecodableLeaseIsTakenOver() async throws {
        try FileManager.default.createDirectory(at: leasesDirectory, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: leaseFile)
        let ticket = try await held()
        XCTAssertTrue(lease.holds(ticket))
        XCTAssertEqual(try allFiles().count, 1)
    }

    // MARK: Clock, lifetime and names

    func testAccountsDoNotExcludeEachOther() async throws {
        let first = await lease.take("@a:hs", lifetime: 30, wait: 0)
        let second = await lease.take("@b:hs", lifetime: 30, wait: 0)
        guard case .taken = first, case .taken = second else { return XCTFail("\(first) \(second)") }
    }

    func testAnExpiryFarBeyondTheLongestLifetimeCountsAsExpired() async throws {
        let t = Date(timeIntervalSince1970: 1_700_000_000)
        let clock = MovableClock(t)
        let lease = AppGroupTokenLease(containerURL: container, now: { clock.now })
        let first = await lease.take(account, lifetime: 30, wait: 0)
        guard case .taken = first else { return XCTFail("\(first)") }
        let sameInstant = await lease.take(account, lifetime: 30, wait: 0)
        XCTAssertEqual(sameInstant, .busy, "the longest lifetime itself is still a held lease")
        clock.now = t - 3600
        let afterTheClockWentBack = await lease.take(account, lifetime: 30, wait: 0)
        guard case .taken = afterTheClockWentBack else { return XCTFail("\(afterTheClockWentBack)") }
    }

    func testALifetimeAboveTheLongestIsClampedNotInstantlyStealable() async throws {
        let t = Date(timeIntervalSince1970: 1_700_000_000)
        let clock = MovableClock(t)
        let lease = AppGroupTokenLease(containerURL: container, now: { clock.now })
        let first = await lease.take(account, lifetime: 3600, wait: 0)
        guard case .taken(let ticket) = first else { return XCTFail("\(first)") }
        let atOnce = await lease.take(account, lifetime: 30, wait: 0)
        XCTAssertEqual(atOnce, .busy)
        XCTAssertTrue(lease.holds(ticket))
        clock.now = t + TokenBudgets.longestLifetime
        XCTAssertFalse(lease.holds(ticket))
    }

    func testLeaseFileNamesAreSafeForAnyUserId() async throws {
        let longest = "@" + String(repeating: "a", count: 251) + ":hs"
        XCTAssertEqual(longest.utf8.count, 255)
        for id in ["@a/../b:hs", longest] {
            let answer = await lease.take(id, lifetime: 30, wait: 0)
            guard case .taken = answer else { return XCTFail("\(answer)") }
        }

        let directory = leasesDirectory.resolvingSymlinksInPath().path + "/"
        let created = try allFiles().map { $0.resolvingSymlinksInPath().path }
        XCTAssertEqual(created.count, 2, "no temporary file stays behind: \(created)")
        for path in created {
            XCTAssertTrue(path.hasPrefix(directory), path)
        }
        XCTAssertEqual(
            Set(created.map { ($0 as NSString).lastPathComponent }),
            Set(["@a/../b:hs", longest].map(Self.leaseName)))
        XCTAssertEqual(
            try leasesDirectory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    // MARK: Helpers

    private func held(lifetime: TimeInterval = 30) async throws -> LeaseTicket {
        let answer = await lease.take(account, lifetime: lifetime, wait: 0)
        guard case .taken(let ticket) = answer else {
            XCTFail("expected to take the lease, got \(answer)")
            throw CancellationError()
        }
        return ticket
    }

    private var leasesDirectory: URL {
        container.appendingPathComponent("push-handoff/leases", isDirectory: true)
    }

    private var leaseFile: URL { Self.leaseFile(container, account) }

    private static func leaseFile(_ container: URL, _ account: String) -> URL {
        container.appendingPathComponent("push-handoff/leases/\(leaseName(account))")
    }

    private static func leaseName(_ id: String) -> String {
        SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined() + ".lease"
    }

    private func allFiles() throws -> [URL] {
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(
            at: container, includingPropertiesForKeys: [.isRegularFileKey]))
        return try enumerator.compactMap { $0 as? URL }.filter {
            try $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true
        }
    }

    /// The real system call, after `action` the first time a swap is about to happen.
    private func beforeFirstSwap(
        _ action: @escaping @Sendable () -> Void
    ) -> @Sendable (String, String, UInt32) -> Int32 {
        let done = Box<Bool>(false)
        return { from, to, flags in
            if flags == UInt32(RENAME_SWAP), done.value != true {
                done.value = true
                action()
            }
            return AppGroupTokenLease.systemRename(from, to, flags)
        }
    }

    /// The real system call, counting swaps. The first swap runs `action` and overwrites this taker's
    /// file, which then never comes back, as if a dead taker held it. A stall outlasts the floor.
    private func losingOwnFile(
        _ swaps: Box<Int>, stallBeforeSwap stalled: Int? = nil, _ action: @escaping @Sendable () -> Void
    ) -> @Sendable (String, String, UInt32) -> Int32 {
        { from, to, flags in
            if flags == UInt32(RENAME_SWAP) {
                if swaps.value == 0 {
                    try? Data("another taker's".utf8).write(to: URL(fileURLWithPath: from))
                    action()
                }
                swaps.value! += 1
                if swaps.value == stalled { usleep(600_000) }
            }
            return AppGroupTokenLease.systemRename(from, to, flags)
        }
    }

    private func runProbe(lifetime: TimeInterval = 30, wait: TimeInterval = 0) throws -> String {
        try Self.runProbe(container, account, lifetime: lifetime, wait: wait)
    }

    private func startProbe(lifetime: TimeInterval = 30, wait: TimeInterval = 0) throws -> (Process, Pipe) {
        try Self.startProbe(container, account, lifetime: lifetime, wait: wait)
    }

    private func finish(_ probe: (Process, Pipe)) -> String { Self.finish(probe) }

    private static func runProbe(
        _ container: URL, _ account: String, lifetime: TimeInterval, wait: TimeInterval
    ) throws -> String {
        finish(try startProbe(container, account, lifetime: lifetime, wait: wait))
    }

    private static func startProbe(
        _ container: URL, _ account: String, lifetime: TimeInterval, wait: TimeInterval
    ) throws -> (Process, Pipe) {
        let bundle = try XCTUnwrap(Bundle.allBundles.first { $0.bundlePath.hasSuffix(".xctest") })
        let process = Process()
        process.executableURL = bundle.bundleURL.deletingLastPathComponent().appendingPathComponent("token-lease-probe")
        process.arguments = [container.path, account, String(lifetime), String(wait)]
        let output = Pipe()
        process.standardOutput = output
        try process.run()
        // A hung probe then answers with nothing, which fails the test instead of hanging it.
        DispatchQueue.global().asyncAfter(deadline: .now() + 60) { [process] in
            if process.isRunning { process.terminate() }
        }
        return (process, output)
    }

    private static func finish(_ probe: (Process, Pipe)) -> String {
        let data = probe.1.fileHandleForReading.readDataToEndOfFile()
        probe.0.waitUntilExit()
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private final class MovableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date

    init(_ value: Date) { self.value = value }

    var now: Date {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

private final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value?

    init(_ value: Value? = nil) { stored = value }

    var value: Value? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

/// Runs two takers' swaps one at a time in a set order, then in whatever order they arrive. Each
/// waits at its first swap, having read the lease, until `start`. A stuck turn gives up rather
/// than hang the suite, and the test checks `timedOut`.
private final class Turns: @unchecked Sendable {
    private let condition = NSCondition()
    private var order: [String]
    private var arrived = Set<String>()
    private var started = false
    private var stuck = false

    init(order: [String]) { self.order = order }

    var timedOut: Bool {
        condition.lock()
        defer { condition.unlock() }
        return stuck
    }

    private var bothArrived: Bool {
        condition.lock()
        defer { condition.unlock() }
        return arrived.count == 2
    }

    private var orderEnded: Bool {
        condition.lock()
        defer { condition.unlock() }
        return order.isEmpty
    }

    func rename(_ who: String) -> @Sendable (String, String, UInt32) -> Int32 {
        { [self] from, to, flags in
            condition.lock()
            defer { condition.unlock() }
            arrived.insert(who)
            condition.broadcast()
            let giveUp = Date() + 20
            while !started || (order.first != nil && order.first != who) {
                if !condition.wait(until: giveUp) {
                    stuck = true
                    break
                }
            }
            let result = AppGroupTokenLease.systemRename(from, to, flags)
            if order.first == who { order.removeFirst() }
            condition.broadcast()
            return result
        }
    }

    func waitForBothToHaveRead() async throws {
        for _ in 0..<2000 {
            if bothArrived { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("the takers never reached their swap")
    }

    func waitForTheOrderToEnd() async throws {
        for _ in 0..<2000 {
            if orderEnded { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("the takers never took all their turns")
    }

    func start() {
        condition.lock()
        started = true
        condition.broadcast()
        condition.unlock()
    }
}
