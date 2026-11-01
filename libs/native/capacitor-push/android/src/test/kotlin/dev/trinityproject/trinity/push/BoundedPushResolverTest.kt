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

    /** Answers once [release] opens, recording what it saw. */
    private class StalledTokens : PushTokenRefreshing {
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val calls = AtomicInteger()
        val interrupted = AtomicBoolean()

        override fun refreshForPush(account: String, tokenSeen: String, deadline: Deadline): TokenRefreshResult {
            calls.incrementAndGet()
            try {
                release.await(30, TimeUnit.SECONDS)
            } catch (error: InterruptedException) {
                interrupted.set(true)
            }
            interrupted.compareAndSet(false, Thread.currentThread().isInterrupted)
            finished.countDown()
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

    // The provider may have spent the old token by now. On Android's HTTP stack an interrupt can end
    // the read that would have carried the new one, and the next refresh is then refused.
    @Test
    fun theBudgetFallbackLeavesARefreshInFlightToFinish() {
        val tokens = StalledTokens()

        BoundedPushResolver(expired, BlockingApi(), tokens, budgetMillis = 100, wallClock = { 1_000L }).resolve(push)
        tokens.release.countDown()

        assertTrue(tokens.finished.await(5, TimeUnit.SECONDS))
        assertFalse(tokens.interrupted.get())
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
