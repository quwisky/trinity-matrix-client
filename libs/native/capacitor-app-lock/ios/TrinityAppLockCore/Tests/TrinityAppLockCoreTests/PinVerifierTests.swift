import XCTest
@testable import TrinityAppLockCore

private final class MemoryStore: PinRecordStore {
    var data: Data?
    var failReads = false
    var failWrites = false
    private(set) var writes = 0
    func read() throws -> Data? {
        if failReads { throw PinStoreError.unreadable }
        return data
    }
    func write(_ data: Data) throws {
        if failWrites { throw PinStoreError.unreadable }
        writes += 1
        self.data = data
    }
    func remove() throws { data = nil }
}

final class PinVerifierTests: XCTestCase {
    private var now: Double = 1_700_000_000_000
    private var uptime: Double = 5_000

    private func verifier(_ store: MemoryStore) -> PinVerifier {
        PinVerifier(
            store: store,
            clock: { [unowned self] in PinClockReading(nowMs: self.now, uptimeS: self.uptime) },
            iterations: 1_000
        )
    }

    /// A stored record as JSON, edited by `change`, so damaged and inconsistent shapes can be
    /// written the way a broken Keychain item would hold them.
    private func storedRecord(
        _ store: MemoryStore,
        _ change: (inout [String: Any]) -> Void
    ) throws {
        XCTAssertEqual(verifier(store).set("482913"), .completed)
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(store.data)) as? [String: Any]
        )
        change(&object)
        store.data = try JSONSerialization.data(withJSONObject: object)
    }

    func testSetVerifyAndClearWithoutStoringThePin() throws {
        let store = MemoryStore()
        let pins = verifier(store)
        XCTAssertEqual(pins.status(), .ready(set: false, nextAttemptAt: nil))
        XCTAssertEqual(pins.set("482913"), .completed)
        let stored = try XCTUnwrap(store.data)
        XCTAssertFalse(String(decoding: stored, as: UTF8.self).contains("482913"))
        XCTAssertEqual(pins.status(), .ready(set: true, nextAttemptAt: nil))
        XCTAssertEqual(pins.verify("482913"), .verified)
        XCTAssertTrue(pins.clear())
        XCTAssertNil(store.data)
    }

    func testFifthFailureStartsAWaitThatSurvivesARestart() {
        let store = MemoryStore()
        XCTAssertEqual(verifier(store).set("482913"), .completed)
        for _ in 0..<4 {
            XCTAssertEqual(verifier(store).verify("000000"), .failed(nextAttemptAt: nil))
        }
        XCTAssertEqual(verifier(store).verify("000000"), .failed(nextAttemptAt: now + 30_000))
        XCTAssertEqual(verifier(store).verify("482913"), .delayed(nextAttemptAt: now + 30_000))
        now += 86_400_000 // the clock jumped a day forward; uptime did not move
        XCTAssertEqual(verifier(store).verify("482913"), .delayed(nextAttemptAt: 1_700_000_030_000))
        uptime += 30
        XCTAssertEqual(verifier(store).verify("482913"), .verified)
    }

    func testMovingTheWallClockBackKeepsTheWait() {
        let store = MemoryStore()
        XCTAssertEqual(verifier(store).set("482913"), .completed)
        for _ in 0..<5 { _ = verifier(store).verify("000000") }
        now -= 3_600_000 // the clock moved an hour back while the device slept a minute
        uptime += 60
        XCTAssertEqual(verifier(store).verify("482913"), .delayed(nextAttemptAt: 1_700_000_030_000))
        XCTAssertEqual(verifier(store).status(), .ready(set: true, nextAttemptAt: 1_700_000_030_000))
    }

    func testRefusesAMalformedPinWithoutCountingIt() {
        let store = MemoryStore()
        let pins = verifier(store)
        XCTAssertEqual(pins.set("\u{0661}\u{0662}\u{0663}\u{0664}"), .invalid)
        XCTAssertEqual(pins.set("\u{FF11}\u{FF12}\u{FF13}\u{FF14}"), .invalid)
        XCTAssertEqual(pins.set("12345678901234567"), .invalid)
        XCTAssertNil(store.data)
        XCTAssertEqual(pins.set("482913"), .completed)
        let before = store.data
        XCTAssertEqual(pins.verify("12 34"), .invalid)
        XCTAssertEqual(pins.verify("\u{0664}\u{0668}\u{0662}\u{0669}\u{0661}\u{0663}"), .invalid)
        XCTAssertEqual(pins.verify("123"), .invalid)
        XCTAssertEqual(store.data, before)
    }

    func testAnUnreadableStoreIsUnavailableNotEmpty() {
        let store = MemoryStore()
        store.failReads = true
        let pins = verifier(store)
        XCTAssertEqual(pins.status(), .unavailable)
        XCTAssertEqual(pins.verify("482913"), .unavailable)
        store.failReads = false
        store.data = Data("not a record".utf8)
        XCTAssertEqual(pins.status(), .unavailable)
    }

    /// Setting a PIN over a record that cannot be read would skip the full reset.
    func testSetNeverOverwritesAnUnreadableRecord() {
        let store = MemoryStore()
        store.failReads = true
        XCTAssertEqual(verifier(store).set("482913"), .unavailable)
        XCTAssertEqual(store.writes, 0)
        store.failReads = false
        let damaged = Data("not a record".utf8)
        store.data = damaged
        XCTAssertEqual(verifier(store).set("482913"), .unavailable)
        XCTAssertEqual(store.data, damaged)
        XCTAssertEqual(verifier(store).verify("482913"), .unavailable)
        XCTAssertTrue(verifier(store).clear())
        XCTAssertEqual(verifier(store).set("482913"), .completed)
        XCTAssertEqual(verifier(store).verify("482913"), .verified)
    }

    func testVerifyWithoutARecordIsUnavailable() {
        XCTAssertEqual(verifier(MemoryStore()).verify("482913"), .unavailable)
    }

    /// A failure count and its two instants exist together or not at all, as Electron's
    /// decodePinRecord requires, so a damaged record cannot end a wait early.
    func testAFailureCountWithoutItsInstantsIsUnavailable() throws {
        let missingBoth = MemoryStore()
        try storedRecord(missingBoth) { $0["failures"] = 9 }
        XCTAssertEqual(verifier(missingBoth).status(), .unavailable)
        XCTAssertEqual(verifier(missingBoth).verify("482913"), .unavailable)

        let missingUptime = MemoryStore()
        try storedRecord(missingUptime) {
            $0["failures"] = 5
            $0["failureAtMs"] = 1_700_000_000_000
        }
        XCTAssertEqual(verifier(missingUptime).verify("482913"), .unavailable)

        let missingWall = MemoryStore()
        try storedRecord(missingWall) {
            $0["failures"] = 5
            $0["failureUptimeS"] = 5_000
        }
        XCTAssertEqual(verifier(missingWall).verify("482913"), .unavailable)

        let instantsWithoutCount = MemoryStore()
        try storedRecord(instantsWithoutCount) {
            $0["failureAtMs"] = 1_700_000_000_000
            $0["failureUptimeS"] = 5_000
        }
        XCTAssertEqual(verifier(instantsWithoutCount).verify("482913"), .unavailable)
    }

    func testRefusesDamagedRecordFields() throws {
        let cases: [(String, (inout [String: Any]) -> Void)] = [
            ("version", { $0["v"] = 2 }),
            ("kdf", { $0["kdf"] = "scrypt" }),
            ("too few iterations", { $0["iterations"] = 999 }),
            ("too many iterations", { $0["iterations"] = 5_000_000_000 }),
            ("short salt", { $0["salt"] = Data(count: 8).base64EncodedString() }),
            ("salt not base64", { $0["salt"] = "not base64!" }),
            ("short hash", { $0["hash"] = Data(count: 16).base64EncodedString() }),
            ("negative failures", { $0["failures"] = -1 }),
            ("unsafe failures", { $0["failures"] = Int.max }),
            ("no hash", { $0.removeValue(forKey: "hash") }),
        ]
        for (name, change) in cases {
            let store = MemoryStore()
            try storedRecord(store, change)
            XCTAssertEqual(verifier(store).status(), .unavailable, name)
            XCTAssertEqual(verifier(store).verify("482913"), .unavailable, name)
        }
    }

    /// An attempt the store cannot record is not answered: a failure must be counted.
    func testAnAttemptThatCannotBeSavedIsUnavailable() {
        let store = MemoryStore()
        XCTAssertEqual(verifier(store).set("482913"), .completed)
        let before = store.data
        store.failWrites = true
        XCTAssertEqual(verifier(store).verify("000000"), .unavailable)
        XCTAssertEqual(store.data, before)
        XCTAssertEqual(verifier(store).set("135790"), .unavailable)
    }

    /// Checks run one at a time per record, so concurrent submits cannot all pass a wait.
    func testConcurrentAttemptsAreCountedOneAtATime() throws {
        let store = MemoryStore()
        let pins = verifier(store)
        XCTAssertEqual(pins.set("482913"), .completed)
        let lock = NSLock()
        var results: [PinCheck] = []
        DispatchQueue.concurrentPerform(iterations: 12) { _ in
            let result = pins.verify("000000")
            lock.lock()
            results.append(result)
            lock.unlock()
        }
        let failed = results.filter { if case .failed = $0 { return true } else { return false } }
        let delayed = results.filter { if case .delayed = $0 { return true } else { return false } }
        XCTAssertEqual(failed.count, 5)
        XCTAssertEqual(delayed.count, 7)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(store.data)) as? [String: Any]
        )
        XCTAssertEqual(object["failures"] as? Int, 5)
    }
}
