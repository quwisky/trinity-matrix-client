package dev.trinityproject.trinity.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class PushTapTest {
    private val outcome = PushOutcome.Post(
        accountId = "@a:hs",
        roomId = "!r:hs",
        eventId = "\$e",
        notification = RenderedNotification("Team", "Alice", "hi"),
        direct = false,
        sound = true,
    )

    @Test
    fun tapCarriesWhatThePushPluginForwardsToJavaScript() {
        assertEquals(
            mapOf(
                "google.message_id" to "fcm-1",
                "trinity_user_id" to "@a:hs",
                "room_id" to "!r:hs",
                "event_id" to "\$e",
            ),
            pushTapExtras(outcome, "fcm-1"),
        )
    }

    @Test
    fun tapStillCarriesAMessageIdWithoutOneFromFirebase() {
        // PushNotificationsPlugin.handleOnNewIntent ignores an intent without it.
        assertEquals("\$e", pushTapExtras(outcome, null)["google.message_id"])
    }

    @Test
    fun notificationIdsAreStablePerAccount() {
        assertEquals(notificationId("@a:hs"), notificationId("@a:hs"))
        assertNotEquals(notificationId("@a:hs"), notificationId("@b:hs"))
    }

    @Test
    fun openingARoomClearsOnlyThatAccountsNotificationForIt() {
        // Posting, a read push and PushHandoff.clearRoom all address the notification this way.
        val key = roomNotificationKey("@a:hs", "!r:hs")

        assertEquals(RoomNotificationKey("!r:hs", notificationId("@a:hs")), key)
        assertNotEquals(key, roomNotificationKey("@b:hs", "!r:hs"))
        assertNotEquals(key, roomNotificationKey("@a:hs", "!other:hs"))
    }
}
