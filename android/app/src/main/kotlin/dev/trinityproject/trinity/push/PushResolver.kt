package dev.trinityproject.trinity.push

import org.json.JSONObject

/** One account's credentials as the app stored them; never a refresh token. */
data class HandoffAccount(val homeserverUrl: String, val accessToken: String, val sound: Boolean)

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
 * post. Never refreshes a token: an expired one reads as a failed fetch and the room-name
 * fallback.
 */
class PushResolver(
    private val store: HandoffReader,
    private val api: MatrixApi,
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
