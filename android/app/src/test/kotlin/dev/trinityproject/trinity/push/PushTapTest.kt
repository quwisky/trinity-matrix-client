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

    @Test
    fun everyDeliveredNotificationKeepsItsOwnTapRequestCode() {
        val keys = listOf(
            roomNotificationKey("@a:hs", "!r:hs"),
            roomNotificationKey("@b:hs", "!r:hs"),
            roomNotificationKey("@a:hs", "!other:hs"),
            // Room-less pushes are tagged with their event ID.
            roomNotificationKey("@a:hs", "\$e1"),
            roomNotificationKey("@a:hs", "\$e2"),
        )

        assertEquals(keys.size, keys.map(::tapRequestCode).toSet().size)
        assertEquals(tapRequestCode(keys[0]), tapRequestCode(roomNotificationKey("@a:hs", "!r:hs")))
    }
}
