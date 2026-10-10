package dev.trinityproject.trinity.push

/** The channel PushService creates at registration (see NativePushRegistrationService). */
const val MESSAGES_CHANNEL_ID = "messages"

/** One notification per account and room: the room ID is the tag, this the id. */
fun notificationId(accountId: String?): Int = accountId.orEmpty().hashCode()

/** Where one account's notification for a room lives in NotificationManager. */
data class RoomNotificationKey(val tag: String, val id: Int)

/**
 * The single addressing rule for a room's notification, shared by posting, cancelling on a
 * read push and PushHandoff.clearRoom, so opening a room clears exactly what was posted for
 * that account.
 */
fun roomNotificationKey(accountId: String?, roomId: String): RoomNotificationKey =
    RoomNotificationKey(roomId, notificationId(accountId))

/**
 * Extras for the tap intent. `google.message_id` is what
 * PushNotificationsPlugin.handleOnNewIntent requires; it hands every other extra to
 * JavaScript as the notification's data, where PushService reads the account, room and event
 * (the same path a Firebase-displayed notification takes).
 */
fun pushTapExtras(outcome: PushOutcome.Post, messageId: String?): Map<String, String> = buildMap {
    put("google.message_id", messageId ?: outcome.eventId)
    outcome.accountId?.let { put("trinity_user_id", it) }
    outcome.roomId?.let { put("room_id", it) }
    put("event_id", outcome.eventId)
}

/**
 * The PendingIntent request code of a notification's tap. Derived from the notification's own
 * identity, so every delivered notification (a room's, or a room-less push's per event) keeps
 * its own extras instead of FLAG_UPDATE_CURRENT overwriting another's.
 */
fun tapRequestCode(key: RoomNotificationKey): Int = 31 * key.tag.hashCode() + key.id
