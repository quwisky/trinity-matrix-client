package dev.trinityproject.trinity.push

import android.content.SharedPreferences
import java.security.ProviderException

internal class MemoryPreferences : SharedPreferences {
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

internal class FakeCrypto(var failing: Boolean = false) : ValueCrypto {
    override fun encrypt(plain: String): String {
        if (failing) throw ProviderException("Keystore key generation failed")
        return plain.reversed()
    }

    override fun decrypt(stored: String): String {
        if (failing) throw ProviderException("Keystore operation failed")
        return stored.reversed()
    }
}

internal val R0 = TokenRecord(
    accessToken = "a0",
    refreshToken = "r0",
    expiresAtMillis = 1_760_000_300_000L,
    tokenEndpoint = "https://op.example/token",
    revocationEndpoint = "https://op.example/revoke",
    clientId = "c",
    deviceId = "D",
    lineage = "L",
    state = TokenState.ACTIVE,
)
