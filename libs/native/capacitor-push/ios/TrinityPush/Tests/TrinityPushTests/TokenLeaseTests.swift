import CryptoKit
import Foundation
import XCTest
@testable import TrinityPush

/// The lease across real processes: `token-lease-probe` takes it and exits without releasing,
/// the way a killed notification process leaves one behind.
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
        try FileManager.default.removeItem(at: container)
    }

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

    func testAHolderDoesNotHoldPastItsExpiry() async throws {
        let ticket = try await held(lifetime: 0.1)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(lease.holds(ticket))
    }

    func testReleaseIsANoOpForAnotherOwner() async throws {
        let old = try await held(lifetime: 0.1)
        XCTAssertEqual(try runProbe(wait: 1), "taken")
        lease.release(old)
        XCTAssertEqual(try runProbe(), "busy")
    }

    func testWaitingIsBounded() async throws {
        XCTAssertEqual(try runProbe(), "taken")
        let started = ContinuousClock.now
        let ticket = await lease.take(account, lifetime: 30, wait: 0.2)
        XCTAssertNil(ticket)
        XCTAssertLessThan(started.duration(to: .now), .seconds(1))
    }

    func testAWaiterTakesTheLeaseOnceItIsReleased() async throws {
        let held = try await held()
        async let waiter = lease.take(account, lifetime: 30, wait: 5)
        try await Task.sleep(for: .milliseconds(100))
        lease.release(held)
        let taken = await waiter
        XCTAssertNotNil(taken)
    }

    func testACancelledWaitEndsAtOnce() async throws {
        XCTAssertEqual(try runProbe(), "taken")
        let started = ContinuousClock.now
        let waiter = Task { [lease = lease!, account] in await lease.take(account, lifetime: 30, wait: 30) }
        try await Task.sleep(for: .milliseconds(50))
        waiter.cancel()
        let ticket = await waiter.value
        XCTAssertNil(ticket)
        XCTAssertLessThan(started.duration(to: .now), .seconds(5))
    }

    func testAccountsDoNotExcludeEachOther() async throws {
        let first = await lease.take("@a:hs", lifetime: 30, wait: 0)
        let second = await lease.take("@b:hs", lifetime: 30, wait: 0)
        XCTAssertNotNil(first)
        XCTAssertNotNil(second)
    }

    /// `link` is the whole of the exclusion: of many processes racing for a free lease, one wins.
    func testOnlyOneOfManyProcessesTakesAFreeLease() throws {
        let probes = try (0..<8).map { _ in try startProbe() }
        let answers = probes.map(finish)
        XCTAssertEqual(answers.filter { $0 == "taken" }.count, 1, "\(answers)")
        XCTAssertEqual(answers.filter { $0 == "busy" }.count, 7, "\(answers)")
    }

    func testAnExpiryFarBeyondTheLongestLifetimeCountsAsExpired() async throws {
        let t = Date(timeIntervalSince1970: 1_700_000_000)
        let clock = MovableClock(t)
        let lease = AppGroupTokenLease(containerURL: container, now: { clock.now })
        let ticket = await lease.take(account, lifetime: 30, wait: 0)
        XCTAssertNotNil(ticket)
        let sameInstant = await lease.take(account, lifetime: 30, wait: 0)
        XCTAssertNil(sameInstant, "the longest lifetime itself is still a held lease")
        clock.now = t - 3600
        let afterTheClockWentBack = await lease.take(account, lifetime: 30, wait: 0)
        XCTAssertNotNil(afterTheClockWentBack)
    }

    func testLeaseFileNamesAreSafeForAnyUserId() async throws {
        let longest = "@" + String(repeating: "a", count: 251) + ":hs"
        XCTAssertEqual(longest.utf8.count, 255)
        for id in ["@a/../b:hs", longest] {
            let ticket = await lease.take(id, lifetime: 30, wait: 0)
            XCTAssertNotNil(ticket)
        }

        let directory = leasesDirectory.resolvingSymlinksInPath().path + "/"
        let created = try allFiles().map { $0.resolvingSymlinksInPath().path }
        XCTAssertEqual(created.count, 2, "no temporary file stays behind: \(created)")
        for path in created {
            XCTAssertTrue(path.hasPrefix(directory), path)
        }
        XCTAssertEqual(
            Set(created.map { ($0 as NSString).lastPathComponent }),
            Set(["@a/../b:hs", longest].map(leaseName)))
        XCTAssertEqual(
            try leasesDirectory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testAnUnreadableLeaseIsTakenOver() async throws {
        try FileManager.default.createDirectory(at: leasesDirectory, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: leasesDirectory.appendingPathComponent(leaseName(account)))
        let ticket = await lease.take(account, lifetime: 30, wait: 0)
        XCTAssertNotNil(ticket)
    }

    /// The other process's takeover read an old holder, and a fresh one took the lease before
    /// its rename: the fresh holder has to go back, or two processes refresh at once.
    func testATakeoverPutsBackAFreshHolderItMovedByMistake() async throws {
        let fresh = try await held()
        lease.takeOver(account, seenOwner: "an-older-holder")
        XCTAssertTrue(lease.holds(fresh))
        XCTAssertEqual(try allFiles().count, 1)
    }

    func testATakeoverRemovesTheHolderItSaw() async throws {
        let seen = try await held()
        lease.takeOver(account, seenOwner: seen.owner)
        XCTAssertFalse(lease.holds(seen))
        XCTAssertEqual(try allFiles().count, 0)
    }

    func testATakeoverOfNothingDoesNothing() throws {
        lease.takeOver(account, seenOwner: "gone")
        XCTAssertEqual(try allFiles().count, 0)
    }

    func testTakingLeavesOnlyTheLeaseAndReleasingLeavesNothing() async throws {
        let ticket = try await held()
        XCTAssertEqual(try allFiles().count, 1)
        lease.release(ticket)
        XCTAssertEqual(try allFiles().count, 0)
    }

    func testReleasingAnExpiredLeaseStillRemovesIt() async throws {
        let ticket = try await held(lifetime: 0.01)
        try await Task.sleep(for: .milliseconds(50))
        lease.release(ticket)
        XCTAssertEqual(try allFiles().count, 0)
    }

    private func held(lifetime: TimeInterval = 30) async throws -> LeaseTicket {
        let ticket = await lease.take(account, lifetime: lifetime, wait: 0)
        return try XCTUnwrap(ticket)
    }

    private var leasesDirectory: URL {
        container.appendingPathComponent("push-handoff/leases", isDirectory: true)
    }

    private func leaseName(_ id: String) -> String {
        SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined() + ".lease"
    }

    private func allFiles() throws -> [URL] {
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(
            at: container, includingPropertiesForKeys: [.isRegularFileKey]))
        return try enumerator.compactMap { $0 as? URL }.filter {
            try $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true
        }
    }

    private func runProbe(lifetime: TimeInterval = 30, wait: TimeInterval = 0) throws -> String {
        finish(try startProbe(lifetime: lifetime, wait: wait))
    }

    private func startProbe(lifetime: TimeInterval = 30, wait: TimeInterval = 0) throws -> (Process, Pipe) {
        let bundle = try XCTUnwrap(Bundle.allBundles.first { $0.bundlePath.hasSuffix(".xctest") })
        let process = Process()
        process.executableURL = bundle.bundleURL.deletingLastPathComponent().appendingPathComponent("token-lease-probe")
        process.arguments = [container.path, account, String(lifetime), String(wait)]
        let output = Pipe()
        process.standardOutput = output
        try process.run()
        return (process, output)
    }

    private func finish(_ probe: (Process, Pipe)) -> String {
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
