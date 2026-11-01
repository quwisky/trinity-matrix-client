package dev.trinityproject.trinity.push

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PushResolverTest {
    private class FakeStore(
        private val accounts: Map<String, HandoffAccount>,
        private val rooms: Map<Pair<String, String>, HandoffRoom> = emptyMap(),
        private val mode: String = NotificationTextMode.SHOW,
    ) : HandoffReader {
        override fun account(userId: String) = accounts[userId]
        override fun room(userId: String, roomId: String) = rooms[userId to roomId]
        override fun notificationText() = mode
    }

    /** Answers each event read in turn from [reads], then keeps giving the last. */
    private class FakeApi(
        event: JSONObject? = null,
        var memberName: String? = null,
        var roomName: String? = null,
        val onEvent: () -> Unit = {},
        reads: List<PushEventRead> = listOf(event?.let { PushEventRead.Event(it) } ?: PushEventRead.Failed),
    ) : MatrixApi {
        private val reads = ArrayDeque(reads)
        val accounts = mutableListOf<HandoffAccount>()
        val eventDeadlines = mutableListOf<Deadline>()
        val remainingAtEvent = mutableListOf<Long>()
        val remainingAtRoomName = mutableListOf<Long>()

        override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): PushEventRead {
            accounts += account
            eventDeadlines += deadline
            remainingAtEvent += deadline.remainingMillis()
            onEvent()
            return if (reads.size > 1) reads.removeFirst() else reads.first()
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

    private class FakeTokens(
        private val answer: TokenRefreshResult,
        private val onRefresh: () -> Unit = {},
    ) : PushTokenRefreshing {
        val tokensSeen = mutableListOf<String>()
        var lastDeadline: Deadline? = null
        val calls get() = tokensSeen.size

        override fun refreshForPush(account: String, tokenSeen: String, deadline: Deadline): TokenRefreshResult {
            tokensSeen += tokenSeen
            lastDeadline = deadline
            onRefresh()
            return answer
        }
    }

    private class CountingClient(private val onGrant: () -> Unit = {}) : TokenGrantClient {
        val grants = AtomicInteger()

        override fun grant(record: TokenRecord, deadline: Deadline): TokenGrantAnswer {
            grants.incrementAndGet()
            onGrant()
            return TokenGrantAnswer.Tokens("a1", "r1", 300L)
        }

        override fun revoke(record: TokenRecord, deadline: Deadline): Boolean = true
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
    fun expiredTokenShowsTheOpenTrinityTextWithoutAnyRequest() {
        val expired = alice.copy(accessTokenExpiresAt = 2_000L)
        val store = FakeStore(mapOf("@alice:hs" to expired), mapOf(("@alice:hs" to "!r:hs") to HandoffRoom("Team", false)))
        val api = FakeApi(event = message(), memberName = "Carol", roomName = "Lobby")

        val outcome = post(PushResolver(store, api, wallClock = { 2_000L }).resolve(push()))

        assertEquals(RenderedNotification("Team", "", "Open Trinity to read this message"), outcome.notification)
        assertEquals(true, outcome.sound)
        assertEquals(false, outcome.direct)
        assertTrue(api.accounts.isEmpty())
    }

    @Test
    fun expiredTokenInADmKeepsTheDmPresentation() {
        val expired = alice.copy(accessTokenExpiresAt = 2_000L)
        val store = FakeStore(mapOf("@alice:hs" to expired), mapOf(("@alice:hs" to "!r:hs") to HandoffRoom("Bob", true)))

        val outcome = post(PushResolver(store, FakeApi(), wallClock = { 5_000L }).resolve(push()))

        assertEquals(RenderedNotification("Bob", "", "Open Trinity to read this message"), outcome.notification)
        assertEquals(true, outcome.direct)
    }

    @Test
    fun expiredTokenForARoomNotStoredReadsNoRoomState() {
        val store = FakeStore(mapOf("@alice:hs" to alice.copy(accessTokenExpiresAt = 2_000L)))
        val api = FakeApi(roomName = "Lobby")

        val outcome = post(PushResolver(store, api, wallClock = { 2_000L }).resolve(push()))

        assertEquals(RenderedNotification("Trinity", "", "Open Trinity to read this message"), outcome.notification)
        assertTrue(api.accounts.isEmpty())
    }

    @Test
    fun tokenBeforeItsExpiryIsStillUsed() {
        val store = FakeStore(
            mapOf("@alice:hs" to alice.copy(accessTokenExpiresAt = 2_001L)),
            mapOf(("@alice:hs" to "!r:hs") to HandoffRoom("Team", false, encrypted = false)),
        )
        val api = FakeApi(event = message(), memberName = "Carol")

        val outcome = post(PushResolver(store, api, wallClock = { 2_000L }).resolve(push()))

        assertEquals(RenderedNotification("Team", "Carol", "hello"), outcome.notification)
        assertTrue(api.accounts.isNotEmpty())
    }

    @Test
    fun timeoutSpendsTheOneBudgetForLaterReads() {
        var now = 1_000L
        val api = FakeApi(event = null, onEvent = { now += 9_000L })
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
        val store = FakeStore(mapOf("@alice:hs" to alice), mapOf(("@alice:hs" to "!r:hs") to HandoffRoom("Team", false, encrypted = false)))
        val api = FakeApi(event = message(), memberName = "Carol")

        val outcome = post(PushResolver(store, api).resolve(push()))

        assertEquals(RenderedNotification("Team", "Carol", "hello"), outcome.notification)
        assertTrue(api.remainingAtRoomName.isEmpty())
    }

    @Test
    fun directMessageHasNoSubtitle() {
        val store = FakeStore(mapOf("@alice:hs" to alice), mapOf(("@alice:hs" to "!r:hs") to HandoffRoom("Bob", true, encrypted = false)))
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

    private val team = mapOf(("@alice:hs" to "!r:hs") to HandoffRoom("Team", false, encrypted = false))

    private fun entry(token: String = "old", expired: Boolean) =
        HandoffAccount("https://a.example", token, sound = true, accessTokenExpiresAt = if (expired) 1_000L else null)

    private fun refreshAnswer(name: String?): TokenRefreshResult {
        val renewed = R0.copy(accessToken = "new")
        return when (name) {
            null -> TokenRefreshResult.Gone // A row with no refresh must never ask for one.
            "rotated" -> TokenRefreshResult.Rotated(renewed, unsaved = false)
            "unsaved" -> TokenRefreshResult.Rotated(renewed, unsaved = true)
            "current" -> TokenRefreshResult.Current(renewed)
            "busy" -> TokenRefreshResult.Busy
            "transient" -> TokenRefreshResult.Transient
            "unavailable" -> TokenRefreshResult.Unavailable
            "refused" -> TokenRefreshResult.Refused
            "gone" -> TokenRefreshResult.Gone
            else -> error("unknown refresh answer $name")
        }
    }

    private fun eventRead(name: String): PushEventRead = when (name) {
        "ok" -> PushEventRead.Event(message(sender = "@alice:hs"))
        "unauthorized" -> PushEventRead.Unauthorized
        "failed" -> PushEventRead.Failed
        else -> error("unknown read $name")
    }

    @Test
    fun everySharedTokenFlow() {
        val flows = sharedFixture().getJSONArray("tokenFlows")
        assertEquals(19, flows.length())
        for (index in 0 until flows.length()) {
            val row = flows.getJSONObject(index)
            val name = row.getString("name")
            val refresh = row.opt("refresh") as? String
            val reads = listOf("firstFetch", "secondFetch").mapNotNull { row.opt(it) as? String }.map(::eventRead)
            val answer = refreshAnswer(refresh)
            val api = FakeApi(memberName = "Alice", reads = reads)
            val tokens = FakeTokens(answer)
            val store = FakeStore(mapOf("@alice:hs" to entry(expired = row.getBoolean("tokenExpired"))), team)

            val outcome = post(PushResolver(store, api, { 2_000L }, tokens).resolve(push()))

            assertEquals(name, row.getString("body"), outcome.notification.body)
            assertEquals(name, "Team", outcome.notification.title)
            assertEquals(name, true, outcome.sound)
            assertEquals(name, row.getInt("fetches"), api.eventDeadlines.size)
            assertEquals(name, if (refresh == null) emptyList() else listOf("old"), tokens.tokensSeen)
            if (answer is TokenRefreshResult.Current || answer is TokenRefreshResult.Rotated) {
                assertEquals(name, "new", api.accounts.last().accessToken)
            } else {
                assertTrue(name, api.accounts.all { it.accessToken == "old" })
            }
        }
    }

    @Test
    fun aSecondUnauthorizedReadMakesNoSecondRefresh() {
        val api = FakeApi(reads = listOf(PushEventRead.Unauthorized))
        val tokens = FakeTokens(TokenRefreshResult.Rotated(R0.copy(accessToken = "new"), unsaved = false))
        val store = FakeStore(mapOf("@alice:hs" to entry(expired = false)), team)

        val outcome = post(PushResolver(store, api, tokens = tokens).resolve(push()))

        assertEquals("New message", outcome.notification.body)
        assertEquals(listOf("old", "new"), api.accounts.map { it.accessToken })
        assertEquals(1, tokens.calls)
    }

    @Test
    fun aSecondUnauthorizedReadReadsNoRoomStateWithTheRejectedToken() {
        val afterAnUnauthorizedRead = FakeApi(reads = listOf(PushEventRead.Unauthorized), roomName = "Lobby")
        val afterExpiry = FakeApi(reads = listOf(PushEventRead.Unauthorized), roomName = "Lobby")
        val tokens = FakeTokens(TokenRefreshResult.Rotated(R0.copy(accessToken = "new"), unsaved = false))
        val valid = FakeStore(mapOf("@alice:hs" to entry(expired = false)))
        val expired = FakeStore(mapOf("@alice:hs" to entry(expired = true)))

        val first = post(PushResolver(valid, afterAnUnauthorizedRead, tokens = tokens).resolve(push()))
        val second = post(PushResolver(expired, afterExpiry, tokens = tokens).resolve(push()))

        val shown = RenderedNotification("Trinity", "", "New message")
        assertEquals(shown, first.notification)
        assertEquals(shown, second.notification)
        assertEquals(listOf("old", "new"), afterAnUnauthorizedRead.accounts.map { it.accessToken })
        assertEquals(listOf("new"), afterExpiry.accounts.map { it.accessToken })
    }

    @Test
    fun aTokenlessEntryShowsTheOpenTrinityTextWithoutAFetch() {
        val tokenless = HandoffAccount("https://a.example", "", sound = true).overlaidBy(TokenVaultRead.Absent)
        val api = FakeApi(event = message())
        val client = CountingClient()
        val refresher = TokenRefresher(KeystoreTokenVault(MemoryPreferences(), FakeCrypto()), LeaseTable(), client)

        val outcome = post(PushResolver(FakeStore(mapOf("@alice:hs" to tokenless), team), api, tokens = refresher).resolve(push()))

        assertEquals(RenderedNotification("Team", "", "Open Trinity to read this message"), outcome.notification)
        assertTrue(api.accounts.isEmpty())
        assertEquals(0, client.grants.get())
    }

    @Test
    fun aVaultRecordWithNoHandoffEntryIsNotRefreshed() {
        val vault = KeystoreTokenVault(MemoryPreferences(), FakeCrypto())
        assertTrue(vault.write("@alice:hs", R0.copy(expiresAtMillis = 1L)))
        val api = FakeApi(event = message())
        val client = CountingClient()
        val refresher = TokenRefresher(vault, LeaseTable(), client)

        val outcome = post(PushResolver(FakeStore(emptyMap()), api, tokens = refresher).resolve(push()))

        assertEquals(RenderedNotification("Trinity", "", "New message"), outcome.notification)
        assertEquals(0, client.grants.get())
        assertEquals("a0", (vault.read("@alice:hs") as TokenVaultRead.Record).record.accessToken)
        assertTrue(api.accounts.isEmpty())
    }

    @Test(timeout = 30_000L)
    fun aBurstSharesOneRotation() {
        val vault = KeystoreTokenVault(MemoryPreferences(), FakeCrypto())
        assertTrue(vault.write("@burst:hs", R0.copy(expiresAtMillis = 1L)))
        val client = CountingClient { Thread.sleep(100) }
        val refresher = TokenRefresher(vault, TokenLeases, client)
        val store = FakeStore(
            mapOf("@burst:hs" to entry(token = "a0", expired = true)),
            mapOf(("@burst:hs" to "!r:hs") to HandoffRoom("Team", false, encrypted = false)),
        )
        val readTokens = ConcurrentLinkedQueue<String>()
        val api = object : MatrixApi {
            override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): PushEventRead {
                readTokens += account.accessToken
                return PushEventRead.Event(message())
            }

            override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline) = "Carol"

            override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? = null
        }
        val resolver = PushResolver(store, api, { 2_000L }, refresher)

        val outcomes = List(4) {
            FutureTask { resolver.resolve(push(user = "@burst:hs")) }.also { Thread(it).start() }
        }.map { post(it.get(20, TimeUnit.SECONDS)) }

        assertEquals(1, client.grants.get())
        assertEquals(List(4) { "hello" }, outcomes.map { it.notification.body })
        assertEquals(List(4) { "a1" }, readTokens.toList())
    }

    @Test
    fun theRefreshSharesTheEightSecondDeadline() {
        var now = 1_000L
        val api = FakeApi(event = message(), memberName = "Carol", roomName = "Lobby")
        val tokens = FakeTokens(TokenRefreshResult.Rotated(R0.copy(accessToken = "new"), unsaved = false), onRefresh = { now += 6_000L })
        val store = FakeStore(mapOf("@alice:hs" to entry(expired = true)))

        PushResolver(store, api, { 2_000L }, tokens) { now }.resolve(push())

        assertEquals(1_000L + 8_000L - now, tokens.lastDeadline?.remainingMillis())
        assertEquals(listOf(2_000L), api.remainingAtEvent)
        assertEquals(listOf(2_000L), api.remainingAtRoomName)
        assertTrue(api.eventDeadlines.single() === tokens.lastDeadline)
    }

    @Test
    fun theFirstReadsBudgetAlsoCoversTheRefreshAfterA401() {
        var now = 1_000L
        val api = FakeApi(reads = listOf(PushEventRead.Unauthorized, PushEventRead.Failed), onEvent = { now += 3_000L })
        val tokens = FakeTokens(TokenRefreshResult.Current(R0.copy(accessToken = "new")))
        val store = FakeStore(mapOf("@alice:hs" to entry(expired = false)), team)

        PushResolver(store, api, { 2_000L }, tokens) { now }.resolve(push())

        assertEquals(listOf(8_000L, 5_000L), api.remainingAtEvent)
        assertEquals(1, api.eventDeadlines.toSet().size)
    }

    @Test
    fun alwaysHideNeverRefreshes() {
        val answer = TokenRefreshResult.Rotated(R0.copy(accessToken = "new"), unsaved = false)
        fun store(expired: Boolean) =
            FakeStore(mapOf("@alice:hs" to entry(expired = expired)), team, NotificationTextMode.ALWAYS_HIDE)

        val tokensWhenExpired = FakeTokens(answer)
        val apiWhenExpired = FakeApi(event = message())
        val shown = post(PushResolver(store(true), apiWhenExpired, { 2_000L }, tokensWhenExpired).resolve(push()))
        assertEquals("Open Trinity to read this message", shown.notification.body)
        assertEquals(0, tokensWhenExpired.calls)
        assertTrue(apiWhenExpired.accounts.isEmpty())

        val tokensAfterA401 = FakeTokens(answer)
        val apiAfterA401 = FakeApi(reads = listOf(PushEventRead.Unauthorized))
        post(PushResolver(store(false), apiAfterA401, { 2_000L }, tokensAfterA401).resolve(push()))
        assertEquals(0, tokensAfterA401.calls)
        assertEquals(1, apiAfterA401.eventDeadlines.size)

        // Today's fetch-and-drop: DevicePushHandler replaces what this renders.
        val apiWhenValid = FakeApi(event = message(), memberName = "Carol")
        assertEquals("hello", post(PushResolver(store(false), apiWhenValid).resolve(push())).notification.body)
        assertEquals(1, apiWhenValid.eventDeadlines.size)
    }

    @Test
    fun noRefreshWithNoTokensDependency() {
        val expiredApi = FakeApi(event = message())
        val rejectedApi = FakeApi(reads = listOf(PushEventRead.Unauthorized))
        val expired = FakeStore(mapOf("@alice:hs" to entry(expired = true)), team)
        val rejected = FakeStore(mapOf("@alice:hs" to entry(expired = false)), team)

        val shown = post(PushResolver(expired, expiredApi, { 2_000L }).resolve(push()))
        val afterA401 = post(PushResolver(rejected, rejectedApi, { 2_000L }).resolve(push()))

        assertEquals("Open Trinity to read this message", shown.notification.body)
        assertTrue(expiredApi.accounts.isEmpty())
        assertEquals("New message", afterA401.notification.body)
        assertEquals(1, rejectedApi.eventDeadlines.size)
    }

    @Test
    fun everyReadAfterARefreshUsesTheNewToken() {
        val api = FakeApi(memberName = "Carol", reads = listOf(PushEventRead.Unauthorized, PushEventRead.Event(message())))
        val tokens = FakeTokens(TokenRefreshResult.Rotated(R0.copy(accessToken = "new"), unsaved = false))
        val store = FakeStore(mapOf("@alice:hs" to entry(expired = false)))

        PushResolver(store, api, { 2_000L }, tokens).resolve(push())

        assertEquals(listOf("old", "new", "new", "new"), api.accounts.map { it.accessToken })
    }

    @Test
    fun aRefusedFetchReadsNoRoomStateWithTheRejectedToken() {
        val api = FakeApi(roomName = "Lobby", reads = listOf(PushEventRead.Unauthorized))
        val store = FakeStore(mapOf("@alice:hs" to entry(expired = false)))

        val outcome = post(PushResolver(store, api, tokens = FakeTokens(TokenRefreshResult.Refused)).resolve(push()))

        assertEquals(RenderedNotification("Trinity", "", "New message"), outcome.notification)
        assertTrue(api.remainingAtRoomName.isEmpty())
    }
}
