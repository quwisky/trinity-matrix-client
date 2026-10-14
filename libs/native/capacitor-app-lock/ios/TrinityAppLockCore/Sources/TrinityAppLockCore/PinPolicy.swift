import Foundation

/// A clock reading: wall-clock epoch milliseconds and seconds since boot, sleep included.
public struct PinClockReading: Equatable {
    public let nowMs: Double
    public let uptimeS: Double

    public init(nowMs: Double, uptimeS: Double) {
        self.nowMs = nowMs
        self.uptimeS = uptimeS
    }
}

public struct PinFailureState: Codable, Equatable {
    public var failures: Int
    public var failureAtMs: Double?
    public var failureUptimeS: Double?

    public init(failures: Int, failureAtMs: Double?, failureUptimeS: Double?) {
        self.failures = failures
        self.failureAtMs = failureAtMs
        self.failureUptimeS = failureUptimeS
    }
}

/// Trinity's PIN rules, mirrored by electron/src/app-lock-pin.ts and the Kotlin `PinPolicy`.
/// All of them run native/app-lock/pin-policy-cases.json; change the fixture and every host
/// together.
public enum PinPolicy {
    private static let waitsFromFifth = [30, 60, 300, 900]
    private static let longestWait = 3600

    /// 4–16 ASCII digits, the whole string. Unicode digits are refused, never normalised.
    public static func isValid(_ pin: String) -> Bool {
        let scalars = pin.unicodeScalars
        guard (4...16).contains(scalars.count) else { return false }
        return scalars.allSatisfy { $0.value >= 0x30 && $0.value <= 0x39 }
    }

    public static func waitSeconds(afterFailures failures: Int) -> Int {
        guard failures >= 5 else { return 0 }
        let index = failures - 5
        return index < waitsFromFifth.count ? waitsFromFifth[index] : longestWait
    }

    /// Both deadlines must pass, so moving the wall clock forward ends nothing early and
    /// moving it back keeps the wait. After a reboot (uptime lower than at the failure) only
    /// the wall clock counts. A failure count without its instants is refused when the record
    /// is decoded (PinVerifier), as Electron's decodePinRecord does, so it never gets here.
    public static func attemptAllowed(_ state: PinFailureState, at clock: PinClockReading) -> Bool {
        let wait = Double(waitSeconds(afterFailures: state.failures))
        guard wait > 0, let failureAt = state.failureAtMs, let failureUptime = state.failureUptimeS else {
            return true
        }
        let rebooted = clock.uptimeS < failureUptime
        let uptimeOk = rebooted || clock.uptimeS - failureUptime >= wait
        let wallOk = clock.nowMs - failureAt >= wait * 1000
        return uptimeOk && wallOk
    }

    /// When the running wait ends by the wall clock, for display; nil when there is none.
    public static func nextAttemptAt(_ state: PinFailureState) -> Double? {
        let wait = waitSeconds(afterFailures: state.failures)
        guard wait > 0, let failureAt = state.failureAtMs else { return nil }
        return failureAt + Double(wait) * 1000
    }
}
