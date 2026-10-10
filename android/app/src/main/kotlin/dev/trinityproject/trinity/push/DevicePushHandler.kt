package dev.trinityproject.trinity.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import dev.trinityproject.trinity.MainActivity
import dev.trinityproject.trinity.R

/**
 * Posts, updates or cancels the notification for one device-rendered push: one
 * MessagingStyle notification per account and room on the `messages` channel, newer
 * messages appended to it. Resolution is bounded by one total 5 s budget (see
 * [BoundedPushResolver]). Logs nothing about the push.
 */
class DevicePushHandler(
    private val context: Context,
    private val resolver: BoundedPushResolver = BoundedPushResolver(PushHandoffStore(context), HttpMatrixApi()),
) {
    fun handle(data: Map<String, String>, messageId: String?) {
        val compat = NotificationManagerCompat.from(context)
        when (val outcome = resolver.resolve(data)) {
            is PushOutcome.Post -> post(compat, outcome, messageId)
            is PushOutcome.CancelRoom -> {
                val key = roomNotificationKey(outcome.accountId, outcome.roomId)
                compat.cancel(key.tag, key.id)
            }
            is PushOutcome.CancelAccount -> {
                val id = notificationId(outcome.accountId)
                for (active in platformManager()?.activeNotifications.orEmpty()) {
                    if (active.id == id && active.tag != null) compat.cancel(active.tag, id)
                }
            }
            PushOutcome.Ignore -> Unit
        }
    }

    private fun post(compat: NotificationManagerCompat, outcome: PushOutcome.Post, messageId: String?) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        ensureChannel()
        val key = roomNotificationKey(outcome.accountId, outcome.roomId ?: outcome.eventId)
        val rendered = outcome.notification
        val previous = platformManager()?.activeNotifications
            ?.firstOrNull { it.tag == key.tag && it.id == key.id }
            ?.notification
        val style = previous?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }
            ?: NotificationCompat.MessagingStyle(
                Person.Builder().setName(context.getString(R.string.app_name)).build(),
            )
        style.setConversationTitle(if (outcome.direct) null else rendered.title)
        style.setGroupConversation(!outcome.direct)
        style.addMessage(
            rendered.body,
            System.currentTimeMillis(),
            Person.Builder().setName(rendered.subtitle.ifEmpty { rendered.title }).build(),
        )
        val notification = NotificationCompat.Builder(context, MESSAGES_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_trinity)
            .setColor(ContextCompat.getColor(context, R.color.ic_launcher_background))
            .setContentTitle(rendered.title)
            .setContentText(rendered.body)
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setSilent(!outcome.sound)
            .setContentIntent(tapIntent(outcome, messageId))
            .build()
        compat.notify(key.tag, key.id, notification)
    }

    private fun tapIntent(outcome: PushOutcome.Post, messageId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        for ((key, value) in pushTapExtras(outcome, messageId)) intent.putExtra(key, value)
        return PendingIntent.getActivity(
            context,
            "${outcome.accountId}\u0000${outcome.roomId}".hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** PushService creates `messages` at registration; recreate it if it is missing. */
    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = platformManager() ?: return
        if (manager.getNotificationChannel(MESSAGES_CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(MESSAGES_CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH),
        )
    }

    private fun platformManager(): NotificationManager? =
        context.getSystemService(NotificationManager::class.java)
}
