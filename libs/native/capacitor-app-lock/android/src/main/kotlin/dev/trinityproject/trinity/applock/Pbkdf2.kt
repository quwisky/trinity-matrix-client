package dev.trinityproject.trinity.applock

import java.security.NoSuchAlgorithmException
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * PBKDF2-HMAC-SHA256 for a PIN. The PBKDF2WithHmacSHA256 key factory exists from API 26; on
 * API 24 and 25 (the host's minSdk is 24) the same function runs over the HmacSHA256 Mac,
 * which every API level has. A valid PIN is ASCII, so both see the same password bytes.
 */
internal object Pbkdf2 {
    const val KEY_BYTES = 32
    private const val FACTORY = "PBKDF2WithHmacSHA256"
    private const val MAC = "HmacSHA256"

    fun derive(pin: String, salt: ByteArray, iterations: Int): ByteArray = try {
        withFactory(pin, salt, iterations)
    } catch (error: NoSuchAlgorithmException) {
        val password = pin.toByteArray(Charsets.US_ASCII)
        try {
            withMac(password, salt, iterations, KEY_BYTES)
        } finally {
            password.fill(0)
        }
    }

    fun withFactory(pin: String, salt: ByteArray, iterations: Int): ByteArray {
        val factory = SecretKeyFactory.getInstance(FACTORY)
        val password = pin.toCharArray()
        val spec = PBEKeySpec(password, salt, iterations, KEY_BYTES * 8)
        try {
            return factory.generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
            password.fill('\u0000')
        }
    }

    /**
     * RFC 8018 section 5.2 with HMAC-SHA256 as the pseudorandom function. The U and T
     * blocks are reused across rounds and zeroed afterwards; Mac.doFinal still allocates
     * its own result each round.
     */
    fun withMac(password: ByteArray, salt: ByteArray, iterations: Int, length: Int): ByteArray {
        val mac = Mac.getInstance(MAC)
        mac.init(SecretKeySpec(password, MAC))
        val blockBytes = mac.macLength
        val derived = ByteArray(length)
        val counter = ByteArray(4)
        val u = ByteArray(blockBytes)
        val t = ByteArray(blockBytes)
        var block = 1
        var offset = 0
        try {
            while (offset < length) {
                counter[0] = (block ushr 24).toByte()
                counter[1] = (block ushr 16).toByte()
                counter[2] = (block ushr 8).toByte()
                counter[3] = block.toByte()
                mac.update(salt)
                mac.update(counter)
                mac.doFinal(u, 0)
                u.copyInto(t)
                repeat(iterations - 1) {
                    mac.update(u)
                    mac.doFinal(u, 0)
                    for (i in t.indices) t[i] = (t[i].toInt() xor u[i].toInt()).toByte()
                }
                t.copyInto(derived, offset, 0, minOf(blockBytes, length - offset))
                offset += blockBytes
                block += 1
            }
        } finally {
            u.fill(0)
            t.fill(0)
        }
        return derived
    }
}
