package dev.trinityproject.trinity.push

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Real threads over real vaults: each refresher has its own vault, as the plugin and the service do. */
class TokenRefresherRaceTest {
    private class ScriptedClient(private val answer: TokenGrantAnswer, private val hold: () -> Unit = {}) : TokenGrantClient {
        val entered = CountDownLatch(1)
        val grants = AtomicInteger()

        override fun grant(record: TokenRecord, deadline: Deadline): TokenGrantAnswer {
            grants.incrementAndGet()
            entered.countDown()
            hold()
            return answer
        }

        override fun revoke(record: TokenRecord, deadline: Deadline): Boolean = true
    }

    private val user = "@race:hs"
    private val preferences = MemoryPreferences()
    private val vault = KeystoreTokenVault(preferences, FakeCrypto())
    private val clock = AtomicLong(1_000L)
    private val manualLease = LeaseTable({ clock.get() })
    private val release = CountDownLatch(1)
    private val a1r1 = TokenGrantAnswer.Tokens("a1", "r1", 300L)
    private val a2r2 = TokenGrantAnswer.Tokens("a2", "r2", 300L)

    @Before
    fun seed() {
        assertTrue(vault.write(user, R0))
    }

    private fun stored(): TokenRecord = (vault.read(user) as TokenVaultRead.Record).record

    private fun refresher(lease: TokenLease, client: TokenGrantClient) =
        TokenRefresher(KeystoreTokenVault(preferences, FakeCrypto()), lease, client)

    private fun gated(answer: TokenGrantAnswer) = ScriptedClient(answer) { release.await(WAIT_SECONDS, TimeUnit.SECONDS) }

    private fun TokenRefresher.refreshOnThread() = onThread { refresh(user, "L", "a0", TokenRefresher.appDeadline()) }

    private fun lapseTheManualLease() {
        clock.addAndGet(2 * TokenBudgets.APP_GRANT_MILLIS + TokenBudgets.LEASE_MARGIN_MILLIS + 1)
    }

    @Test(timeout = 30_000L)
    fun pluginAndServiceShareOneGrant() {
        val threads = 8
        val allCalling = CountDownLatch(threads)
        val client = ScriptedClient(a1r1) {
            allCalling.await(WAIT_SECONDS, TimeUnit.SECONDS)
            Thread.sleep(100)
        }
        val plugin = TokenRefresher(KeystoreTokenVault(preferences, FakeCrypto()), client = client)
        val service = TokenRefresher(KeystoreTokenVault(preferences, FakeCrypto()), client = client)

        val results = List(threads) { index ->
            onThread {
                allCalling.countDown()
                (if (index % 2 == 0) plugin else service).refresh(user, "L", "a0", TokenRefresher.appDeadline())
            }
        }.map { it.get(WAIT_SECONDS, TimeUnit.SECONDS) }

        assertEquals(1, client.grants.get())
        assertEquals(1, results.filterIsInstance<TokenRefreshResult.Rotated>().size)
        assertEquals(threads - 1, results.filterIsInstance<TokenRefreshResult.Current>().size)
        assertEquals("a1", stored().accessToken)
    }

    @Test(timeout = 30_000L)
    fun aLapsedHolderDiscardsItsLateAnswer() {
        val clientA = gated(a1r1)
        val a = refresher(manualLease, clientA).refreshOnThread()
        assertTrue(clientA.entered.await(WAIT_SECONDS, TimeUnit.SECONDS))

        lapseTheManualLease()
        val b = refresher(manualLease, ScriptedClient(a2r2)).refreshOnThread().get(WAIT_SECONDS, TimeUnit.SECONDS)
        assertTrue(b is TokenRefreshResult.Rotated)
        release.countDown()

        assertEquals(TokenRefreshResult.Current(stored()), a.get(WAIT_SECONDS, TimeUnit.SECONDS))
        assertEquals("a2", stored().accessToken)
        assertEquals("r2", stored().refreshToken)
    }

    @Test(timeout = 30_000L)
    fun removalDuringAGrantIsNotResurrected() {
        val lease = LeaseTable()
        val client = gated(a1r1)
        val a = refresher(lease, client).refreshOnThread()
        assertTrue(client.entered.await(WAIT_SECONDS, TimeUnit.SECONDS))

        assertTrue(refresher(lease, ScriptedClient(a2r2)).remove(user))
        release.countDown()

        assertEquals(TokenRefreshResult.Gone, a.get(WAIT_SECONDS, TimeUnit.SECONDS))
        assertEquals(TokenVaultRead.Absent, vault.read(user))
    }

    @Test(timeout = 30_000L)
    fun aNewerSignInDuringAGrantIsNotOverwritten() {
        val client = gated(a1r1)
        val a = refresher(manualLease, client).refreshOnThread()
        assertTrue(client.entered.await(WAIT_SECONDS, TimeUnit.SECONDS))

        lapseTheManualLease()
        val newer = R0.copy(accessToken = "a9", refreshToken = "r9", lineage = "L2")
        assertTrue(refresher(manualLease, ScriptedClient(a2r2)).migrate(newer, user))
        release.countDown()

        assertEquals(TokenRefreshResult.Gone, a.get(WAIT_SECONDS, TimeUnit.SECONDS))
        assertEquals("L2", stored().lineage)
        assertEquals("a9", stored().accessToken)
    }

    // The lease clock ticks on each read, so the eight seconds of waiting pass in about a second.
    @Test(timeout = 30_000L)
    fun migrationOnABusyLeaseIsNotStored() {
        val ticking = LeaseTable({ clock.addAndGet(200L) })
        val client = gated(a1r1)
        val a = refresher(ticking, client).refreshOnThread()
        assertTrue(client.entered.await(WAIT_SECONDS, TimeUnit.SECONDS))

        assertFalse(refresher(ticking, ScriptedClient(a2r2)).migrate(R0.copy(lineage = "L2"), user))

        assertEquals("L", stored().lineage)
        release.countDown()
        assertTrue(a.get(WAIT_SECONDS, TimeUnit.SECONDS) is TokenRefreshResult.Rotated)
        assertEquals("L", stored().lineage)
    }

    @Test(timeout = 30_000L)
    fun anAppRefusalRacingARotationIsTransient() {
        val clientA = gated(TokenGrantAnswer.Refused)
        val a = refresher(manualLease, clientA).refreshOnThread()
        assertTrue(clientA.entered.await(WAIT_SECONDS, TimeUnit.SECONDS))

        lapseTheManualLease()
        refresher(manualLease, ScriptedClient(a2r2)).refreshOnThread().get(WAIT_SECONDS, TimeUnit.SECONDS)
        release.countDown()

        assertEquals(TokenRefreshResult.Transient, a.get(WAIT_SECONDS, TimeUnit.SECONDS))
        assertEquals("a2", stored().accessToken)
        assertEquals(TokenState.ACTIVE, stored().state)
    }

    @Test(timeout = 30_000L)
    fun aPushRefusalRacingARotationIsCurrent() {
        val clientA = gated(TokenGrantAnswer.Refused)
        val push = refresher(manualLease, clientA)
        val a = onThread { push.refreshForPush(user, "a0", TokenRefresher.appDeadline()) }
        assertTrue(clientA.entered.await(WAIT_SECONDS, TimeUnit.SECONDS))

        lapseTheManualLease()
        refresher(manualLease, ScriptedClient(a2r2)).refreshOnThread().get(WAIT_SECONDS, TimeUnit.SECONDS)
        release.countDown()

        assertEquals(TokenRefreshResult.Current(stored()), a.get(WAIT_SECONDS, TimeUnit.SECONDS))
        assertEquals("a2", stored().accessToken)
        assertEquals(TokenState.ACTIVE, stored().state)
    }

    @Test(timeout = 30_000L)
    fun aPushRefusalIsNotRecorded() {
        val lease = LeaseTable()
        val push = refresher(lease, ScriptedClient(TokenGrantAnswer.Refused))

        val refused = onThread { push.refreshForPush(user, "a0", TokenRefresher.appDeadline()) }

        assertEquals(TokenRefreshResult.Refused, refused.get(WAIT_SECONDS, TimeUnit.SECONDS))
        assertEquals(TokenState.ACTIVE, stored().state)

        val app = refresher(lease, ScriptedClient(a1r1)).refreshOnThread().get(WAIT_SECONDS, TimeUnit.SECONDS)

        assertTrue(app is TokenRefreshResult.Rotated)
        assertEquals("a1", stored().accessToken)
    }

    private companion object {
        const val WAIT_SECONDS = 20L
    }
}
