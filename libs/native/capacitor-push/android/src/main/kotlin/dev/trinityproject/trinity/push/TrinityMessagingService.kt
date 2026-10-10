package dev.trinityproject.trinity.push

import android.app.ActivityManager
import com.capacitorjs.plugins.pushnotifications.MessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Replaces the push plugin's MessagingService: this module's manifest declares it and the
 * host app's manifest removes the plugin's. With the app in
 * the foreground the plugin handles the message exactly as before, and the running app's
 * notification policy decides what shows. Otherwise Trinity renders the gateway's data-only
 * device-render push itself. Token callbacks stay the plugin's.
 */
class TrinityMessagingService : MessagingService() {
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        if (appInForeground()) {
            super.onMessageReceived(remoteMessage)
            return
        }
        DevicePushHandler(applicationContext).handle(remoteMessage.data, remoteMessage.messageId)
    }
}

/**
 * Whether an activity is visible. The web layer presents notifications itself while its
 * document is visible, which a paused but visible activity (shade down, split screen)
 * still is, so the native side must not also post then.
 */
internal fun appInForeground(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
}
