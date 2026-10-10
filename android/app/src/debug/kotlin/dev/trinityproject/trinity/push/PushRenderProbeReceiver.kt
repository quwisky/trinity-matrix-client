package dev.trinityproject.trinity.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * E2E hook in debug builds: feeds a gateway-shaped push (string extras `trinity_user_id`,
 * `room_id`, `event_id`, `unread`) to DevicePushHandler, the path TrinityMessagingService
 * takes when the app is not in the foreground. The fetch runs off the main thread. Logs
 * nothing.
 */
class PushRenderProbeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val extras = intent.extras ?: return
        val data = KEYS.mapNotNull { key -> extras.getString(key)?.let { key to it } }.toMap()
        val pending = goAsync()
        Thread {
            try {
                DevicePushHandler(context.applicationContext).handle(data, null)
            } finally {
                pending.finish()
            }
        }.start()
    }

    private companion object {
        val KEYS = listOf("trinity_user_id", "room_id", "event_id", "unread")
    }
}
