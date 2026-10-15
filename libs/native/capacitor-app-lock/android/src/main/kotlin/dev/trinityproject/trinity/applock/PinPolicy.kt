package dev.trinityproject.trinity.applock

/** Wall-clock epoch milliseconds and seconds since boot, deep sleep included. */
data class PinClockReading(val nowMs: Double, val uptimeS: Double)

/**
 * A record's failure count and the two instants of its latest failure. The count is a Long
 * because Electron and Swift bound it by Number.MAX_SAFE_INTEGER, not by 32 bits.
 */
data class PinFailureState(val failures: Long, val failureAtMs: Double?, val failureUptimeS: Double?)

/**
 * Trinity's PIN rules, mirrored by electron/src/app-lock-pin.ts and the Swift `PinPolicy`.
 * All run native/app-lock/pin-policy-cases.json; change the fixture and every host together.
 */
object PinPolicy {
    private val WAITS_FROM_FIFTH = intArrayOf(30, 60, 300, 900)
    private const val LONGEST_WAIT = 3600

    /**
     * 4–16 ASCII digits, the whole string. Unicode digits are refused, never normalised:
     * `length` counts UTF-16 units, and any unit outside '0'..'9' fails the second check.
     */
    fun isValid(pin: String): Boolean = pin.length in 4..16 && pin.all { it in '0'..'9' }

    fun waitSeconds(failures: Long): Int {
        if (failures < 5) return 0
        val index = failures - 5
        return if (index < WAITS_FROM_FIFTH.size) WAITS_FROM_FIFTH[index.toInt()] else LONGEST_WAIT
    }

    /**
     * Both deadlines must pass, so moving the wall clock forward ends nothing early and
     * moving it back keeps the wait. After a reboot (uptime lower than at the failure) only
     * the wall clock counts. A failure count without its instants is refused when the record
     * is decoded (PinRecord), as Electron's decodePinRecord does, so it never gets here.
     */
    fun attemptAllowed(state: PinFailureState, clock: PinClockReading): Boolean {
        val wait = waitSeconds(state.failures).toDouble()
        val failureAt = state.failureAtMs
        val failureUptime = state.failureUptimeS
        if (wait == 0.0 || failureAt == null || failureUptime == null) return true
        val rebooted = clock.uptimeS < failureUptime
        val uptimeOk = rebooted || clock.uptimeS - failureUptime >= wait
        val wallOk = clock.nowMs - failureAt >= wait * 1000
        return uptimeOk && wallOk
    }

    /** When the running wait ends by the wall clock, for display; null when there is none. */
    fun nextAttemptAt(state: PinFailureState): Double? {
        val wait = waitSeconds(state.failures)
        val failureAt = state.failureAtMs ?: return null
        return if (wait == 0) null else failureAt + wait * 1000.0
    }
}
