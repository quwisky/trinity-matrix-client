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
}

/** Read side of the push handoff store. */
interface HandoffReader {
    fun account(userId: String): HandoffAccount?
    fun room(userId: String, roomId: String): HandoffRoom?
}

/** The client-server reads the renderer makes; every failure reads as null. */
interface MatrixApi {
    fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): JSONObject?
    fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String?
    fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String?
}

fun monotonicMillis(): Long = System.nanoTime() / 1_000_000

/** One budget shared by every read for a push. */
class Deadline(private val endsAtMillis: Long, private val clock: () -> Long) {
    fun remainingMillis(): Long = endsAtMillis - clock()

    companion object {
        const val BUDGET_MILLIS = 5_000L

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
 * post. Never refreshes a token. A token the store marks expired is not sent at all, because
 * only the app can renew it: the push shows the room name with the expired-token text. Any
 * other failed read shows the room-name fallback.
 */
class PushResolver(
    private val store: HandoffReader,
    private val api: MatrixApi,
    /** Wall-clock epoch milliseconds, compared with the stored token expiry. */
    private val wallClock: () -> Long = System::currentTimeMillis,
    /** Monotonic milliseconds for the read budget. Last, so a trailing lambda still sets it. */
    private val clock: () -> Long = ::monotonicMillis,
) {
    fun resolve(data: Map<String, String>): PushOutcome {
        val accountId = data["trinity_user_id"]
        val roomId = data["room_id"]
        val eventId = data["event_id"]
            ?: return when {
                roomId != null -> PushOutcome.CancelRoom(accountId, roomId)
                // Synapse's badge-only push carries neither event nor room.
                accountId != null && data["unread"] == "0" -> PushOutcome.CancelAccount(accountId)
                else -> PushOutcome.Ignore
            }
        val account = accountId?.let(store::account)
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
        if (account.tokenExpired(wallClock())) {
            val storedRoom = store.room(accountId, roomId)
            return PushOutcome.Post(
                accountId,
                roomId,
                eventId,
                PushRenderRules.render(null, storedRoom, null, null, tokenExpired = true),
                direct = storedRoom?.direct == true,
                sound = account.sound,
            )
        }
        val deadline = Deadline.start(clock)
        val event = api.event(account, roomId, eventId, deadline)
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
}
