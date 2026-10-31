package dev.trinityproject.trinity.push

import java.security.KeyStoreException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class KeystoreCryptoTest {
    private val key: SecretKey = SecretKeySpec(ByteArray(32), "AES")

    @Test
    fun aReadNeverGeneratesAKey() {
        var generated = 0
        val crypto = KeystoreCrypto({ null }, {
            generated++
            key
        })

        assertThrows(KeyStoreException::class.java) { crypto.decrypt("sealed") }

        assertEquals(0, generated)
    }

    @Test
    fun concurrentFirstSealsOnSeparateInstancesGenerateOneKey() {
        val stored = AtomicReference<SecretKey?>()
        val generated = AtomicInteger()
        val start = CountDownLatch(1)
        val sealers = List(8) {
            Thread {
                start.await()
                val crypto = KeystoreCrypto({ stored.get() }, {
                    generated.incrementAndGet()
                    Thread.sleep(50)
                    stored.set(key)
                    key
                })
                // android.util.Base64 is a stub on the JVM, so the seal fails after the key is chosen.
                runCatching { crypto.encrypt("plain") }
            }
        }

        sealers.forEach { it.start() }
        start.countDown()
        sealers.forEach { it.join(5_000) }

        assertEquals(1, generated.get())
    }
}
