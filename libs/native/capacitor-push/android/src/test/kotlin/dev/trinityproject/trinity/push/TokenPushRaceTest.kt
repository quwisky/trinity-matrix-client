package dev.trinityproject.trinity.push

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The app and the push service over one account's lease and vault, against a local provider with no
 * reuse tolerance. The service runs in the app's process (the manifest names no other), so these are
 * threads, as in production, sharing one refresher. Only the Keystore and SharedPreferences are stand-ins.
 *
 * The lease has an expiry, and its clock runs on while Android's freezer holds the process, so a
 * freeze can lapse it. The frozen cases here advance the lease's clock for that.
 * Modelled on matrix-rust-sdk's `test_cross_process_concurrent_refresh` and
 * `test_refresh_interrupted_by_suspension_does_not_sign_out`.
 */
class TokenPushRaceTest {
    private val user = "@race-push:hs"
    private val push = mapOf("trinity_user_id" to user, "room_id" to "!r:hs", "event_id" to "\$e")
    private val firstAccess = "race-access-0"
    private val preferences = MemoryPreferences()
    private val vault = KeystoreTokenVault(preferences, FakeCrypto())
    private val store = PushHandoffStore(MemoryPreferences(), FakeCrypto(), KeystoreTokenVault(preferences, FakeCrypto()))
    private val provider = FakeProvider()
    private val leaseClock = AtomicLong(1_000L)
    private val frozenClockLease = LeaseTable({ leaseClock.get() })

    @Before
    fun seedTheHandoffEntry() {
        assertTrue(store.setAccount(user, HandoffAccount(provider.url, "", sound = true, accessTokenExpiresAt = 1L)))
        assertTrue(store.mergeRooms(user, mapOf("!r:hs" to HandoffRoom("Team", direct = false, encrypted = false))))
        seed()
    }

    @After
    fun stopTheProvider() {
        provider.stop()
    }

    /** An expired pair, the one the provider will take. */
    private fun seed(expiresAtMillis: Long? = 1L) {
        provider.reset(firstAccess, "race-refresh-0")
        assertTrue(
            vault.write(
                user,
                R0.copy(
                    accessToken = firstAccess,
                    refreshToken = "race-refresh-0",
                    expiresAtMillis = expiresAtMillis,
                    tokenEndpoint = "${provider.url}/token",
                ),
            ),
        )
    }

    private fun stored(): TokenRecord = (vault.read(user) as TokenVaultRead.Record).record

    private fun refresher(lease: TokenLease = TokenLeases) = TokenRefresher(vault, lease)

    private fun BoundedPushResolver.render(): String = (resolve(push) as PushOutcome.Post).notification.body

    private fun <T> background(call: () -> T): FutureTask<T> = FutureTask(call).also { Thread(it).start() }

    private fun TokenRefresher.asTheApp(token: String = firstAccess) =
        refresh(user, "L", token, TokenRefresher.appDeadline())

    private fun lapseTheLease() {
        leaseClock.addAndGet(2 * TokenBudgets.APP_GRANT_MILLIS + TokenBudgets.LEASE_MARGIN_MILLIS + 1)
    }

    // Lock-then-read: whoever waits for the lease reads the new pair, and spends nothing.
    @Test(timeout = 60_000L)
    fun theAppAndAPushRaceForOneRotation() {
        val refresher = refresher()
        val resolver = BoundedPushResolver(store, HttpMatrixApi(), refresher)
        var appWon = 0
        var pushWon = 0
        for (round in 0 until 8) {
            seed()
            val start = CyclicBarrier(2)
            // Each side leads in turn, by less than the provider takes to answer.
            val app = background {
                start.await()
                if (round % 2 == 1) Thread.sleep(LEAD_MILLIS)
                refresher.asTheApp()
            }
            val shown = background {
                start.await()
                if (round % 2 == 0) Thread.sleep(LEAD_MILLIS)
                resolver.render()
            }

            val answer = app.get(WAIT_SECONDS, TimeUnit.SECONDS)

            assertEquals("round $round", "hello", shown.get(WAIT_SECONDS, TimeUnit.SECONDS))
            when (answer) {
                is TokenRefreshResult.Rotated -> appWon++
                is TokenRefreshResult.Current -> pushWon++
                else -> throw AssertionError("round $round: $answer")
            }
            assertEquals("round $round", FakeProvider.Counts(grants = 1), provider.counts())
            assertEquals("round $round", "race-access-1", stored().accessToken)
            assertEquals("round $round", TokenState.ACTIVE, stored().state)
        }
        assertTrue("the app won $appWon rounds and the push $pushWon", appWon > 0 && pushWon > 0)
    }

    @Test(timeout = 60_000L)
    fun aCallerHoldingAnOldTokenFindsTheRotatedPair() {
        val refresher = refresher()
        assertEquals("hello", BoundedPushResolver(store, HttpMatrixApi(), refresher).render())
        val rotated = stored()

        assertEquals(TokenRefreshResult.Current(rotated), refresher.asTheApp())
        assertEquals(
            TokenRefreshResult.Current(rotated),
            refresher.refreshForPush(user, firstAccess, TokenRefresher.appDeadline()),
        )

        assertEquals(FakeProvider.Counts(grants = 1), provider.counts())
        assertEquals(rotated, stored())
    }

    // No lapse: the lease does its plain job and the queued push reads the pair the app just wrote.
    @Test(timeout = 60_000L)
    fun aPushQueuedBehindAnAppGrantGetsTheNewPair() {
        val refresher = refresher()
        provider.holdAnswers()
        val app = background { refresher.asTheApp() }
        assertTrue("the app's grant never arrived", provider.waitForGrant())

        val shown = background { BoundedPushResolver(store, HttpMatrixApi(), refresher).render() }
        Thread.sleep(LEAD_MILLIS)
        provider.releaseAnswers()

        assertTrue(app.get(WAIT_SECONDS, TimeUnit.SECONDS) is TokenRefreshResult.Rotated)
        assertEquals("hello", shown.get(WAIT_SECONDS, TimeUnit.SECONDS))
        assertEquals(FakeProvider.Counts(grants = 1), provider.counts())
    }

    // Frozen holding the lease, before its read, for longer than the lease lasts. It must not send the
    // token it was asked about, which the push has since spent.
    @Test(timeout = 60_000L)
    fun anAppFrozenHoldingTheLeaseFindsTheRotatedPair() {
        val lease = FreezingLease(frozenClockLease)
        val refresher = refresher(lease)
        val app = background { refresher.asTheApp() }
        assertTrue(lease.holding.await(WAIT_SECONDS, TimeUnit.SECONDS))

        lapseTheLease()
        assertEquals("hello", BoundedPushResolver(store, HttpMatrixApi(), refresher).render())
        lease.thaw.countDown()

        assertEquals(TokenRefreshResult.Current(stored()), app.get(WAIT_SECONDS, TimeUnit.SECONDS))
        assertEquals(FakeProvider.Counts(grants = 1), provider.counts())
        assertEquals("race-access-1", stored().accessToken)
    }

    // Frozen after the grant reached the provider. The push can't know the token is spent, and sending
    // it is the one spent send there is: the refusal must cost nothing. It is not recorded, the app's
    // late answer is kept, and the next push shows the text.
    @Test(timeout = 60_000L)
    fun anAppFrozenMidGrantKeepsTheAccountSignedIn() {
        val refresher = refresher(frozenClockLease)
        val resolver = BoundedPushResolver(store, HttpMatrixApi(), refresher)
        provider.holdAnswers()
        val app = background { refresher.asTheApp() }
        assertTrue("the app's grant never arrived", provider.waitForGrant())

        lapseTheLease()
        assertEquals("Open Trinity to read this message", resolver.render())
        assertEquals("only the app may record a refusal", TokenState.ACTIVE, stored().state)
        provider.releaseAnswers()

        assertTrue(app.get(WAIT_SECONDS, TimeUnit.SECONDS) is TokenRefreshResult.Rotated)
        assertEquals(FakeProvider.Counts(grants = 1, spentSends = 1), provider.counts())
        assertEquals("race-access-1", stored().accessToken)
        assertEquals("hello", resolver.render())
        assertEquals(FakeProvider.Counts(grants = 1, spentSends = 1), provider.counts())
    }

    // Android keeps the process, and so the service, between pushes, and the app rotates between them.
    @Test(timeout = 60_000L)
    fun aReusedServiceReadsTheVaultAgain() {
        val refresher = refresher()
        val resolver = BoundedPushResolver(store, HttpMatrixApi(), refresher)
        assertEquals("hello", resolver.render())
        assertTrue(refresher.asTheApp("race-access-1") is TokenRefreshResult.Rotated)

        assertEquals("hello", resolver.render())

        assertEquals(FakeProvider.Counts(grants = 2), provider.counts())
        assertEquals("race-access-2", stored().accessToken)
    }

    // The vault says the token is good, the homeserver says it isn't: the real stack's 401 refreshes.
    @Test(timeout = 60_000L)
    fun aRejectedTokenRefreshesOnceThroughTheRealStack() {
        seed(expiresAtMillis = null)
        provider.rejectBearer(firstAccess)

        assertEquals("hello", BoundedPushResolver(store, HttpMatrixApi(), refresher()).render())

        assertEquals(FakeProvider.Counts(grants = 1, staleBearers = 1), provider.counts())
        assertEquals("race-access-1", stored().accessToken)
    }

    // Past the budget the push has moved on and the process may die with a grant's answer.
    @Test(timeout = 60_000L)
    fun aSpentBudgetSendsNoGrant() {
        val spent = Deadline(0L, { 1L })

        assertEquals(TokenRefreshResult.Transient, refresher().refreshForPush(user, firstAccess, spent))

        assertEquals(FakeProvider.Counts(), provider.counts())
        assertEquals(firstAccess, stored().accessToken)
    }

    // The app's grant failed late, so the provider spent nothing and the waiting push could still try.
    // It has too little left to be sure of the answer, and sends nothing.
    @Test(timeout = 60_000L)
    fun aLeaseWaitBehindAFailedAppGrantSendsNoGrant() {
        val refresher = refresher()
        provider.failGrants()
        provider.holdAnswers()
        val app = background { refresher.asTheApp() }
        assertTrue("the app's grant never arrived", provider.waitForGrant())
        val budget = Deadline(monotonicMillis() + TokenBudgets.GRANT_FLOOR_MILLIS + 200, ::monotonicMillis)
        val waiting = background { refresher.refreshForPush(user, firstAccess, budget) }

        Thread.sleep(400)
        provider.releaseAnswers()

        assertEquals(TokenRefreshResult.Transient, app.get(WAIT_SECONDS, TimeUnit.SECONDS))
        assertEquals(TokenRefreshResult.Transient, waiting.get(WAIT_SECONDS, TimeUnit.SECONDS))
        assertEquals(FakeProvider.Counts(failedGrants = 1), provider.counts())
        assertEquals(firstAccess, stored().accessToken)
    }

    /** Stops the first caller right after its take, as a freeze there would. */
    private class FreezingLease(private val table: LeaseTable) : TokenLease by table {
        val holding = CountDownLatch(1)
        val thaw = CountDownLatch(1)

        override fun take(account: String, lifetimeMillis: Long, waitMillis: Long): LeaseTicket? {
            val ticket = table.take(account, lifetimeMillis, waitMillis)
            if (holding.count > 0) {
                holding.countDown()
                thaw.await(WAIT_SECONDS, TimeUnit.SECONDS)
            }
            return ticket
        }
    }

    /** Spends a refresh token the moment it arrives, and serves the reads a push makes. */
    private class FakeProvider {
        data class Counts(
            val grants: Int = 0,
            val spentSends: Int = 0,
            val staleBearers: Int = 0,
            val failedGrants: Int = 0,
        )

        private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        private val workers = Executors.newCachedThreadPool()
        private val grantArrived = Semaphore(0)
        private var access = ""
        private var refresh = ""
        private var rejected: String? = null
        private var failing = false
        private var generation = 0
        private var counts = Counts()
        private var heldAnswers: CountDownLatch? = null

        val url: String

        init {
            server.executor = workers
            server.createContext("/token", ::grant)
            server.createContext("/_matrix", ::read)
            server.start()
            url = "http://127.0.0.1:${server.address.port}"
        }

        fun stop() {
            server.stop(0)
            workers.shutdownNow()
        }

        @Synchronized
        fun counts() = counts

        @Synchronized
        fun reset(access: String, refresh: String) {
            this.access = access
            this.refresh = refresh
            rejected = null
            failing = false
            generation = 0
            counts = Counts()
        }

        /** The homeserver no longer takes [token], though the provider still has its refresh token. */
        @Synchronized
        fun rejectBearer(token: String) {
            rejected = token
        }

        /** Every grant answers 500 and spends nothing. */
        @Synchronized
        fun failGrants() {
            failing = true
        }

        /** Grants are spent as usual, but their answers wait for [releaseAnswers]. */
        @Synchronized
        fun holdAnswers() {
            heldAnswers = CountDownLatch(1)
        }

        @Synchronized
        fun releaseAnswers() {
            heldAnswers?.countDown()
            heldAnswers = null
        }

        fun waitForGrant(): Boolean = grantArrived.tryAcquire(WAIT_SECONDS, TimeUnit.SECONDS)

        private fun grant(exchange: HttpExchange) {
            val form = exchange.requestBody.readBytes().decodeToString().split("&")
            var hold: CountDownLatch?
            var failed = false
            val body = synchronized(this) {
                hold = heldAnswers
                if (failing) {
                    failed = true
                    counts = counts.copy(failedGrants = counts.failedGrants + 1)
                    """{"error":"server_error"}"""
                } else if ("refresh_token=$refresh" !in form) {
                    counts = counts.copy(spentSends = counts.spentSends + 1)
                    null
                } else {
                    generation++
                    access = "race-access-$generation"
                    refresh = "race-refresh-$generation"
                    counts = counts.copy(grants = counts.grants + 1)
                    """{"access_token":"$access","refresh_token":"$refresh","expires_in":300}"""
                }
            }
            if (body == null) return send(exchange, 400, """{"error":"invalid_grant"}""")
            grantArrived.release()
            // Long enough that the other side is waiting for the lease when it ends.
            hold?.await(WAIT_SECONDS, TimeUnit.SECONDS) ?: Thread.sleep(ANSWER_DELAY_MILLIS)
            send(exchange, if (failed) 500 else 200, body)
        }

        private fun read(exchange: HttpExchange) {
            val bearer = exchange.requestHeaders.getFirst("Authorization")
            val accepted = synchronized(this) {
                val good = bearer == "Bearer $access" && access != rejected
                if (!good) counts = counts.copy(staleBearers = counts.staleBearers + 1)
                good
            }
            if (!accepted) return send(exchange, 401, """{"errcode":"M_UNKNOWN_TOKEN"}""")
            send(
                exchange,
                200,
                if ("m.room.member" in exchange.requestURI.rawPath) {
                    """{"displayname":"Alice"}"""
                } else {
                    """{"type":"m.room.message","sender":"@alice:hs","content":{"msgtype":"m.text","body":"hello"}}"""
                },
            )
        }

        private fun send(exchange: HttpExchange, status: Int, body: String) {
            val bytes = body.toByteArray()
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
    }

    private companion object {
        const val WAIT_SECONDS = 20L
        const val LEAD_MILLIS = 30L
        const val ANSWER_DELAY_MILLIS = 150L
    }
}
