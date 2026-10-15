package dev.trinityproject.trinity.applock

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The shared rules in native/app-lock/pin-policy-cases.json, which the Electron spec and the
 * Swift suite run too. Every row's name is its assertion message.
 */
class PinPolicyTest {
    private val failureAt = 1_700_000_000_000.0
    private val failureUptime = 5_000.0

    private fun fixture(): JSONObject = JSONObject(
        File(
            checkNotNull(System.getProperty("trinity.pinPolicyCases")) {
                "trinity.pinPolicyCases is unset: run this test through Gradle"
            },
        ).readText(),
    )

    private fun rows(name: String): List<JSONObject> {
        val array: JSONArray = fixture().getJSONArray(name)
        assertTrue("the fixture has $name", array.length() > 0)
        return (0 until array.length()).map { array.getJSONObject(it) }
    }

    @Test
    fun readsTheFixtureVersionItWasWrittenFor() {
        assertEquals(1, fixture().getInt("version"))
    }

    @Test
    fun sharedFormats() {
        for (row in rows("formats")) {
            assertEquals(row.getString("name"), row.getBoolean("valid"), PinPolicy.isValid(row.getString("pin")))
        }
    }

    /** The whole string, ASCII only: no other Unicode digit class, no combining mark. */
    @Test
    fun refusesEveryNonAsciiDigit() {
        assertFalse("mathematical digits", PinPolicy.isValid("𝟏𝟐𝟑𝟒"))
        assertFalse("Devanagari digits", PinPolicy.isValid("१२३४"))
        assertFalse("Arabic-Indic digits", PinPolicy.isValid("١٢٣٤"))
        assertFalse("full-width digits", PinPolicy.isValid("１２３４"))
        assertFalse("combining mark", PinPolicy.isValid("1234́"))
        assertFalse("leading space", PinPolicy.isValid(" 1234"))
        assertFalse("trailing NUL", PinPolicy.isValid("1234\u0000"))
        assertFalse("sixteen digits and a newline", PinPolicy.isValid("1234567890123456\n"))
    }

    @Test
    fun sharedDelays() {
        for (row in rows("delays")) {
            val failures = row.getLong("failures")
            assertEquals("failures $failures", row.getInt("waitSeconds"), PinPolicy.waitSeconds(failures))
        }
    }

    /** A count far past the schedule keeps the longest wait; it never wraps into a short one. */
    @Test
    fun aHugeFailureCountKeepsTheLongestWait() {
        assertEquals(3600, PinPolicy.waitSeconds(4_294_967_301L))
        assertEquals(3600, PinPolicy.waitSeconds(9_007_199_254_740_991L))
        assertEquals(0, PinPolicy.waitSeconds(-1L))
    }

    @Test
    fun sharedAttempts() {
        for (row in rows("attempts")) {
            val failures = row.getLong("failures")
            val state = PinFailureState(
                failures,
                if (failures > 0) failureAt else null,
                if (failures > 0) failureUptime else null,
            )
            val clock = PinClockReading(
                failureAt + row.getDouble("wallElapsedSeconds") * 1000,
                if (row.getBoolean("rebooted")) 3.0 else failureUptime + row.getDouble("uptimeElapsedSeconds"),
            )
            assertEquals(row.getString("name"), row.getBoolean("allowed"), PinPolicy.attemptAllowed(state, clock))
        }
    }

    @Test
    fun theNextAttemptIsTheWallClockDeadline() {
        assertEquals(null, PinPolicy.nextAttemptAt(PinFailureState(4, failureAt, failureUptime)))
        assertEquals(failureAt + 30_000, PinPolicy.nextAttemptAt(PinFailureState(5, failureAt, failureUptime)))
        assertEquals(failureAt + 3_600_000, PinPolicy.nextAttemptAt(PinFailureState(12, failureAt, failureUptime)))
        assertEquals(null, PinPolicy.nextAttemptAt(PinFailureState(5, null, null)))
    }
}
