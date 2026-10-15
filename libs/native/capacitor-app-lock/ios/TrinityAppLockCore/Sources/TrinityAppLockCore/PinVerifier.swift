import CommonCrypto
import Foundation
import Security

/// Where the verifier record lives. `read` returns nil only when there is no record.
public protocol PinRecordStore {
    func read() throws -> Data?
    func write(_ data: Data) throws
    func remove() throws
}

/// Fixed cases only: no error carries the PIN, its salt, its hash or the system's detail.
public enum PinStoreError: Error {
    /// The record exists but could not be read or decoded.
    case unreadable
    /// The record could not be added or updated.
    case writeFailed
    /// The record could not be removed.
    case deleteFailed
    case random
    case kdf
}

public struct PinRecord: Codable, Equatable {
    public var v: Int
    public var kdf: String
    public var iterations: Int
    public var salt: String
    public var hash: String
    public var failures: Int
    public var failureAtMs: Double?
    public var failureUptimeS: Double?

    var failureState: PinFailureState {
        PinFailureState(failures: failures, failureAtMs: failureAtMs, failureUptimeS: failureUptimeS)
    }
}

/// Never the salt or the hash, so no log line, `dump` or assertion message can carry them
/// (as the Kotlin record's `toString`). `Mirror` sees the same redacted fields.
extension PinRecord: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "PinRecord(v: \(v), kdf: \(kdf), iterations: \(iterations), failures: \(failures), "
            + "failureAtMs: \(failureAtMs.map { String($0) } ?? "nil"), "
            + "failureUptimeS: \(failureUptimeS.map { String($0) } ?? "nil"), "
            + "salt: <redacted>, hash: <redacted>)"
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        Mirror(
            self,
            children: [
                "v": v,
                "kdf": kdf,
                "iterations": iterations,
                "failures": failures,
                "failureAtMs": failureAtMs as Any,
                "failureUptimeS": failureUptimeS as Any,
                "salt": "<redacted>",
                "hash": "<redacted>",
            ],
            displayStyle: .struct
        )
    }
}

public enum PinStatus: Equatable {
    case ready(set: Bool, nextAttemptAt: Double?)
    case unavailable
}

public enum PinSetResult: Equatable {
    case completed
    case invalid
    case unavailable
}

public enum PinCheck: Equatable {
    case verified
    case failed(nextAttemptAt: Double?)
    case delayed(nextAttemptAt: Double)
    case invalid
    case unavailable
}

/// The mobile Trinity PIN: one PBKDF2-HMAC-SHA256 record. Never logs, and no result
/// carries the PIN, its hash or its salt. A record that exists but cannot be read is
/// `unavailable`, never "no PIN": treating it as absent would let a damaged item open the
/// lock, and setting a new PIN over it would skip the full reset. Only `clear` removes it.
///
/// Every call runs on one serial queue and saves its record before it answers, so two
/// quick submits cannot both pass a wait and a crash cannot forget a failure.
public final class PinVerifier {
    /// OWASP's current figure for PBKDF2-HMAC-SHA256; stored per record so it can rise.
    public static let productionIterations = 600_000
    /// The most a stored record may ask for, so a damaged one cannot stall every attempt.
    static let maxIterations = 10_000_000
    static let minIterations = 1_000
    /// Number.MAX_SAFE_INTEGER, Electron's bound on a stored failure count.
    private static let maxFailures = 9_007_199_254_740_991
    private static let keyLength = 32
    private static let saltLength = 16
    private let store: PinRecordStore
    private let clock: () -> PinClockReading
    private let iterations: Int
    private let queue = DispatchQueue(label: "dev.trinityproject.trinity.app-lock.verifier")

    public init(
        store: PinRecordStore,
        clock: @escaping () -> PinClockReading = PinVerifier.systemClock,
        iterations: Int = PinVerifier.productionIterations
    ) {
        self.store = store
        self.clock = clock
        self.iterations = iterations
    }

    /// Wall-clock time and seconds since boot. The since-boot reading is
    /// `CLOCK_MONOTONIC_RAW`, which on Darwin is `mach_continuous_time`: a tick count from
    /// boot that keeps counting while the device sleeps and that no wall-clock change moves.
    /// `ProcessInfo.systemUptime` and `mach_absolute_time` (`CLOCK_UPTIME_RAW`) stop during
    /// sleep, so a wait would stretch over a night's sleep. Darwin's `CLOCK_MONOTONIC` is
    /// computed as `gettimeofday()` minus `kern.boottime`, so it leans on the kernel moving
    /// boottime with every clock change; the raw continuous clock needs no such bookkeeping.
    public static func systemClock() -> PinClockReading {
        PinClockReading(
            nowMs: Date().timeIntervalSince1970 * 1000,
            uptimeS: Double(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1_000_000_000
        )
    }

    public func status() -> PinStatus {
        queue.sync {
            switch readRecord() {
            case .none:
                return .ready(set: false, nextAttemptAt: nil)
            case .some(.failure):
                return .unavailable
            case .some(.success(let record)):
                let state = record.failureState
                return .ready(
                    set: true,
                    nextAttemptAt: PinPolicy.attemptAllowed(state, at: clock()) ? nil : PinPolicy.nextAttemptAt(state)
                )
            }
        }
    }

    public func set(_ pin: String) -> PinSetResult {
        queue.sync {
            guard PinPolicy.isValid(pin) else { return .invalid }
            if case .some(.failure) = readRecord() { return .unavailable }
            do {
                let salt = try Self.randomSalt()
                let hash = try Self.derive(pin, salt: salt, iterations: iterations)
                let record = PinRecord(
                    v: 1, kdf: "pbkdf2-sha256", iterations: iterations,
                    salt: salt.base64EncodedString(), hash: hash.base64EncodedString(),
                    failures: 0, failureAtMs: nil, failureUptimeS: nil
                )
                try store.write(JSONEncoder().encode(record))
                return .completed
            } catch {
                return .unavailable
            }
        }
    }

    public func verify(_ pin: String) -> PinCheck {
        queue.sync {
            // Electron's order: the record first, so an unreadable record is unavailable for any
            // PIN; then the format, before the wait and the KDF, so a malformed PIN never
            // reaches PBKDF2 and is never counted.
            guard case .some(.success(var record)) = readRecord() else { return .unavailable }
            guard PinPolicy.isValid(pin) else { return .invalid }
            let now = clock()
            guard PinPolicy.attemptAllowed(record.failureState, at: now) else {
                return .delayed(nextAttemptAt: PinPolicy.nextAttemptAt(record.failureState) ?? now.nowMs)
            }
            guard let salt = Data(base64Encoded: record.salt),
                  let expected = Data(base64Encoded: record.hash),
                  let actual = try? Self.derive(pin, salt: salt, iterations: record.iterations)
            else { return .unavailable }
            if Self.constantTimeEqual(expected, actual) {
                record.failures = 0
                record.failureAtMs = nil
                record.failureUptimeS = nil
                return save(record) ? .verified : .unavailable
            }
            record.failures += 1
            record.failureAtMs = now.nowMs
            record.failureUptimeS = now.uptimeS
            // An attempt the record cannot keep is not answered: a failure must be counted.
            return save(record) ? .failed(nextAttemptAt: PinPolicy.nextAttemptAt(record.failureState)) : .unavailable
        }
    }

    /// Remove the record, readable or not; the full reset's way past a damaged item.
    public func clear() -> Bool {
        queue.sync { (try? store.remove()) != nil }
    }

    private func readRecord() -> Result<PinRecord, PinStoreError>? {
        let data: Data?
        do {
            data = try store.read()
        } catch {
            return .failure(.unreadable)
        }
        guard let data else { return nil }
        guard let record = try? JSONDecoder().decode(PinRecord.self, from: data),
              Self.isUsable(record)
        else { return .failure(.unreadable) }
        return .success(record)
    }

    /// Electron's decodePinRecord for the PBKDF2 record: known version and KDF, a bounded
    /// iteration count, a salt of at least 16 bytes, a 32-byte hash, and a failure count
    /// that exists together with both of its instants or not at all.
    private static func isUsable(_ record: PinRecord) -> Bool {
        guard record.v == 1,
              record.kdf == "pbkdf2-sha256",
              (minIterations...maxIterations).contains(record.iterations),
              let salt = Data(base64Encoded: record.salt), salt.count >= saltLength,
              let hash = Data(base64Encoded: record.hash), hash.count == keyLength,
              (0...maxFailures).contains(record.failures)
        else { return false }
        let instants = [record.failureAtMs, record.failureUptimeS]
        guard instants.allSatisfy({ $0?.isFinite ?? true }) else { return false }
        let counted = record.failures > 0
        return instants.allSatisfy { ($0 != nil) == counted }
    }

    private func save(_ record: PinRecord) -> Bool {
        (try? store.write(JSONEncoder().encode(record))) != nil
    }

    private static func randomSalt() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: saltLength)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw PinStoreError.random
        }
        return Data(bytes)
    }

    private static func derive(_ pin: String, salt: Data, iterations: Int) throws -> Data {
        guard let rounds = UInt32(exactly: iterations) else { throw PinStoreError.kdf }
        let password = Array(pin.utf8).map { CChar(bitPattern: $0) }
        var derived = [UInt8](repeating: 0, count: keyLength)
        let status = salt.withUnsafeBytes { saltBytes in
            CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2),
                password, password.count,
                saltBytes.bindMemory(to: UInt8.self).baseAddress, salt.count,
                CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                rounds,
                &derived, keyLength
            )
        }
        guard status == kCCSuccess else { throw PinStoreError.kdf }
        return Data(derived)
    }

    private static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for (x, y) in zip(a, b) { difference |= x ^ y }
        return difference == 0
    }
}
