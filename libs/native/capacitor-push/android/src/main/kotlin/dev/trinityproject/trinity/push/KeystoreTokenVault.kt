package dev.trinityproject.trinity.push

import android.content.Context
import android.content.SharedPreferences
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
        return try {
            val stored = preferences.getString(key(userId), null) ?: return TokenVaultRead.Absent
            decode(JSONObject(crypto.decrypt(stored)))?.let { TokenVaultRead.Record(it) } ?: TokenVaultRead.Unavailable
        } catch (error: Exception) {
            // Keystore faults are security and provider exceptions; Android's JSONException is checked.
            TokenVaultRead.Unavailable
        }
    }

    override fun write(userId: String, record: TokenRecord): Boolean = try {
        preferences.edit().putString(key(userId), crypto.encrypt(encode(record).toString())).commit()
    } catch (error: Exception) {
        false
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

    private fun key(userId: String) = "tokens:$userId"

    internal companion object {
        const val FILE = "trinity_push_tokens"
        const val KEY_ALIAS = "trinity_push_tokens"

        // Process-wide, not per instance: the plugin and the service each build their own vault.
        // A removal that gave up waiting for the lease must not be overwritten by an update.
        private val LOCK = Any()
    }
}
