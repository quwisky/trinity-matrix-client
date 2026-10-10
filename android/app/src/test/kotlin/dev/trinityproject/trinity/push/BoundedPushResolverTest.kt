package dev.trinityproject.trinity.push

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BoundedPushResolverTest {
    private val store = object : HandoffReader {
        override fun account(userId: String) = HandoffAccount("https://hs.example", "token", sound = false)
        override fun room(userId: String, roomId: String) = HandoffRoom("Team", direct = false)
    }

    private val push = mapOf("trinity_user_id" to "@a:hs", "room_id" to "!r:hs", "event_id" to "\$e")

    private class BlockingApi : MatrixApi {
        val release = CountDownLatch(1)
        val calls = CountDownLatch(1)

        override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): JSONObject? {
            calls.countDown()
            release.await(30, TimeUnit.SECONDS)
            return null
        }

        override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String? = null

        override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? = null
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
            override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): JSONObject? =
                throw IllegalStateException("boom")

            override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String? = null

            override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? = null
        }

        val outcome = BoundedPushResolver(store, api).resolve(push) as PushOutcome.Post

        assertEquals("Team", outcome.notification.title)
    }

    @Test
    fun aPromptFetchIsRenderedNormally() {
        val api = object : MatrixApi {
            override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): JSONObject =
                JSONObject()
                    .put("type", "m.room.message")
                    .put("sender", "@c:hs")
                    .put("content", JSONObject().put("msgtype", "m.text").put("body", "hello"))

            override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String = "Carol"

            override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? = null
        }

        val outcome = BoundedPushResolver(store, api).resolve(push) as PushOutcome.Post

        assertEquals(RenderedNotification("Team", "Carol", "hello"), outcome.notification)
    }
}
