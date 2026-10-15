package dev.trinityproject.trinity.applock

import android.os.SystemClock
import java.security.MessageDigest
import java.security.SecureRandom

/** Where the verifier record lives. `read` returns null only when there is no record. */
interface PinRecordStore {
    fun read(): String?

    fun write(value: String)

    fun remove()
}

/**
 * A store failure. Read, write and delete stay distinct inside; the plugin answers every one
 * as `storage-unavailable`. Fixed text and never a cause: a Keystore or parser message could
 * quote what it was given.
 */
sealed class PinStoreException(message: String) : Exception(message) {
    /** The record exists but could not be read or decrypted. */
    class Unreadable : PinStoreException("pin-store-unreadable")

    /** The record could not be encrypted or saved. */
    class WriteFailed : PinStoreException("pin-store-write-failed")

    /** The record could not be removed. */
    class DeleteFailed : PinStoreException("pin-store-delete-failed")
}

sealed class PinStatus {
    data class Ready(val set: Boolean, val nextAttemptAt: Double?) : PinStatus()

    data object Unavailable : PinStatus()
}

enum class PinSetResult { COMPLETED, INVALID, UNAVAILABLE }

sealed class PinCheck {
    data object Verified : PinCheck()

    data class Failed(val nextAttemptAt: Double?) : PinCheck()

    data class Delayed(val nextAttemptAt: Double) : PinCheck()

    data object Invalid : PinCheck()

    data object Unavailable : PinCheck()
}

/**
 * The mobile Trinity PIN: one PBKDF2-HMAC-SHA256 record. Never logs, and no result carries
 * the PIN, its hash or its salt. A record that exists but cannot be read is unavailable,
 * never "no PIN": treating it as absent would let a damaged entry open the lock, and setting
 * a new PIN over it would skip the full reset, so `set` refuses it. Only `clear` removes it:
 * the full reset, turning the lock off, and Settings, which the renderer allows only while
 * App lock is readably off or after a fresh system-prompt check (`AppLockService`
 * `clearUnreadablePin` and `changePin`).
 *
 * Every call holds one process-wide lock and saves its record before it answers, so two
 * quick submits (even through two plugin instances) cannot both pass a wait, and a crash
 * cannot forget a failure.
 */
class PinVerifier internal constructor(
    private val store: PinRecordStore,
    private val clock: () -> PinClockReading,
    private val iterations: Int,
    private val kdf: (String, ByteArray, Int) -> ByteArray,
) {
    @JvmOverloads
    constructor(
        store: PinRecordStore,
        clock: () -> PinClockReading = { systemClock() },
        iterations: Int = PRODUCTION_ITERATIONS,
    ) : this(store, clock, iterations, Pbkdf2::derive)

    init {
        // A record written with a cost outside these bounds would read back as damaged.
        require(iterations in PinRecord.MIN_ITERATIONS..PinRecord.MAX_ITERATIONS)
    }

    fun status(): PinStatus {
        synchronized(LOCK) {
            val record = when (val read = readRecord()) {
                Read.Missing -> return PinStatus.Ready(false, null)
                Read.Unreadable -> return PinStatus.Unavailable
                is Read.Present -> read.record
            }
            val state = record.failureState
            val next = if (PinPolicy.attemptAllowed(state, clock())) null else PinPolicy.nextAttemptAt(state)
            return PinStatus.Ready(true, next)
        }
    }

    fun set(pin: String): PinSetResult {
        synchronized(LOCK) {
            // The same format on every path: a PIN verify would refuse is never hashed or stored.
            if (!PinPolicy.isValid(pin)) return PinSetResult.INVALID
            if (readRecord() == Read.Unreadable) return PinSetResult.UNAVAILABLE
            return try {
                val salt = ByteArray(PinRecord.SALT_BYTES).also { SecureRandom().nextBytes(it) }
                val hash = kdf(pin, salt, iterations)
                val record = PinRecord(iterations, PinBase64.encode(salt), PinBase64.encode(hash), 0, null, null)
                store.write(record.encode())
                PinSetResult.COMPLETED
            } catch (error: Exception) {
                PinSetResult.UNAVAILABLE
            }
        }
    }

    fun verify(pin: String): PinCheck {
        synchronized(LOCK) {
            // Electron's order: the record first, so an unreadable record is unavailable for any
            // PIN; then the format, before the wait and the KDF, so a malformed PIN never
            // reaches PBKDF2 and is never counted.
            val record = (readRecord() as? Read.Present)?.record ?: return PinCheck.Unavailable
            if (!PinPolicy.isValid(pin)) return PinCheck.Invalid
            val now = clock()
            if (!PinPolicy.attemptAllowed(record.failureState, now)) {
                return PinCheck.Delayed(PinPolicy.nextAttemptAt(record.failureState) ?: now.nowMs)
            }
            val matches = try {
                val salt = PinBase64.decode(record.salt) ?: return PinCheck.Unavailable
                val expected = PinBase64.decode(record.hash) ?: return PinCheck.Unavailable
                MessageDigest.isEqual(expected, kdf(pin, salt, record.iterations))
            } catch (error: Exception) {
                return PinCheck.Unavailable
            }
            if (matches) {
                val reset = record.copy(failures = 0, failureAtMs = null, failureUptimeS = null)
                return if (save(reset)) PinCheck.Verified else PinCheck.Unavailable
            }
            val failed = record.copy(failures = record.failures + 1, failureAtMs = now.nowMs, failureUptimeS = now.uptimeS)
            // An attempt the record cannot keep is not answered: a failure must be counted.
            return if (save(failed)) PinCheck.Failed(PinPolicy.nextAttemptAt(failed.failureState)) else PinCheck.Unavailable
        }
    }

    /** Remove the record, readable or not; the way past a damaged entry (see the class doc). */
    fun clear(): Boolean {
        synchronized(LOCK) {
            return try {
                store.remove()
                true
            } catch (error: Exception) {
                false
            }
        }
    }

    private sealed class Read {
        data object Missing : Read()

        data object Unreadable : Read()

        data class Present(val record: PinRecord) : Read()
    }

    private fun readRecord(): Read {
        // Exception, not RuntimeException: the store's Keystore and Cipher errors are checked.
        val text = try {
            store.read()
        } catch (error: Exception) {
            return Read.Unreadable
        }
        if (text == null) return Read.Missing
        val record = try {
            PinRecord.decode(text)
        } catch (error: Exception) {
            null
        }
        return if (record == null) Read.Unreadable else Read.Present(record)
    }

    private fun save(record: PinRecord): Boolean = try {
        store.write(record.encode())
        true
    } catch (error: Exception) {
        false
    }

    companion object {
        /** OWASP's current figure for PBKDF2-HMAC-SHA256; stored per record so it can rise. */
        const val PRODUCTION_ITERATIONS = 600_000

        /** One lock for every verifier in the process: there is one record per app. */
        private val LOCK = Any()

        /**
         * Wall-clock time and seconds since boot. `SystemClock.elapsedRealtime()` counts from
         * boot, keeps counting in deep sleep, and no wall-clock change moves it.
         * `uptimeMillis()` stops in deep sleep, so a wait would stretch over a night's sleep.
         */
        @JvmStatic
        fun systemClock(): PinClockReading =
            PinClockReading(System.currentTimeMillis().toDouble(), SystemClock.elapsedRealtime() / 1000.0)
    }
}
