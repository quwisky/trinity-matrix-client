package dev.trinityproject.trinity.push

import org.junit.Assert.assertEquals
import org.junit.Test

class DeliveredPushesTest {
    private fun push(accountId: String, tag: String, channelId: String? = MESSAGES_CHANNEL_ID) =
        DeliveredNotification(tag, notificationId(accountId), channelId)

    private val delivered = listOf(
        push("@a:hs", "!r:hs"),
        push("@a:hs", "\$roomless"),
        push("@b:hs", "!r:hs"),
        // The running app's own notification: untagged, on its own channel.
        DeliveredNotification(null, notificationId("@a:hs"), "default"),
        // A tagged notification on another channel is not a device-rendered push.
        push("@a:hs", "other", channelId = "trinity-notifications-silent"),
        // Below API 26 notifications carry no channel.
        push("@a:hs", "!old:hs", channelId = null),
    )

    @Test
    fun signingOutCancelsOnlyThatAccountsPushes() {
        assertEquals(
            listOf(
                roomNotificationKey("@a:hs", "!r:hs"),
                roomNotificationKey("@a:hs", "\$roomless"),
                roomNotificationKey("@a:hs", "!old:hs"),
            ),
            deliveredPushesToCancel(delivered, "@a:hs"),
        )
        assertEquals(listOf(roomNotificationKey("@b:hs", "!r:hs")), deliveredPushesToCancel(delivered, "@b:hs"))
    }

    @Test
    fun clearingEveryAccountCancelsEveryPushButNotTheAppsOwnNotifications() {
        assertEquals(
            listOf(
                roomNotificationKey("@a:hs", "!r:hs"),
                roomNotificationKey("@a:hs", "\$roomless"),
                roomNotificationKey("@b:hs", "!r:hs"),
                roomNotificationKey("@a:hs", "!old:hs"),
            ),
            deliveredPushesToCancel(delivered, null),
        )
    }

    @Test
    fun anAccountWithNothingDeliveredCancelsNothing() {
        assertEquals(emptyList<RoomNotificationKey>(), deliveredPushesToCancel(delivered, "@c:hs"))
    }
}
