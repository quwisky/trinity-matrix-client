package dev.trinityproject.trinity.push

import android.content.SharedPreferences
import java.security.ProviderException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushHandoffStoreTest {
    private class MemoryPreferences : SharedPreferences {
        val values = mutableMapOf<String, String>()

        override fun getString(key: String, defValue: String?): String? = values[key] ?: defValue

        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            private val pending = mutableMapOf<String, String?>()
            private var clearing = false

            override fun putString(key: String, value: String?) = apply { pending[key] = value }

            override fun remove(key: String) = apply { pending[key] = null }

            override fun clear() = apply { clearing = true }

            override fun commit(): Boolean {
                if (clearing) values.clear()
                for ((key, value) in pending) if (value == null) values.remove(key) else values[key] = value
                return true
            }

            override fun apply() {
                commit()
            }

            override fun putStringSet(key: String, values: MutableSet<String>?) = this

            override fun putInt(key: String, value: Int) = this

            override fun putLong(key: String, value: Long) = this

            override fun putFloat(key: String, value: Float) = this

            override fun putBoolean(key: String, value: Boolean) = this
        }

        override fun getAll(): MutableMap<String, *> = values.toMutableMap()

        override fun getStringSet(key: String, defValues: MutableSet<String>?) = defValues

        override fun getInt(key: String, defValue: Int) = defValue

        override fun getLong(key: String, defValue: Long) = defValue

        override fun getFloat(key: String, defValue: Float) = defValue

        override fun getBoolean(key: String, defValue: Boolean) = defValue

        override fun contains(key: String) = key in values

        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit

        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
    }

    private class FakeCrypto(var failing: Boolean = false) : ValueCrypto {
        override fun encrypt(plain: String): String {
            if (failing) throw ProviderException("Keystore key generation failed")
            return plain.reversed()
        }

        override fun decrypt(stored: String): String {
            if (failing) throw ProviderException("Keystore operation failed")
            return stored.reversed()
        }
    }

    private val account = HandoffAccount("https://hs.example", "token", sound = false)

    @Test
    fun notificationTextIsShowUntilWrittenAndFailsClosed() {
        val preferences = MemoryPreferences()
        val crypto = FakeCrypto()
        val store = PushHandoffStore(preferences, crypto)
        assertEquals(NotificationTextMode.SHOW, store.notificationText())
        assertTrue(store.setNotificationText(NotificationTextMode.ALWAYS_HIDE))
        assertEquals(NotificationTextMode.ALWAYS_HIDE, store.notificationText())
        assertTrue(store.setNotificationText(NotificationTextMode.HIDE_ON_LOCK_SCREEN))
        assertEquals(NotificationTextMode.HIDE_ON_LOCK_SCREEN, store.notificationText())
        crypto.failing = true
        assertEquals(NotificationTextMode.ALWAYS_HIDE, store.notificationText())
        crypto.failing = false
        assertFalse(store.setNotificationText("sideways"))
        assertEquals(NotificationTextMode.HIDE_ON_LOCK_SCREEN, store.notificationText())
    }

    @Test
    fun aDamagedNotificationTextHidesEverything() {
        val preferences = MemoryPreferences()
        val crypto = FakeCrypto()
        val store = PushHandoffStore(preferences, crypto)
        preferences.values["settings:notification-text"] = crypto.encrypt("{ not json")
        assertEquals(NotificationTextMode.ALWAYS_HIDE, store.notificationText())
        preferences.values["settings:notification-text"] = crypto.encrypt("""{"notificationText":"sideways"}""")
        assertEquals(NotificationTextMode.ALWAYS_HIDE, store.notificationText())
        preferences.values["settings:notification-text"] = crypto.encrypt("{}")
        assertEquals(NotificationTextMode.ALWAYS_HIDE, store.notificationText())
    }

    @Test
    fun clearRemovesTheNotificationText() {
        val store = PushHandoffStore(MemoryPreferences(), FakeCrypto())
        assertTrue(store.setNotificationText(NotificationTextMode.ALWAYS_HIDE))
        assertTrue(store.clear())
        assertEquals(NotificationTextMode.SHOW, store.notificationText())
    }

    @Test
    fun aMissingMirrorShowsTextAndADamagedOrUnknownOneHidesEverything() {
        val preferences = MemoryPreferences()
        val crypto = FakeCrypto()
        val store = PushHandoffStore(preferences, crypto)
        assertEquals(NotificationTextMode.SHOW, store.notificationText())
        for (damaged in listOf("", "null", "[]", """{"notificationText":null}""", """{"notificationText":"Show"}""")) {
            preferences.values["settings:notification-text"] = crypto.encrypt(damaged)
            assertEquals(damaged, NotificationTextMode.ALWAYS_HIDE, store.notificationText())
        }
        preferences.values["settings:notification-text"] = "not sealed"
        crypto.failing = true
        assertEquals(NotificationTextMode.ALWAYS_HIDE, store.notificationText())
        crypto.failing = false
        preferences.values.remove("settings:notification-text")
        assertEquals(NotificationTextMode.SHOW, store.notificationText())
    }

    @Test
    fun storedValuesRoundTrip() {
        val store = PushHandoffStore(MemoryPreferences(), FakeCrypto())

        assertTrue(store.setAccount("@a:hs", account))
        assertTrue(store.mergeRooms("@a:hs", mapOf("!r:hs" to HandoffRoom("Team", true))))

        assertEquals(account, store.account("@a:hs"))
        assertEquals(HandoffRoom("Team", true), store.room("@a:hs", "!r:hs"))
    }

    @Test
    fun theEncryptedFlagIsStoredAndAnEntryWithoutItCountsAsEncrypted() {
        val preferences = MemoryPreferences()
        val crypto = FakeCrypto()
        val store = PushHandoffStore(preferences, crypto)

        assertTrue(store.mergeRooms("@a:hs", mapOf("!r:hs" to HandoffRoom("Team", false, encrypted = false))))
        assertEquals(false, store.room("@a:hs", "!r:hs")?.encrypted)

        preferences.values["rooms:@a:hs"] = crypto.encrypt("""{"!b:hs":{"name":"B","direct":true}}""")
        assertEquals(HandoffRoom("B", true, encrypted = true), store.room("@a:hs", "!b:hs"))
    }

    @Test
    fun theTokenExpiryRoundTrips() {
        val store = PushHandoffStore(MemoryPreferences(), FakeCrypto())
        val expiring = HandoffAccount("https://hs.example", "token", sound = true, accessTokenExpiresAt = 1_760_000_000_000L)

        assertTrue(store.setAccount("@a:hs", expiring))

        assertEquals(expiring, store.account("@a:hs"))
    }

    @Test
    fun anAccountStoredBeforeExpiriesExistedReadsWithoutOne() {
        val preferences = MemoryPreferences()
        val crypto = FakeCrypto()
        preferences.values["account:@a:hs"] =
            crypto.encrypt("""{"homeserverUrl":"https://hs.example","accessToken":"token","sound":false}""")

        val stored = PushHandoffStore(preferences, crypto).account("@a:hs")

        assertEquals(account, stored)
        assertNull(stored?.accessTokenExpiresAt)
    }

    @Test
    fun anExpiryOfAnyJsonNumberShapeIsKept() {
        assertEquals(1_760_000_000_000L, accessTokenExpiryFrom(1_760_000_000_000L))
        assertEquals(1_000L, accessTokenExpiryFrom(1_000))
        assertEquals(1_760_000_000_000L, accessTokenExpiryFrom(1_760_000_000_000.7))
        assertEquals(1L, accessTokenExpiryFrom(1.9))
        assertNull(accessTokenExpiryFrom(null))
        assertNull(accessTokenExpiryFrom(JSONObject.NULL))
        assertNull(accessTokenExpiryFrom("1760000000000"))
    }

    @Test
    fun anExpiryThatIsNotAFinitePositiveNumberIsAbsent() {
        assertNull(accessTokenExpiryFrom(true))
        assertNull(accessTokenExpiryFrom(false))
        assertNull(accessTokenExpiryFrom(0))
        assertNull(accessTokenExpiryFrom(-1))
        assertNull(accessTokenExpiryFrom(-5L))
        assertNull(accessTokenExpiryFrom(0.4))
        assertNull(accessTokenExpiryFrom(Double.NaN))
        assertNull(accessTokenExpiryFrom(Double.POSITIVE_INFINITY))
        assertNull(accessTokenExpiryFrom(Double.NEGATIVE_INFINITY))
        assertNull(accessTokenExpiryFrom(JSONObject()))
    }

    @Test
    fun anAbsurdlyLargeExpirySaturatesAndIsNeverExpired() {
        assertEquals(Long.MAX_VALUE, accessTokenExpiryFrom(1e30))
    }

    @Test
    fun aKeystoreProviderFaultFailsWritesInsteadOfThrowing() {
        val store = PushHandoffStore(MemoryPreferences(), FakeCrypto(failing = true))

        assertFalse(store.setAccount("@a:hs", account))
        assertFalse(store.mergeRooms("@a:hs", mapOf("!r:hs" to HandoffRoom("Team", false))))
    }

    @Test
    fun aKeystoreProviderFaultReadsAsNothingStored() {
        val crypto = FakeCrypto()
        val store = PushHandoffStore(MemoryPreferences(), crypto)
        store.setAccount("@a:hs", account)
        store.mergeRooms("@a:hs", mapOf("!r:hs" to HandoffRoom("Team", false)))

        crypto.failing = true

        assertNull(store.account("@a:hs"))
        assertNull(store.room("@a:hs", "!r:hs"))
    }
}
