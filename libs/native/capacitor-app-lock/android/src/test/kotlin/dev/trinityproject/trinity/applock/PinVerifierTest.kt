package dev.trinityproject.trinity.applock

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The verifier against an in-memory store. Records hold a salt and a hash, so they are
 * compared with `assertTrue(a == b)`, whose failure message prints neither.
 */
private class MemoryStore : PinRecordStore {
    var text: String? = null
    var failReads = false
    var failWrites = false
    var failRemoves = false
    var writes = 0
        private set

    override fun read(): String? {
        if (failReads) throw PinStoreException.Unreadable()
        return text
    }

    override fun write(value: String) {
        if (failWrites) throw PinStoreException.WriteFailed()
        writes += 1
        text = value
    }

    override fun remove() {
        if (failRemoves) throw PinStoreException.DeleteFailed()
        text = null
    }
}

class PinVerifierTest {
    private var now = 1_700_000_000_000.0
    private var uptime = 5_000.0
    private val derivations = AtomicInteger()

    private fun verifier(store: MemoryStore, iterations: Int = 1_000) = PinVerifier(
        store,
        { PinClockReading(now, uptime) },
        iterations,
        { pin, salt, rounds ->
            derivations.incrementAndGet()
            Pbkdf2.derive(pin, salt, rounds)
        },
    )

    /**
     * A stored record as JSON, edited by `change`, so damaged and inconsistent shapes can be
     * written the way a broken Keystore entry would hold them.
     */
    private fun storedRecord(store: MemoryStore, change: (JSONObject) -> Unit) {
        assertEquals(PinSetResult.COMPLETED, verifier(store).set(PIN))
        val json = JSONObject(checkNotNull(store.text))
        change(json)
        store.text = json.toString()
    }

    private fun storedFailures(store: MemoryStore): Long = JSONObject(checkNotNull(store.text)).getLong("failures")

    @Test
    fun setsVerifiesAndClearsWithoutStoringThePin() {
        val store = MemoryStore()
        val pins = verifier(store)
        assertEquals(PinStatus.Ready(false, null), pins.status())
        assertEquals(PinSetResult.COMPLETED, pins.set(PIN))
        assertFalse(store.text.orEmpty().contains(PIN))
        assertEquals(PinStatus.Ready(true, null), pins.status())
        assertEquals(PinCheck.Verified, pins.verify(PIN))
        assertTrue(pins.clear())
        assertNull(store.text)
        assertEquals(PinStatus.Ready(false, null), pins.status())
    }

    @Test
    fun storesAVersionedPbkdf2Record() {
        val store = MemoryStore()
        assertEquals(PinSetResult.COMPLETED, verifier(store).set(PIN))
        val json = JSONObject(checkNotNull(store.text))
        assertEquals(1, json.getInt("v"))
        assertEquals("pbkdf2-sha256", json.getString("kdf"))
        assertEquals(1_000, json.getInt("iterations"))
        assertEquals(16, checkNotNull(PinBase64.decode(json.getString("salt"))).size)
        assertEquals(32, checkNotNull(PinBase64.decode(json.getString("hash"))).size)
        assertEquals(0L, json.getLong("failures"))
        assertTrue(json.isNull("failureAtMs"))
        assertTrue(json.isNull("failureUptimeS"))
    }

    @Test
    fun theProductionCostIsOwaspsFigure() {
        assertEquals(600_000, PinVerifier.PRODUCTION_ITERATIONS)
    }

    @Test
    fun fifthFailureStartsAWaitThatAClockJumpCannotEnd() {
        val store = MemoryStore()
        assertEquals(PinSetResult.COMPLETED, verifier(store).set(PIN))
        repeat(4) { assertEquals(PinCheck.Failed(null), verifier(store).verify(WRONG)) }
        assertEquals(PinCheck.Failed(now + 30_000), verifier(store).verify(WRONG))
        assertEquals(PinCheck.Delayed(now + 30_000), verifier(store).verify(PIN))
        assertEquals(PinStatus.Ready(true, now + 30_000), verifier(store).status())
        now += 86_400_000.0 // the clock jumped a day forward; uptime did not move
        assertEquals(PinCheck.Delayed(1_700_000_030_000.0), verifier(store).verify(PIN))
        uptime += 30
        assertEquals(PinStatus.Ready(true, null), verifier(store).status())
        assertEquals(PinCheck.Verified, verifier(store).verify(PIN))
        assertEquals(0L, storedFailures(store))
    }

    @Test
    fun movingTheWallClockBackKeepsTheWait() {
        val store = MemoryStore()
        assertEquals(PinSetResult.COMPLETED, verifier(store).set(PIN))
        repeat(5) { verifier(store).verify(WRONG) }
        now -= 3_600_000.0 // the clock moved an hour back while the device slept a minute
        uptime += 60
        assertEquals(PinCheck.Delayed(1_700_000_030_000.0), verifier(store).verify(PIN))
        assertEquals(PinStatus.Ready(true, 1_700_000_030_000.0), verifier(store).status())
    }

    /** After a reboot the since-boot clock restarts lower, and only the wall clock counts. */
    @Test
    fun aRebootLeavesTheWallClockWait() {
        val store = MemoryStore()
        assertEquals(PinSetResult.COMPLETED, verifier(store).set(PIN))
        repeat(5) { verifier(store).verify(WRONG) }
        uptime = 3.0
        now += 10_000
        assertEquals(PinCheck.Delayed(1_700_000_030_000.0), verifier(store).verify(PIN))
        now += 20_000
        assertEquals(PinCheck.Verified, verifier(store).verify(PIN))
    }

    @Test
    fun eachLaterFailureWaitsLonger() {
        val store = MemoryStore()
        assertEquals(PinSetResult.COMPLETED, verifier(store).set(PIN))
        repeat(5) { verifier(store).verify(WRONG) }
        for (wait in listOf(60, 300, 900, 3600, 3600)) {
            now += 3_600_000.0
            uptime += 3_600
            assertEquals(PinCheck.Failed(now + wait * 1000.0), verifier(store).verify(WRONG))
        }
        assertEquals(10L, storedFailures(store))
    }

    @Test
    fun refusesAMalformedPinWithoutCountingIt() {
        val store = MemoryStore()
        val pins = verifier(store)
        assertEquals(PinSetResult.INVALID, pins.set("١٢٣٤"))
        assertEquals(PinSetResult.INVALID, pins.set("１２３４"))
        assertEquals(PinSetResult.INVALID, pins.set("12345678901234567"))
        assertEquals(PinSetResult.INVALID, pins.set("123"))
        assertNull(store.text)
        assertEquals(PinSetResult.COMPLETED, pins.set(PIN))
        val before = store.text
        assertEquals(PinCheck.Invalid, pins.verify("12 34"))
        assertEquals(PinCheck.Invalid, pins.verify("٤٨٢٩١٣"))
        assertEquals(PinCheck.Invalid, pins.verify("123"))
        assertEquals(PinCheck.Invalid, pins.verify(""))
        assertTrue("the record is unchanged", before == store.text)
    }

    /** Review Focus 5: a refused PIN is never hashed, on setPin or on verifyPin. */
    @Test
    fun aMalformedPinNeverReachesPbkdf2() {
        val store = MemoryStore()
        val pins = verifier(store)
        assertEquals(PinSetResult.INVALID, pins.set("١٢٣٤"))
        assertEquals(0, derivations.get())
        assertEquals(PinSetResult.COMPLETED, pins.set(PIN))
        assertEquals(1, derivations.get())
        assertEquals(PinCheck.Invalid, pins.verify("１２３４"))
        assertEquals(PinCheck.Invalid, pins.verify("1234 "))
        assertEquals(1, derivations.get())
    }

    @Test
    fun anUnreadableStoreIsUnavailableNotEmpty() {
        val store = MemoryStore()
        store.failReads = true
        assertEquals(PinStatus.Unavailable, verifier(store).status())
        assertEquals(PinCheck.Unavailable, verifier(store).verify(PIN))
        store.failReads = false
        store.text = "not a record"
        assertEquals(PinStatus.Unavailable, verifier(store).status())
        assertEquals(PinCheck.Unavailable, verifier(store).verify(PIN))
    }

    /** Setting a PIN over a record that cannot be read would skip the full reset. */
    @Test
    fun setNeverOverwritesAnUnreadableRecord() {
        val store = MemoryStore()
        store.failReads = true
        assertEquals(PinSetResult.UNAVAILABLE, verifier(store).set(PIN))
        assertEquals(0, store.writes)
        store.failReads = false
        val damaged = "not a record"
        store.text = damaged
        assertEquals(PinSetResult.UNAVAILABLE, verifier(store).set(PIN))
        assertEquals(damaged, store.text)
        assertEquals(PinCheck.Unavailable, verifier(store).verify(PIN))
        assertTrue(verifier(store).clear())
        assertEquals(PinSetResult.COMPLETED, verifier(store).set(PIN))
        assertEquals(PinCheck.Verified, verifier(store).verify(PIN))
    }

    @Test
    fun setReplacesAReadableRecordAndItsFailures() {
        val store = MemoryStore()
        assertEquals(PinSetResult.COMPLETED, verifier(store).set(PIN))
        repeat(3) { verifier(store).verify(WRONG) }
        assertEquals(PinSetResult.COMPLETED, verifier(store).set("135790"))
        assertEquals(0L, storedFailures(store))
        assertEquals(PinCheck.Failed(null), verifier(store).verify(PIN))
        assertEquals(PinCheck.Verified, verifier(store).verify("135790"))
    }

    @Test
    fun verifyWithoutARecordIsUnavailable() {
        assertEquals(PinCheck.Unavailable, verifier(MemoryStore()).verify(PIN))
        assertEquals(PinCheck.Unavailable, verifier(MemoryStore()).verify("12"))
    }

    /**
     * Electron's order: the record is read before the format is checked, so a malformed PIN
     * against an unreadable record is unavailable, and it still never reaches PBKDF2.
     */
    @Test
    fun aMalformedPinAgainstAnUnreadableRecordIsUnavailable() {
        val store = MemoryStore()
        store.failReads = true
        assertEquals(PinCheck.Unavailable, verifier(store).verify("12"))
        assertEquals(PinCheck.Unavailable, verifier(store).verify("١٢٣٤"))
        store.failReads = false
        store.text = "not a record"
        assertEquals(PinCheck.Unavailable, verifier(store).verify("12 34"))
        assertEquals(0, store.writes)
        assertEquals(0, derivations.get())
    }

    /**
     * A failure count and its two instants exist together or not at all, as Electron's
     * decodePinRecord requires, so a damaged record cannot end a wait early.
     */
    @Test
    fun aFailureCountWithoutItsInstantsIsUnavailable() {
        val missingBoth = MemoryStore()
        storedRecord(missingBoth) { it.put("failures", 9) }
        val hashed = derivations.get()
        assertEquals(PinStatus.Unavailable, verifier(missingBoth).status())
        assertEquals(PinCheck.Unavailable, verifier(missingBoth).verify(PIN))
        assertEquals(PinSetResult.UNAVAILABLE, verifier(missingBoth).set(PIN))
        assertEquals("no attempt reached PBKDF2", hashed, derivations.get())

        val missingUptime = MemoryStore()
        storedRecord(missingUptime) {
            it.put("failures", 5)
            it.put("failureAtMs", 1_700_000_000_000.0)
        }
        assertEquals(PinCheck.Unavailable, verifier(missingUptime).verify(PIN))

        val missingWall = MemoryStore()
        storedRecord(missingWall) {
            it.put("failures", 5)
            it.put("failureUptimeS", 5_000.0)
        }
        assertEquals(PinCheck.Unavailable, verifier(missingWall).verify(PIN))

        val keysRemoved = MemoryStore()
        storedRecord(keysRemoved) {
            it.put("failures", 5)
            it.remove("failureAtMs")
            it.remove("failureUptimeS")
        }
        assertEquals(PinCheck.Unavailable, verifier(keysRemoved).verify(PIN))

        val instantsWithoutCount = MemoryStore()
        storedRecord(instantsWithoutCount) {
            it.put("failureAtMs", 1_700_000_000_000.0)
            it.put("failureUptimeS", 5_000.0)
        }
        assertEquals(PinCheck.Unavailable, verifier(instantsWithoutCount).verify(PIN))
    }

    @Test
    fun refusesDamagedRecordFields() {
        val cases = listOf(
            damage("version") { it.put("v", 2) },
            damage("version as text") { it.put("v", "1") },
            damage("kdf") { it.put("kdf", "scrypt") },
            damage("too few iterations") { it.put("iterations", 999) },
            damage("too many iterations") { it.put("iterations", 5_000_000_000L) },
            damage("iterations as text") { it.put("iterations", "600000") },
            damage("fractional iterations") { it.put("iterations", 1_000.5) },
            damage("short salt") { it.put("salt", PinBase64.encode(ByteArray(8))) },
            damage("salt not base64") { it.put("salt", "not base64!") },
            damage("salt without padding") { it.put("salt", "AAAAAAAAAAAAAAAAAAAAAA") },
            damage("short hash") { it.put("hash", PinBase64.encode(ByteArray(16))) },
            damage("long hash") { it.put("hash", PinBase64.encode(ByteArray(33))) },
            damage("hash as a number") { it.put("hash", 7) },
            damage("negative failures") { it.put("failures", -1) },
            damage("unsafe failures") { it.put("failures", Long.MAX_VALUE) },
            damage("failures past the safe range") {
                it.put("failures", 9_007_199_254_740_992L)
                it.put("failureAtMs", 1_700_000_000_000.0)
                it.put("failureUptimeS", 5_000.0)
            },
            damage("fractional failures") {
                it.put("failures", 5.5)
                it.put("failureAtMs", 1_700_000_000_000.0)
                it.put("failureUptimeS", 5_000.0)
            },
            damage("failures as text") { it.put("failures", "0") },
            damage("instant as text") {
                it.put("failures", 5)
                it.put("failureAtMs", "1700000000000")
                it.put("failureUptimeS", 5_000.0)
            },
            damage("no hash") { it.remove("hash") },
            damage("no salt") { it.remove("salt") },
            damage("no failures") { it.remove("failures") },
        )
        for ((name, change) in cases) {
            val store = MemoryStore()
            storedRecord(store, change)
            assertEquals(name, PinStatus.Unavailable, verifier(store).status())
            assertEquals(name, PinCheck.Unavailable, verifier(store).verify(PIN))
            assertEquals(name, PinSetResult.UNAVAILABLE, verifier(store).set(PIN))
        }
        val notAnObject = MemoryStore()
        notAnObject.text = JSONArray().put(1).toString()
        assertEquals(PinStatus.Unavailable, verifier(notAnObject).status())
    }

    private fun damage(name: String, change: (JSONObject) -> Unit) = name to change

    /** A record keeps the cost it was written with, so the production figure can rise later. */
    @Test
    fun verifiesWithTheRecordsOwnIterations() {
        val store = MemoryStore()
        assertEquals(PinSetResult.COMPLETED, verifier(store, iterations = 1_000).set(PIN))
        assertEquals(PinCheck.Verified, verifier(store, iterations = 2_000).verify(PIN))
        assertEquals(1_000, JSONObject(checkNotNull(store.text)).getInt("iterations"))
    }

    /** An attempt the store cannot record is not answered: a failure must be counted. */
    @Test
    fun anAttemptThatCannotBeSavedIsUnavailable() {
        val store = MemoryStore()
        assertEquals(PinSetResult.COMPLETED, verifier(store).set(PIN))
        verifier(store).verify(WRONG)
        val before = store.text
        store.failWrites = true
        assertEquals(PinCheck.Unavailable, verifier(store).verify(WRONG))
        assertEquals(PinCheck.Unavailable, verifier(store).verify(PIN))
        assertTrue("the record is unchanged", before == store.text)
        assertEquals(PinSetResult.UNAVAILABLE, verifier(store).set("135790"))
        assertTrue("the record is unchanged", before == store.text)
    }

    @Test
    fun clearRemovesAnyRecordAndReportsADeleteFailure() {
        val store = MemoryStore()
        store.text = "not a record"
        store.failRemoves = true
        assertFalse(verifier(store).clear())
        assertEquals("not a record", store.text)
        store.failRemoves = false
        store.failReads = true
        assertTrue(verifier(store).clear())
        store.failReads = false
        assertNull(store.text)
    }

    /** Read, write and delete failures stay distinct inside, and carry fixed text only. */
    @Test
    fun storeErrorsCarryFixedTextOnly() {
        val errors = listOf(
            PinStoreException.Unreadable(),
            PinStoreException.WriteFailed(),
            PinStoreException.DeleteFailed(),
        )
        assertEquals(listOf("pin-store-unreadable", "pin-store-write-failed", "pin-store-delete-failed"), errors.map { it.message })
        for (error in errors) assertNull(error.cause)
    }

    /** Checks run one at a time per record, so concurrent submits cannot all pass a wait. */
    @Test
    fun concurrentAttemptsAreCountedOneAtATime() {
        val store = MemoryStore()
        assertEquals(PinSetResult.COMPLETED, verifier(store).set(PIN))
        // Two verifiers over one record, as two plugin instances would hold: one lock covers both.
        val pins = listOf(verifier(store), verifier(store))
        val results = Collections.synchronizedList(mutableListOf<PinCheck>())
        val gate = CountDownLatch(1)
        val threads = (0 until 12).map { index ->
            Thread {
                gate.await()
                results.add(pins[index % 2].verify(WRONG))
            }.apply { start() }
        }
        gate.countDown()
        threads.forEach { it.join(30_000) }
        assertEquals(12, results.size)
        assertEquals(5, results.count { it is PinCheck.Failed })
        assertEquals(7, results.count { it is PinCheck.Delayed })
        assertEquals(5L, storedFailures(store))
    }

    private companion object {
        const val PIN = "482913"
        const val WRONG = "000000"
    }
}
