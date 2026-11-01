package dev.trinityproject.trinity.push

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BoundedPushResolverTest {
    private val store = object : HandoffReader {
        override fun account(userId: String) = HandoffAccount("https://hs.example", "token", sound = false)
        override fun room(userId: String, roomId: String) = HandoffRoom("Team", direct = false, encrypted = false)

        override fun notificationText() = NotificationTextMode.SHOW
    }

    private val push = mapOf("trinity_user_id" to "@a:hs", "room_id" to "!r:hs", "event_id" to "\$e")

    private class BlockingApi : MatrixApi {
        val release = CountDownLatch(1)
        val calls = CountDownLatch(1)

        override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): PushEventRead {
            calls.countDown()
            release.await(30, TimeUnit.SECONDS)
            return PushEventRead.Failed
        }

        override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String? = null

        override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? = null
    }

    private class HelloApi : MatrixApi {
        val tokensUsed = CopyOnWriteArrayList<String>()

        override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): PushEventRead {
            tokensUsed += account.accessToken
            return PushEventRead.Event(
                JSONObject()
                    .put("type", "m.room.message")
                    .put("sender", "@c:hs")
                    .put("content", JSONObject().put("msgtype", "m.text").put("body", "hello")),
            )
        }

        override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String = "Carol"

        override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? = null
    }

    private val expired = object : HandoffReader {
        override fun account(userId: String) =
            HandoffAccount("https://hs.example", "token", sound = false, accessTokenExpiresAt = 1_000L)

        override fun room(userId: String, roomId: String) = HandoffRoom("Team", direct = false, encrypted = false)

        override fun notificationText() = NotificationTextMode.SHOW
    }

    /** Answers once [release] opens. */
    private class StalledTokens : PushTokenRefreshing {
        val release = CountDownLatch(1)
        val calls = AtomicInteger()

        override fun refreshForPush(account: String, tokenSeen: String, deadline: Deadline): TokenRefreshResult {
            calls.incrementAndGet()
            release.await(30, TimeUnit.SECONDS)
            return TokenRefreshResult.Gone
        }
    }

    @Test
    fun aStalledFetchFallsBackToTheStoredRoomNameWithinTheBudget() {
        val api = BlockingApi()
        val started = System.nanoTime()

        val outcome = BoundedPushResolver(store, api, budgetMillis = 100).resolve(push)

        val elapsedMillis = (System.nanoTime() - started) / 1_000_000
        api.release.countDown()
        assertTrue("resolution should be cut off, took $elapsedMillis ms", elapsedMillis < 5_000)
        assertTrue(api.calls.await(1, TimeUnit.SECONDS))
        assertEquals(
            PushOutcome.Post(
                "@a:hs",
                "!r:hs",
                "\$e",
                RenderedNotification("Team", "", "New message"),
                direct = false,
                sound = false,
            ),
            outcome,
        )
    }

    @Test
    fun aFailingFetchAlsoFallsBack() {
        val api = object : MatrixApi {
            override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): PushEventRead =
                throw IllegalStateException("boom")

            override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String? = null

            override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? = null
        }

        val outcome = BoundedPushResolver(store, api).resolve(push) as PushOutcome.Post

        assertEquals("Team", outcome.notification.title)
    }

    @Test
    fun aPromptFetchIsRenderedNormally() {
        val outcome = BoundedPushResolver(store, HelloApi()).resolve(push) as PushOutcome.Post

        assertEquals(RenderedNotification("Team", "Carol", "hello"), outcome.notification)
    }

    @Test
    fun anExpiredTokenIsAnsweredAtOnceWithoutAnyRead() {
        val api = BlockingApi()

        val outcome = BoundedPushResolver(expired, api, budgetMillis = 5_000, wallClock = { 1_000L }).resolve(push)

        assertEquals(
            PushOutcome.Post(
                "@a:hs",
                "!r:hs",
                "\$e",
                RenderedNotification("Team", "", "Open Trinity to read this message"),
                direct = false,
                sound = false,
            ),
            outcome,
        )
        assertEquals(1L, api.calls.count)
    }

    @Test
    fun theBudgetFallbackMakesNoRefresh() {
        val tokens = StalledTokens()
        val api = BlockingApi()
        val started = monotonicMillis()

        val outcome = BoundedPushResolver(expired, api, tokens, budgetMillis = 100, wallClock = { 1_000L }).resolve(push)

        val elapsedMillis = monotonicMillis() - started
        tokens.release.countDown()
        assertTrue("resolution should be cut off, took $elapsedMillis ms", elapsedMillis < 5_000)
        assertEquals(1, tokens.calls.get())
        assertEquals(1L, api.calls.count)
        assertEquals(
            RenderedNotification("Team", "", "Open Trinity to read this message"),
            (outcome as PushOutcome.Post).notification,
        )
    }

    // The provider has spent the old token by now, so the answer must still reach the vault. On
    // Android's HTTP stack an interrupt can end the read carrying it. The budget has to clear the
    // grant floor, so this takes just over 3 s.
    @Test(timeout = 30_000L)
    fun aGrantOutlastingTheBudgetStillWritesItsAnswer() {
        val vault = KeystoreTokenVault(MemoryPreferences(), FakeCrypto())
        assertTrue(vault.write("@a:hs", R0.copy(expiresAtMillis = 1L)))
        val store = object : HandoffReader by expired {
            override fun account(userId: String) =
                HandoffAccount("https://hs.example", "a0", sound = false, accessTokenExpiresAt = 1_000L)
        }
        val answerArrives = CountDownLatch(1)
        val interrupted = AtomicBoolean()
        val client = object : TokenGrantClient {
            override fun grant(record: TokenRecord, deadline: Deadline): TokenGrantAnswer {
                try {
                    answerArrives.await(20, TimeUnit.SECONDS)
                } catch (error: InterruptedException) {
                    interrupted.set(true)
                    return TokenGrantAnswer.Failed
                }
                return TokenGrantAnswer.Tokens("a1", "r1", 300L)
            }

            override fun revoke(record: TokenRecord, deadline: Deadline): Boolean = true
        }
        val refresher = TokenRefresher(vault, LeaseTable(), client)

        val outcome = BoundedPushResolver(store, BlockingApi(), refresher, budgetMillis = 3_100, wallClock = { 1_000L })
            .resolve(push) as PushOutcome.Post

        assertEquals("Open Trinity to read this message", outcome.notification.body)
        answerArrives.countDown()
        val giveUpAt = monotonicMillis() + 10_000
        while ((vault.read("@a:hs") as TokenVaultRead.Record).record.accessToken != "a1" && monotonicMillis() < giveUpAt) {
            Thread.sleep(10)
        }
        assertFalse(interrupted.get())
        assertEquals("r1", (vault.read("@a:hs") as TokenVaultRead.Record).record.refreshToken)
    }

    // Android's JSON parser recurses, and any room member can send an event nested deeply enough.
    @Test
    fun aStackOverflowReadingAnEventFallsBack() {
        val api = object : MatrixApi {
            override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): PushEventRead =
                throw StackOverflowError()

            override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String? = null

            override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? = null
        }

        val outcome = BoundedPushResolver(store, api).resolve(push) as PushOutcome.Post

        assertEquals(RenderedNotification("Team", "", "New message"), outcome.notification)
    }

    // After the fallback the process may die, and a grant's answer with it: no grant may start then.
    @Test
    fun aRefreshReachedAfterTheFallbackHasNoBudgetLeft() {
        val fallbackDone = CountDownLatch(1)
        val remaining = AtomicLong(Long.MAX_VALUE)
        val refreshed = CountDownLatch(1)
        val firstRead = AtomicBoolean(true)
        val slowStore = object : HandoffReader by expired {
            override fun account(userId: String): HandoffAccount {
                if (firstRead.getAndSet(false)) fallbackDone.await(5, TimeUnit.SECONDS)
                return expired.account(userId)
            }
        }
        val tokens = object : PushTokenRefreshing {
            override fun refreshForPush(account: String, tokenSeen: String, deadline: Deadline): TokenRefreshResult {
                remaining.set(deadline.remainingMillis())
                refreshed.countDown()
                return TokenRefreshResult.Gone
            }
        }

        BoundedPushResolver(slowStore, BlockingApi(), tokens, budgetMillis = 100, wallClock = { 1_000L }).resolve(push)
        fallbackDone.countDown()

        assertTrue(refreshed.await(5, TimeUnit.SECONDS))
        assertTrue("left ${remaining.get()} ms", remaining.get() <= 0)
    }

    @Test
    fun aPromptRefreshRendersTheMessageWithTheNewToken() {
        val api = HelloApi()
        val tokens = object : PushTokenRefreshing {
            override fun refreshForPush(account: String, tokenSeen: String, deadline: Deadline) =
                TokenRefreshResult.Rotated(R0.copy(accessToken = "new"), unsaved = false)
        }

        val outcome = BoundedPushResolver(expired, api, tokens, wallClock = { 1_000L }).resolve(push) as PushOutcome.Post

        assertEquals(RenderedNotification("Team", "Carol", "hello"), outcome.notification)
        assertEquals(listOf("new"), api.tokensUsed.toList())
    }

    @Test
    fun aStoreThatThrowsStillYieldsTheGenericFallback() {
        val faulty = object : HandoffReader {
            override fun account(userId: String): HandoffAccount? = throw java.security.ProviderException("keystore")

            override fun room(userId: String, roomId: String): HandoffRoom? = throw java.security.ProviderException("keystore")

            override fun notificationText(): String = throw java.security.ProviderException("keystore")
        }

        val outcome = BoundedPushResolver(faulty, BlockingApi(), budgetMillis = 100).resolve(push) as PushOutcome.Post

        assertEquals(RenderedNotification("Trinity", "", "New message"), outcome.notification)
    }

    @Test
    fun theFaultTolerantReaderAsksTheStoreForTheNotificationTextAndFailsClosed() {
        val hiding = object : HandoffReader {
            override fun account(userId: String): HandoffAccount? = null

            override fun room(userId: String, roomId: String): HandoffRoom? = null

            override fun notificationText() = NotificationTextMode.HIDE_ON_LOCK_SCREEN
        }
        val faulty = object : HandoffReader {
            override fun account(userId: String): HandoffAccount? = null

            override fun room(userId: String, roomId: String): HandoffRoom? = null

            override fun notificationText(): String = throw java.security.ProviderException("keystore")
        }

        assertEquals(
            NotificationTextMode.HIDE_ON_LOCK_SCREEN,
            BoundedPushResolver.FaultTolerantReader(hiding).notificationText(),
        )
        assertEquals(
            NotificationTextMode.ALWAYS_HIDE,
            BoundedPushResolver.FaultTolerantReader(faulty).notificationText(),
        )
    }
}
