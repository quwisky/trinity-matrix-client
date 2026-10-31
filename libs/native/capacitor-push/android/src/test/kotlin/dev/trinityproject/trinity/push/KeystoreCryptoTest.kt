package dev.trinityproject.trinity.push

import java.security.KeyStoreException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

class KeystoreCryptoTest {
    private val key: SecretKey = SecretKeySpec(ByteArray(32), "AES")

    @Test
    fun aReadNeverGeneratesAKey() {
        var generated = 0
        val crypto = KeystoreCrypto("alias", { null }, {
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
                val crypto = KeystoreCrypto("alias", { stored.get() }, {
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

    @Test
    fun theVaultAndTheHandoffStoreSealUnderSeparateAliases() {
        assertEquals("trinity_push_handoff", PushHandoffStore.KEY_ALIAS)
        assertNotEquals(PushHandoffStore.KEY_ALIAS, KeystoreTokenVault.KEY_ALIAS)
    }

    @Test
    fun aLookupFaultUnderOneAliasLeavesTheOtherAliasesKey() {
        val keys = hashMapOf<String, SecretKey>(KeystoreTokenVault.KEY_ALIAS to key)
        val looked = mutableListOf<String>()
        val generated = mutableListOf<String>()
        val faulty = KeystoreCrypto(PushHandoffStore.KEY_ALIAS, {
            looked.add(it)
            null
        }, {
            generated.add(it)
            SecretKeySpec(ByteArray(32) { 1 }, "AES").also { fresh -> keys[it] = fresh }
        })

        // android.util.Base64 is a stub on the JVM, so the seal fails after the key is chosen.
        runCatching { faulty.encrypt("plain") }

        assertEquals(listOf(PushHandoffStore.KEY_ALIAS), looked)
        assertEquals(listOf(PushHandoffStore.KEY_ALIAS), generated)
        assertSame(key, keys[KeystoreTokenVault.KEY_ALIAS])
    }
}
