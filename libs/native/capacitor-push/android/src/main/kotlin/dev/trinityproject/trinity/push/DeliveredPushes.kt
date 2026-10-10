package dev.trinityproject.trinity.push

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationManagerCompat

/** One notification NotificationManager reports as delivered; `channelId` is null below API 26. */
data class DeliveredNotification(val tag: String?, val id: Int, val channelId: String?)

/**
 * The device-rendered pushes among [delivered] that belong to [accountId], or every one of them
 * when [accountId] is null. A device-rendered push is tagged (room or event ID) on the `messages`
 * channel; the running app's own notifications are untagged, so they are never selected.
 */
fun deliveredPushesToCancel(delivered: List<DeliveredNotification>, accountId: String?): List<RoomNotificationKey> {
    val id = accountId?.let(::notificationId)
    return delivered
        .filter { it.channelId == null || it.channelId == MESSAGES_CHANNEL_ID }
        .filter { id == null || it.id == id }
        .mapNotNull { notification -> notification.tag?.let { RoomNotificationKey(it, notification.id) } }
}

/**
 * Cancel the delivered device-rendered pushes of one account (a read badge push, or its
 * sign-out), or of every account when [accountId] is null (clear-all-data). Best effort: a
 * notification manager that cannot list or cancel leaves them, and never throws.
 */
fun cancelDeliveredPushes(context: Context, accountId: String?) {
    try {
        val active = context.getSystemService(NotificationManager::class.java)?.activeNotifications ?: return
        val delivered = active.map {
            DeliveredNotification(
                it.tag,
                it.id,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) it.notification.channelId else null,
            )
        }
        val compat = NotificationManagerCompat.from(context)
        for (key in deliveredPushesToCancel(delivered, accountId)) compat.cancel(key.tag, key.id)
    } catch (_: RuntimeException) {
        // Leaving a notification behind must not fail the sign-out that asked.
    }
}
