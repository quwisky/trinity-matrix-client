package dev.trinityproject.trinity.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DevicePresentationTest {
    @Test
    fun eachModeHasOnePresentation() {
        assertEquals(DevicePresentation.FULL, devicePresentation(NotificationTextMode.SHOW))
        assertEquals(DevicePresentation.FULL_WITH_GENERIC_PUBLIC, devicePresentation(NotificationTextMode.HIDE_ON_LOCK_SCREEN))
        assertEquals(DevicePresentation.GENERIC_ONLY, devicePresentation(NotificationTextMode.ALWAYS_HIDE))
    }

    @Test
    fun anUnknownModeHidesEverything() {
        assertEquals(DevicePresentation.GENERIC_ONLY, devicePresentation("sideways"))
        assertEquals(DevicePresentation.GENERIC_ONLY, devicePresentation(""))
    }

    @Test
    fun aStoreThatFailsReadsAsGenericOnly() {
        val faulty = object : HandoffReader {
            override fun account(userId: String): HandoffAccount? = null

            override fun room(userId: String, roomId: String): HandoffRoom? = null

            override fun notificationText(): String = throw java.security.ProviderException("keystore")
        }
        assertEquals(DevicePresentation.GENERIC_ONLY, presentationFor(faulty, null))
    }

    @Test
    fun anAccountSignedOutBeforePostingIsGenericOnly() {
        val store = PushHandoffStore(MemoryPreferences(), FakeCrypto(), KeystoreTokenVault(MemoryPreferences(), FakeCrypto()))
        assertTrue(store.setNotificationText(NotificationTextMode.SHOW))
        assertTrue(store.setAccount("@a:hs", HandoffAccount("https://hs.example", "token", sound = true)))
        assertEquals(DevicePresentation.FULL, presentationFor(store, "@a:hs"))

        assertTrue(store.removeAccount("@a:hs"))

        assertEquals(DevicePresentation.GENERIC_ONLY, presentationFor(store, "@a:hs"))
    }
}
