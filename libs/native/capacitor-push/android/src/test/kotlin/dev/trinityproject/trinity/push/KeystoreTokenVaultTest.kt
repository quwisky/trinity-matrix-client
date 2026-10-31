package dev.trinityproject.trinity.push

import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KeystoreTokenVaultTest {
    private val user = "@a:hs"
    private val preferences = MemoryPreferences()
    private val crypto = FakeCrypto()
    private val vault = KeystoreTokenVault(preferences, crypto)

    @Test
    fun absentWhenNothingStored() {
        assertEquals(TokenVaultRead.Absent, vault.read(user))
    }

    @Test
    fun aKeystoreFaultReadsAsUnavailableNeverAbsent() {
        assertTrue(vault.write(user, R0))

        crypto.failing = true
        assertEquals(TokenVaultRead.Unavailable, vault.read(user))

        crypto.failing = false
        assertEquals(TokenVaultRead.Record(R0), vault.read(user))
    }

    @Test
    fun damagedJsonReadsAsUnavailable() {
        val damaged = listOf(
            "",
            "null",
            "[]",
            "{ not json",
            "{}",
            """{"lineage":"L","state":"active"}""",
            """{"accessToken":"a0","state":"active"}""",
            """{"accessToken":"a0","lineage":"L"}""",
            """{"accessToken":"a0","lineage":"L","state":"sideways"}""",
            """{"accessToken":7,"lineage":"L","state":"active"}""",
        )
        for (value in damaged) {
            preferences.values["tokens:$user"] = crypto.encrypt(value)
            assertEquals(value, TokenVaultRead.Unavailable, vault.read(user))
        }
    }

    @Test
    fun aRecordRoundTrips() {
        val refused = R0.copy(lineage = "", state = TokenState.REFUSED)
        val bare = TokenRecord("a0", null, null, null, null, null, null, "L", TokenState.ACTIVE)

        for (record in listOf(R0, refused, bare)) {
            assertTrue(vault.write(user, record))
            assertEquals(TokenVaultRead.Record(record), vault.read(user))
        }
    }

    @Test
    fun anUpdateReplacesAStoredRecord() {
        val rotated = R0.copy(accessToken = "a1", refreshToken = "r1")
        assertTrue(vault.write(user, R0))

        assertEquals(TokenVaultWrite.WRITTEN, vault.update(user, rotated))

        assertEquals(TokenVaultRead.Record(rotated), vault.read(user))
    }

    @Test
    fun updateNeverRecreatesARemovedRecord() {
        assertTrue(vault.write(user, R0))
        assertTrue(vault.remove(user))

        assertEquals(TokenVaultWrite.ABSENT, vault.update(user, R0))

        assertEquals(TokenVaultRead.Absent, vault.read(user))
    }

    @Test
    fun twoVaultInstancesSeeOneRecord() {
        val other = KeystoreTokenVault(preferences, crypto)

        assertTrue(vault.write(user, R0))
        assertEquals(TokenVaultRead.Record(R0), other.read(user))

        assertTrue(other.remove(user))
        assertEquals(TokenVaultRead.Absent, vault.read(user))
    }

    @Test
    fun removeAllRemovesEveryRecord() {
        assertTrue(vault.write(user, R0))
        assertTrue(vault.write("@b:hs", R0))

        assertTrue(vault.removeAll())

        assertEquals(TokenVaultRead.Absent, vault.read(user))
        assertEquals(TokenVaultRead.Absent, vault.read("@b:hs"))
    }

    @Test
    fun aWriteFaultIsFailedNotThrown() {
        assertTrue(vault.write(user, R0))

        crypto.failing = true
        assertFalse(vault.write(user, R0.copy(accessToken = "a1")))
        assertEquals(TokenVaultWrite.FAILED, vault.update(user, R0.copy(accessToken = "a1")))

        crypto.failing = false
        assertEquals(TokenVaultRead.Record(R0), vault.read(user))
    }

    @Test
    fun clearingTheHandoffStoreLeavesTokens() {
        assertEquals("trinity_push_tokens", KeystoreTokenVault.FILE)
        assertNotEquals(PushHandoffStore.FILE, KeystoreTokenVault.FILE)
        assertTrue(vault.write(user, R0))

        assertTrue(PushHandoffStore(MemoryPreferences(), crypto).clear())

        assertEquals(TokenVaultRead.Record(R0), vault.read(user))
    }

    @Test
    fun aRemovalOnAnotherInstanceIsNotOverwrittenByAnUpdateInProgress() {
        val sealing = CountDownLatch(1)
        val finishSealing = CountDownLatch(1)
        val gatedCrypto = object : ValueCrypto {
            override fun encrypt(plain: String): String {
                sealing.countDown()
                finishSealing.await(5, TimeUnit.SECONDS)
                return crypto.encrypt(plain)
            }

            override fun decrypt(stored: String): String = crypto.decrypt(stored)
        }
        assertTrue(vault.write(user, R0))

        val updater = Thread { KeystoreTokenVault(preferences, gatedCrypto).update(user, R0.copy(accessToken = "a1")) }
        updater.start()
        assertTrue(sealing.await(5, TimeUnit.SECONDS))
        val remover = Thread { vault.remove(user) }
        remover.start()
        Thread.sleep(100)
        finishSealing.countDown()
        updater.join(5_000)
        remover.join(5_000)

        assertEquals(TokenVaultRead.Absent, vault.read(user))
    }

    @Test
    fun theStoredValueIsSealedUnderTheUserKey() {
        val secret = R0.copy(accessToken = "ACCESS-SECRET", refreshToken = "REFRESH-SECRET")

        assertTrue(vault.write(user, secret))

        assertEquals(setOf("tokens:$user"), preferences.values.keys)
        val stored = preferences.values.getValue("tokens:$user")
        assertFalse(stored.contains("ACCESS-SECRET"))
        assertFalse(stored.contains("REFRESH-SECRET"))
    }

    @Test
    fun aFailedWriteStoresNothing() {
        crypto.failing = true

        assertFalse(vault.write(user, R0))

        assertTrue(preferences.values.isEmpty())
    }

    @Test
    fun nothingPrintsATokenOnAnyPath() {
        val secret = R0.copy(accessToken = "ACCESS-SECRET", refreshToken = "REFRESH-SECRET")
        val printed = ByteArrayOutputStream()
        val out = System.out
        val err = System.err
        System.setOut(PrintStream(printed, true))
        System.setErr(PrintStream(printed, true))
        try {
            vault.write(user, secret)
            vault.read(user)
            vault.update(user, secret)
            crypto.failing = true
            vault.read(user)
            vault.write(user, secret)
            vault.update(user, secret)
            crypto.failing = false
            preferences.values["tokens:$user"] = crypto.encrypt("{\"refreshToken\":\"REFRESH-SECRET\"")
            vault.read(user)
            vault.remove(user)
        } finally {
            System.setOut(out)
            System.setErr(err)
        }

        assertFalse(printed.toString().contains("SECRET"))
    }
}
