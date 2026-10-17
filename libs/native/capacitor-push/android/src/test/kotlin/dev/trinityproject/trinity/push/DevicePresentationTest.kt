package dev.trinityproject.trinity.push

import org.junit.Assert.assertEquals
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
        assertEquals(DevicePresentation.GENERIC_ONLY, presentationFor(faulty))
    }
}
