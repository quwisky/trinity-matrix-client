package dev.trinityproject.trinity.push

import android.content.Context
import android.content.SharedPreferences
import javax.crypto.AEADBadTagException
import org.json.JSONObject

/**
 * Token records in their own private preferences file, so clearing the handoff store never
 * touches them, sealed under their own Keystore key: a lookup fault while sealing replaces that
 * alias's key, and handoff values heal at the next start where these do not. Nothing here logs
 * what it stores.
 */
class KeystoreTokenVault internal constructor(
    private val preferences: SharedPreferences,
    private val crypto: ValueCrypto,
) : TokenVault {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE),
        KeystoreCrypto(KEY_ALIAS),
    )

    override fun read(userId: String): TokenVaultRead {
        var stored: String? = null
        return try {
            stored = preferences.getString(key(userId), null) ?: return TokenVaultRead.Absent
            open(stored)
        } catch (error: AEADBadTagException) {
            // Sealed under a key the alias no longer holds: it can never be opened, so the account
            // reads as signed out instead of failing on every refresh.
            discard(userId, stored)
        } catch (error: Exception) {
            // Keystore faults are security and provider exceptions; Android's JSONException is checked.
            TokenVaultRead.Unavailable
        }
    }

    private fun open(stored: String): TokenVaultRead =
        decode(JSONObject(crypto.decrypt(stored)))?.let { TokenVaultRead.Record(it) } ?: TokenVaultRead.Unavailable

    /**
     * Removes [stale] and reads as Absent. A record written meanwhile stays and is what the read
     * answers; one that cannot be opened either is Unavailable, never Absent.
     */
    private fun discard(userId: String, stale: String?): TokenVaultRead = synchronized(LOCK) {
        try {
            val current = preferences.getString(key(userId), null) ?: return TokenVaultRead.Absent
            if (current != stale) return open(current)
            // A failed removal leaves it to read as Absent again next time.
            preferences.edit().remove(key(userId)).commit()
            TokenVaultRead.Absent
        } catch (error: Exception) {
            TokenVaultRead.Unavailable
        }
    }

    // Under LOCK so a read discarding an unopenable record cannot remove one written meanwhile.
    override fun write(userId: String, record: TokenRecord): Boolean = synchronized(LOCK) {
        try {
            preferences.edit().putString(key(userId), crypto.encrypt(encode(record).toString())).commit()
        } catch (error: Exception) {
            false
        }
    }

    override fun update(userId: String, record: TokenRecord): TokenVaultWrite = synchronized(LOCK) {
        try {
            when {
                !preferences.contains(key(userId)) -> TokenVaultWrite.ABSENT
                write(userId, record) -> TokenVaultWrite.WRITTEN
                else -> TokenVaultWrite.FAILED
            }
        } catch (error: Exception) {
            TokenVaultWrite.FAILED
        }
    }

    override fun remove(userId: String): Boolean = synchronized(LOCK) {
        try {
            preferences.edit().remove(key(userId)).commit()
        } catch (error: Exception) {
            false
        }
    }

    override fun removeAll(): Boolean = synchronized(LOCK) {
        try {
            preferences.edit().clear().commit()
        } catch (error: Exception) {
            false
        }
    }

    override fun accounts(): List<String>? = try {
        preferences.all.keys.filter { it.startsWith(KEY_PREFIX) }.map { it.removePrefix(KEY_PREFIX) }
    } catch (error: Exception) {
        null
    }

    private fun encode(record: TokenRecord): JSONObject = JSONObject()
        .put("accessToken", record.accessToken)
        .put("lineage", record.lineage)
        .put("state", record.state.name.lowercase())
        .apply {
            record.refreshToken?.let { put("refreshToken", it) }
            record.expiresAtMillis?.let { put("expiresAtMillis", it) }
            record.tokenEndpoint?.let { put("tokenEndpoint", it) }
            record.revocationEndpoint?.let { put("revocationEndpoint", it) }
            record.clientId?.let { put("clientId", it) }
            record.deviceId?.let { put("deviceId", it) }
        }

    private fun decode(json: JSONObject): TokenRecord? {
        val accessToken = PushRenderRules.stringOrNull(json, "accessToken") ?: return null
        val lineage = PushRenderRules.stringOrNull(json, "lineage") ?: return null
        val state = when (PushRenderRules.stringOrNull(json, "state")) {
            "active" -> TokenState.ACTIVE
            "refused" -> TokenState.REFUSED
            else -> return null
        }
        return TokenRecord(
            accessToken,
            PushRenderRules.stringOrNull(json, "refreshToken"),
            accessTokenExpiryFrom(json.opt("expiresAtMillis")),
            PushRenderRules.stringOrNull(json, "tokenEndpoint"),
            PushRenderRules.stringOrNull(json, "revocationEndpoint"),
            PushRenderRules.stringOrNull(json, "clientId"),
            PushRenderRules.stringOrNull(json, "deviceId"),
            lineage,
            state,
        )
    }

    private fun key(userId: String) = "$KEY_PREFIX$userId"

    internal companion object {
        const val FILE = "trinity_push_tokens"
        const val KEY_ALIAS = "trinity_push_tokens"
        private const val KEY_PREFIX = "tokens:"

        // Process-wide, not per instance: the plugin and the service each build their own vault.
        // A removal that gave up waiting for the lease must not be overwritten by an update.
        private val LOCK = Any()
    }
}
