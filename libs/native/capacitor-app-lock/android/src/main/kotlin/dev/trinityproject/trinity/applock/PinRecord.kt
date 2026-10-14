package dev.trinityproject.trinity.applock

import org.json.JSONObject

/**
 * The stored verifier: PBKDF2 cost, salt and hash (base64), and the failure state. The same
 * shape as the Swift `PinRecord`; nothing in it is the PIN.
 */
internal data class PinRecord(
    val iterations: Int,
    val salt: String,
    val hash: String,
    val failures: Long,
    val failureAtMs: Double?,
    val failureUptimeS: Double?,
) {
    val failureState: PinFailureState get() = PinFailureState(failures, failureAtMs, failureUptimeS)

    fun encode(): String = JSONObject()
        .put("v", VERSION)
        .put("kdf", KDF)
        .put("iterations", iterations)
        .put("salt", salt)
        .put("hash", hash)
        .put("failures", failures)
        .put("failureAtMs", failureAtMs ?: JSONObject.NULL)
        .put("failureUptimeS", failureUptimeS ?: JSONObject.NULL)
        .toString()

    companion object {
        const val VERSION = 1L
        const val KDF = "pbkdf2-sha256"
        const val MIN_ITERATIONS = 1_000

        /** The most a stored record may ask for, so a damaged one cannot stall every attempt. */
        const val MAX_ITERATIONS = 10_000_000
        const val SALT_BYTES = 16

        /** Number.MAX_SAFE_INTEGER, Electron's bound on a stored failure count. */
        private const val MAX_COUNT = 9_007_199_254_740_991L

        /**
         * The stored record, or null for anything damaged; never throws. Field by field, as
         * Electron's decodePinRecord and the Swift decoder: known version and KDF, a bounded
         * iteration count, a salt of at least 16 bytes, a 32-byte hash, a whole failure count
         * within the safe range, and instants that are finite numbers, present together with a
         * non-zero count and absent (or null) with a zero one. A damaged record cannot end a
         * wait early. Parser errors are dropped, never surfaced: their text can quote the input.
         */
        fun decode(text: String): PinRecord? {
            val json = try {
                JSONObject(text)
            } catch (error: RuntimeException) {
                return null
            }
            if (count(json.opt("v")) != VERSION || json.opt("kdf") != KDF) return null
            val iterations = count(json.opt("iterations")) ?: return null
            if (iterations !in MIN_ITERATIONS.toLong()..MAX_ITERATIONS.toLong()) return null
            val salt = json.opt("salt") as? String ?: return null
            val hash = json.opt("hash") as? String ?: return null
            val saltBytes = PinBase64.decode(salt) ?: return null
            val hashBytes = PinBase64.decode(hash) ?: return null
            if (saltBytes.size < SALT_BYTES || hashBytes.size != Pbkdf2.KEY_BYTES) return null
            val failures = count(json.opt("failures")) ?: return null
            val failureAt = json.opt("failureAtMs")
            val failureUptime = json.opt("failureUptimeS")
            if (!isInstant(failureAt) || !isInstant(failureUptime)) return null
            val failureAtMs = (failureAt as? Number)?.toDouble()
            val failureUptimeS = (failureUptime as? Number)?.toDouble()
            val counted = failures > 0
            if ((failureAtMs != null) != counted || (failureUptimeS != null) != counted) return null
            return PinRecord(iterations.toInt(), salt, hash, failures, failureAtMs, failureUptimeS)
        }

        /** A whole JSON number from 0 to MAX_COUNT, whatever type the parser gave it. */
        private fun count(value: Any?): Long? {
            if (value !is Number) return null
            val number = value.toDouble()
            if (!number.isFinite() || number != Math.floor(number) || number < 0 || number > MAX_COUNT) return null
            return number.toLong()
        }

        /** Absent, JSON null, or a finite number. */
        private fun isInstant(value: Any?): Boolean =
            value == null || value == JSONObject.NULL || (value is Number && value.toDouble().isFinite())
    }
}

/**
 * Canonical base64 with padding, the record's encoding on every host. java.util.Base64 needs
 * API 26 and android.util.Base64 is not on the JVM test classpath, so the record has its own.
 * `decode` takes only what Electron's `BASE64` pattern takes, and answers null for the rest.
 */
internal object PinBase64 {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private val CANONICAL = Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size + 2) / 3 * 4)
        var index = 0
        while (index < bytes.size) {
            val remaining = bytes.size - index
            val first = bytes[index].toInt() and 0xff
            val second = if (remaining > 1) bytes[index + 1].toInt() and 0xff else 0
            val third = if (remaining > 2) bytes[index + 2].toInt() and 0xff else 0
            val group = (first shl 16) or (second shl 8) or third
            out.append(ALPHABET[(group shr 18) and 63])
            out.append(ALPHABET[(group shr 12) and 63])
            out.append(if (remaining > 1) ALPHABET[(group shr 6) and 63] else '=')
            out.append(if (remaining > 2) ALPHABET[group and 63] else '=')
            index += 3
        }
        return out.toString()
    }

    fun decode(text: String): ByteArray? {
        if (!CANONICAL.matches(text)) return null
        val padding = text.takeLastWhile { it == '=' }.length
        val out = ByteArray(text.length / 4 * 3 - padding)
        var written = 0
        for (start in text.indices step 4) {
            var group = 0
            for (offset in 0 until 4) {
                val char = text[start + offset]
                group = (group shl 6) or (if (char == '=') 0 else ALPHABET.indexOf(char))
            }
            for (shift in intArrayOf(16, 8, 0)) {
                if (written < out.size) out[written++] = (group shr shift).toByte()
            }
        }
        return out
    }
}
