package dev.trinityproject.trinity.applock

import java.util.Base64
import java.util.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The record's base64 and the PBKDF2 fallback. Both exist because java.util.Base64 and the
 * PBKDF2WithHmacSHA256 SecretKeyFactory need API 26 and the host's minSdk is 24; the JVM
 * here has both, so they are the reference.
 */
class PinCodecTest {
    private fun hex(text: String): ByteArray =
        ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun encodesTheRfc4648Vectors() {
        val vectors = listOf("" to "", "f" to "Zg==", "fo" to "Zm8=", "foo" to "Zm9v", "foob" to "Zm9vYg==", "fooba" to "Zm9vYmE=", "foobar" to "Zm9vYmFy")
        for ((plain, encoded) in vectors) {
            assertEquals(plain, encoded, PinBase64.encode(plain.toByteArray(Charsets.US_ASCII)))
            assertArrayEquals(plain, plain.toByteArray(Charsets.US_ASCII), PinBase64.decode(encoded))
        }
    }

    @Test
    fun matchesTheJdkCodecForEveryLength() {
        val random = Random(1266)
        for (size in 0..66) {
            val bytes = ByteArray(size).also { random.nextBytes(it) }
            val reference = Base64.getEncoder().encodeToString(bytes)
            assertEquals("size $size", reference, PinBase64.encode(bytes))
            assertArrayEquals("size $size", bytes, PinBase64.decode(reference))
        }
    }

    @Test
    fun refusesAnythingButCanonicalBase64() {
        for (text in listOf("Zg", "Zg=", "Zg===", "Z===", " Zg==", "Zg==\n", "Zm9v\nYmFy", "Zm9v-_==", "Zm9v!", "=Zg=")) {
            assertNull(text, PinBase64.decode(text))
        }
    }

    /** RFC 7914 section 11, the PBKDF2-HMAC-SHA256 vector with one iteration and two blocks. */
    @Test
    fun theMacFallbackMatchesRfc7914() {
        val derived = Pbkdf2.withMac("passwd".toByteArray(Charsets.US_ASCII), "salt".toByteArray(Charsets.US_ASCII), 1, 64)
        assertArrayEquals(
            hex(
                "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc" +
                    "49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783",
            ),
            derived,
        )
    }

    /** Hashes of a PIN are compared with `assertTrue`, whose failure message prints neither. */
    @Test
    fun theMacFallbackMatchesTheKeyFactory() {
        val salt = ByteArray(16) { it.toByte() }
        // Python's hashlib.pbkdf2_hmac("sha256", b"482913", bytes(range(16)), 1000, 32).
        val expected = hex("c244b3eb4f25507ed8b8ad789e97c7d8a4cfa28fc257cbd6fe1612f7fcb694a2")
        assertTrue("key factory", expected.contentEquals(Pbkdf2.withFactory("482913", salt, 1_000)))
        assertTrue(
            "mac fallback",
            expected.contentEquals(Pbkdf2.withMac("482913".toByteArray(Charsets.US_ASCII), salt, 1_000, Pbkdf2.KEY_BYTES)),
        )
        assertTrue("derive", expected.contentEquals(Pbkdf2.derive("482913", salt, 1_000)))
        val random = Random(18)
        for (iterations in listOf(1, 2, 999, 1_000)) {
            val bytes = ByteArray(16).also { random.nextBytes(it) }
            assertTrue(
                "iterations $iterations",
                Pbkdf2.withFactory("0007", bytes, iterations)
                    .contentEquals(Pbkdf2.withMac("0007".toByteArray(Charsets.US_ASCII), bytes, iterations, Pbkdf2.KEY_BYTES)),
            )
        }
    }
}
