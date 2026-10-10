package dev.trinityproject.trinity.push

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PushResolverTest {
    private class FakeStore(
        private val accounts: Map<String, HandoffAccount>,
        private val rooms: Map<Pair<String, String>, HandoffRoom> = emptyMap(),
    ) : HandoffReader {
        override fun account(userId: String) = accounts[userId]
        override fun room(userId: String, roomId: String) = rooms[userId to roomId]
    }

    private class FakeApi(
        var event: JSONObject? = null,
        var memberName: String? = null,
        var roomName: String? = null,
        val onEvent: () -> Unit = {},
    ) : MatrixApi {
        val accounts = mutableListOf<HandoffAccount>()
        val remainingAtRoomName = mutableListOf<Long>()

        override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): JSONObject? {
            accounts += account
            onEvent()
            return event
        }

        override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String? {
            accounts += account
            return memberName
        }

        override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? {
            accounts += account
            remainingAtRoomName += deadline.remainingMillis()
            return roomName
        }
    }

    private val alice = HandoffAccount("https://a.example", "token-a", sound = true)
    private val bob = HandoffAccount("https://b.example", "token-b", sound = false)

    private fun push(
        user: String? = "@alice:hs",
        room: String? = "!r:hs",
        event: String? = "\$e",
        unread: String? = null,
    ): Map<String, String> = buildMap {
        user?.let { put("trinity_user_id", it) }
        room?.let { put("room_id", it) }
        event?.let { put("event_id", it) }
        unread?.let { put("unread", it) }
    }

    private fun message(type: String = "m.room.message", sender: String = "@carol:hs", body: String = "hello") =
        JSONObject()
            .put("type", type)
            .put("sender", sender)
            .put("content", JSONObject().put("msgtype", "m.text").put("body", body))

    private fun post(outcome: PushOutcome): PushOutcome.Post {
        assertTrue("expected a notification, got $outcome", outcome is PushOutcome.Post)
        return outcome as PushOutcome.Post
    }

    @Test
    fun unknownAccountGetsTheGatewaysFallbackWithoutAnyRequest() {
        val api = FakeApi(event = message())
        val outcome = post(PushResolver(FakeStore(emptyMap()), api).resolve(push()))

        assertEquals(RenderedNotification("Trinity", "", "New message"), outcome.notification)
        assertEquals(true, outcome.sound)
        assertTrue(api.accounts.isEmpty())
    }

    @Test
    fun unauthorizedFetchKeepsTheStoredRoomName() {
        val store = FakeStore(mapOf("@alice:hs" to alice), mapOf(("@alice:hs" to "!r:hs") to HandoffRoom("Team", false)))
        val outcome = post(PushResolver(store, FakeApi(event = null)).resolve(push()))

        assertEquals(RenderedNotification("Team", "", "New message"), outcome.notification)
    }

    @Test
    fun timeoutSpendsTheOneBudgetForLaterReads() {
        var now = 1_000L
        val api = FakeApi(event = null, onEvent = { now += 6_000L })
        val store = FakeStore(mapOf("@alice:hs" to alice))

        val outcome = post(PushResolver(store, api) { now }.resolve(push()))

        assertEquals(RenderedNotification("Trinity", "", "New message"), outcome.notification)
        assertEquals(listOf(-1_000L), api.remainingAtRoomName)
    }

    @Test
    fun roomMissingFromTheStoreTakesItsNameFromStateOrFallsBack() {
        val store = FakeStore(mapOf("@alice:hs" to alice))

        val named = post(PushResolver(store, FakeApi(event = message(), roomName = "Lobby")).resolve(push()))
        val unnamed = post(PushResolver(store, FakeApi(event = message(), roomName = null)).resolve(push()))

        assertEquals("Lobby", named.notification.title)
        assertEquals("Trinity", unnamed.notification.title)
    }

    @Test
    fun storedRoomNeedsNoRoomStateRead() {
        val store = FakeStore(mapOf("@alice:hs" to alice), mapOf(("@alice:hs" to "!r:hs") to HandoffRoom("Team", false)))
        val api = FakeApi(event = message(), memberName = "Carol")

        val outcome = post(PushResolver(store, api).resolve(push()))

        assertEquals(RenderedNotification("Team", "Carol", "hello"), outcome.notification)
        assertTrue(api.remainingAtRoomName.isEmpty())
    }

    @Test
    fun directMessageHasNoSubtitle() {
        val store = FakeStore(mapOf("@alice:hs" to alice), mapOf(("@alice:hs" to "!r:hs") to HandoffRoom("Bob", true)))
        val outcome = post(PushResolver(store, FakeApi(event = message(sender = "@bob:hs", body = "hi"), memberName = "Bob")).resolve(push()))

        assertEquals(RenderedNotification("Bob", "", "hi"), outcome.notification)
        assertEquals(true, outcome.direct)
    }

    @Test
    fun encryptedEventShowsRoomAndSender() {
        val store = FakeStore(mapOf("@alice:hs" to alice), mapOf(("@alice:hs" to "!r:hs") to HandoffRoom("Secret", false)))
        val encrypted = JSONObject().put("type", "m.room.encrypted").put("sender", "@carol:hs").put("content", JSONObject())

        val outcome = post(PushResolver(store, FakeApi(event = encrypted, memberName = "Carol")).resolve(push()))

        assertEquals(RenderedNotification("Secret", "Carol", "Encrypted message"), outcome.notification)
    }

    @Test
    fun usesTheTaggedAccountsCredentialsAndSound() {
        val store = FakeStore(
            mapOf("@alice:hs" to alice, "@bob:hs" to bob),
            mapOf(
                ("@alice:hs" to "!r:hs") to HandoffRoom("Alice's name", false),
                ("@bob:hs" to "!r:hs") to HandoffRoom("Bob's name", false),
            ),
        )
        val api = FakeApi(event = message(), memberName = "Carol")

        val outcome = post(PushResolver(store, api).resolve(push(user = "@bob:hs")))

        assertTrue(api.accounts.isNotEmpty())
        assertTrue(api.accounts.all { it == bob })
        assertEquals("Bob's name", outcome.notification.title)
        assertEquals(false, outcome.sound)
        assertEquals("@bob:hs", outcome.accountId)
    }

    @Test
    fun readPushWithARoomCancelsThatRoom() {
        val outcome = PushResolver(FakeStore(emptyMap()), FakeApi()).resolve(push(event = null, unread = "2"))

        assertEquals(PushOutcome.CancelRoom("@alice:hs", "!r:hs"), outcome)
    }

    @Test
    fun badgeOnlyPushClearsTheAccountAtZeroAndIsIgnoredOtherwise() {
        val resolver = PushResolver(FakeStore(emptyMap()), FakeApi())

        assertEquals(PushOutcome.CancelAccount("@alice:hs"), resolver.resolve(push(room = null, event = null, unread = "0")))
        assertEquals(PushOutcome.Ignore, resolver.resolve(push(room = null, event = null, unread = "3")))
        assertEquals(PushOutcome.Ignore, resolver.resolve(push(user = null, room = null, event = null, unread = "0")))
    }
}
