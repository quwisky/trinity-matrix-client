package dev.trinityproject.trinity.push

import org.json.JSONObject

/**
 * One account's credentials as the app stored them; never a refresh token.
 * [accessTokenExpiresAt] is when the token stops working (epoch ms), for an OAuth account
 * whose server gave it a lifetime; null when it does not expire on a schedule.
 */
data class HandoffAccount(
    val homeserverUrl: String,
    val accessToken: String,
    val sound: Boolean,
    val accessTokenExpiresAt: Long? = null,
) {
    /** Whether the token had expired at [nowMillis]. A token without an expiry never has. */
    fun tokenExpired(nowMillis: Long): Boolean = accessTokenExpiresAt != null && nowMillis >= accessTokenExpiresAt

    fun with(record: TokenRecord): HandoffAccount =
        copy(accessToken = record.accessToken, accessTokenExpiresAt = record.expiresAtMillis)

    /**
     * The account as the vault says it is. A record replaces the stored token and expiry. With none,
     * a stored token stays (password and unmigrated accounts); an entry with no token reads as expired.
     */
    fun overlaidBy(read: TokenVaultRead): HandoffAccount = when {
        read is TokenVaultRead.Record -> with(read.record)
        accessToken.isEmpty() -> copy(accessTokenExpiresAt = 1L)
        else -> this
    }
}

/** Read side of the push handoff store. */
interface HandoffReader {
    fun account(userId: String): HandoffAccount?
    fun room(userId: String, roomId: String): HandoffRoom?

    /**
     * What a rendered push may show ([NotificationTextMode]). No default: every reader, a
     * wrapper included, must answer, so none can fall open to Show by forgetting to.
     */
    fun notificationText(): String
}

/** What reading an event answered. Only a 401 says the token itself was rejected. */
sealed interface PushEventRead {
    data class Event(val json: JSONObject) : PushEventRead {
        override fun toString(): String = "Event"
    }

    data object Unauthorized : PushEventRead

    data object Failed : PushEventRead
}

/** The client-server reads the renderer makes. Every failed name read is null. */
interface MatrixApi {
    fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): PushEventRead
    fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String?
    fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String?
}

fun monotonicMillis(): Long = System.nanoTime() / 1_000_000

/**
 * Wall-clock epoch milliseconds, compared with the stored token expiry. A type of its own, so
 * it cannot be passed where the monotonic read-budget clock (`() -> Long`) goes, or the other
 * way round; a lambda still converts to it.
 */
fun interface WallClock {
    fun nowMillis(): Long

    companion object {
        val SYSTEM = WallClock { System.currentTimeMillis() }
    }
}

/** One budget shared by every read for a push. */
class Deadline(private val endsAtMillis: Long, private val clock: () -> Long) {
    fun remainingMillis(): Long = endsAtMillis - clock()

    companion object {
        const val BUDGET_MILLIS = 8_000L

        fun start(clock: () -> Long = ::monotonicMillis): Deadline =
            Deadline(clock() + BUDGET_MILLIS, clock)
    }
}

/** What to do with one push. */
sealed interface PushOutcome {
    data class Post(
        val accountId: String?,
        val roomId: String?,
        val eventId: String,
        val notification: RenderedNotification,
        val direct: Boolean,
        val sound: Boolean,
    ) : PushOutcome

    /** The room was read: drop its notification. */
    data class CancelRoom(val accountId: String?, val roomId: String) : PushOutcome

    /** A badge-only push with nothing unread: drop the account's notifications. */
    data class CancelAccount(val accountId: String) : PushOutcome

    data object Ignore : PushOutcome
}

/**
 * Turns a gateway push (`event_id`, `room_id`, `trinity_user_id`, `unread`) into what to
 * post. A token the store marks expired is not sent: it is refreshed first, and a 401 refreshes
 * once too. The push shows the room name with the expired-token text when an expired token could
 * not be refreshed. Any other failed read shows the room-name fallback.
 *
 * Only an account with a handoff entry can refresh: a vault record may outlive sign-out while its
 * revocation is pending.
 */
class PushResolver(
    private val store: HandoffReader,
    private val api: MatrixApi,
    private val wallClock: WallClock = WallClock.SYSTEM,
    private val tokens: PushTokenRefreshing? = null,
    /** Monotonic milliseconds for the read budget. Last, so a trailing lambda still sets it. */
    private val clock: () -> Long = ::monotonicMillis,
) {
    /** [deadline] covers every read and the refresh. */
    fun resolve(data: Map<String, String>, deadline: Deadline = Deadline.start(clock)): PushOutcome {
        val accountId = data["trinity_user_id"]
        val roomId = data["room_id"]
        val eventId = data["event_id"]
            ?: return when {
                roomId != null -> PushOutcome.CancelRoom(accountId, roomId)
                // Synapse's badge-only push carries neither event nor room.
                accountId != null && data["unread"] == "0" -> PushOutcome.CancelAccount(accountId)
                else -> PushOutcome.Ignore
            }
        var account = accountId?.let(store::account)
        if (accountId == null || account == null || roomId == null) {
            return PushOutcome.Post(
                accountId,
                roomId,
                eventId,
                RenderedNotification(PushRenderRules.FALLBACK_TITLE, "", PushRenderRules.FALLBACK_BODY),
                direct = false,
                sound = true,
            )
        }
        val expired = account.tokenExpired(wallClock.nowMillis())
        if (expired) {
            account = refreshed(account, accountId, deadline)
                ?: return fallback(account, accountId, roomId, eventId, tokenExpired = true)
        }
        var read = api.event(account, roomId, eventId, deadline)
        if (read == PushEventRead.Unauthorized && !expired) {
            account = refreshed(account, accountId, deadline)
                ?: return fallback(account, accountId, roomId, eventId, tokenExpired = false)
            read = api.event(account, roomId, eventId, deadline)
        }
        // A state read would carry the token the homeserver just rejected.
        if (read == PushEventRead.Unauthorized) {
            return fallback(account, accountId, roomId, eventId, tokenExpired = false)
        }
        val event = (read as? PushEventRead.Event)?.json
        val storedRoom = store.room(accountId, roomId)
        val stateRoomName = if (storedRoom == null) api.roomName(account, roomId, deadline) else null
        val senderName = event
            ?.let { PushRenderRules.stringOrNull(it, "sender") }
            ?.let { api.memberDisplayName(account, roomId, it, deadline) }
        return PushOutcome.Post(
            accountId,
            roomId,
            eventId,
            PushRenderRules.render(event, storedRoom, stateRoomName, senderName),
            direct = storedRoom?.direct == true,
            sound = account.sound,
        )
    }

    /**
     * The account with a usable token; null for every other answer, which shows the fallback. Always
     * hide shows no text, so it spends no refresh token.
     */
    private fun refreshed(account: HandoffAccount, accountId: String, deadline: Deadline): HandoffAccount? {
        if (tokens == null || store.notificationText() == NotificationTextMode.ALWAYS_HIDE) return null
        return when (val answer = tokens.refreshForPush(accountId, account.accessToken, deadline)) {
            is TokenRefreshResult.Current -> account.with(answer.record)
            is TokenRefreshResult.Rotated -> account.with(answer.record)
            else -> null
        }
    }

    /** The notification from what the store holds alone, without reading anything. */
    private fun fallback(
        account: HandoffAccount,
        accountId: String,
        roomId: String,
        eventId: String,
        tokenExpired: Boolean,
    ): PushOutcome.Post {
        val storedRoom = store.room(accountId, roomId)
        return PushOutcome.Post(
            accountId,
            roomId,
            eventId,
            PushRenderRules.render(null, storedRoom, null, null, tokenExpired = tokenExpired),
            direct = storedRoom?.direct == true,
            sound = account.sound,
        )
    }
}
