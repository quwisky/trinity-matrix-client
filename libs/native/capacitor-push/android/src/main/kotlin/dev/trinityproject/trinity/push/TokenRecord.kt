package dev.trinityproject.trinity.push

import org.json.JSONObject

enum class TokenState { ACTIVE, REFUSED }

/**
 * One OAuth account's tokens and the endpoints they are used at. Its description never shows a
 * token or an endpoint, so a stray print or a failed assertion cannot leak one.
 */
data class TokenRecord(
    val accessToken: String,
    val refreshToken: String?,
    val expiresAtMillis: Long?,
    val tokenEndpoint: String?,
    val revocationEndpoint: String?,
    val clientId: String?,
    val deviceId: String?,
    val lineage: String,
    val state: TokenState,
) {
    fun samePair(other: TokenRecord): Boolean =
        accessToken == other.accessToken && refreshToken == other.refreshToken

    fun marked(state: TokenState): TokenRecord = copy(state = state)

    /** The record after a grant. An answer with no refresh token keeps the old one. */
    fun rotated(access: String, refresh: String?, expiresAtMillis: Long?): TokenRecord = copy(
        accessToken = access,
        refreshToken = refresh ?: refreshToken,
        expiresAtMillis = expiresAtMillis,
        state = TokenState.ACTIVE,
    )

    override fun toString(): String = "TokenRecord(lineage=$lineage, state=$state)"
}

/**
 * What `migrateTokens` was given, or null when a field a refresh needs is missing. A lineage may
 * be empty: a session saved before lineages existed has none.
 */
fun tokenRecordFromPluginCall(data: JSONObject): Pair<String, TokenRecord>? {
    fun text(key: String) = PushRenderRules.stringOrNull(data, key)?.takeIf { it.isNotEmpty() }
    val userId = text("userId") ?: return null
    val record = TokenRecord(
        accessToken = text("accessToken") ?: return null,
        refreshToken = text("refreshToken") ?: return null,
        expiresAtMillis = accessTokenExpiryFrom(data.opt("accessTokenExpiresAt")),
        tokenEndpoint = text("tokenEndpoint") ?: return null,
        revocationEndpoint = text("revocationEndpoint"),
        clientId = text("clientId") ?: return null,
        deviceId = text("deviceId") ?: return null,
        lineage = PushRenderRules.stringOrNull(data, "lineage") ?: return null,
        state = TokenState.ACTIVE,
    )
    return userId to record
}

/** Which records `removeTokens` was asked for: [account] null is every record. */
data class TokenRemoval(val account: String?)

/**
 * Null unless the call has exactly one of a non-empty user id and `all: true`. Removing every
 * record cannot be undone: it takes every account's refresh token.
 */
fun tokenRemovalFromPluginCall(data: JSONObject): TokenRemoval? = when {
    data.has("userId") == data.has("all") -> null
    data.has("all") -> if (data.opt("all") == true) TokenRemoval(null) else null
    else -> PushRenderRules.stringOrNull(data, "userId")?.takeIf { it.isNotEmpty() }?.let { TokenRemoval(it) }
}

sealed interface TokenVaultRead {
    data object Absent : TokenVaultRead

    /** The store could not answer (a Keystore fault, a value that does not decode): never [Absent]. */
    data object Unavailable : TokenVaultRead

    data class Record(val record: TokenRecord) : TokenVaultRead
}

enum class TokenVaultWrite { WRITTEN, ABSENT, FAILED }

sealed interface TokenGrantAnswer {
    /** [expiresIn] is in seconds, as the token endpoint answers it. */
    data class Tokens(val accessToken: String, val refreshToken: String?, val expiresIn: Long?) : TokenGrantAnswer {
        override fun toString(): String = "Tokens"
    }

    data object Refused : TokenGrantAnswer

    data object Failed : TokenGrantAnswer
}

/** What the plugin resolves. The wire carries the access token and its expiry only. */
sealed interface TokenRefreshResult {
    data object Busy : TokenRefreshResult

    data object Gone : TokenRefreshResult

    data object Refused : TokenRefreshResult

    data object Transient : TokenRefreshResult

    data object Unavailable : TokenRefreshResult

    data class Current(val record: TokenRecord) : TokenRefreshResult

    data class Rotated(val record: TokenRecord, val unsaved: Boolean) : TokenRefreshResult

    fun wire(): JSONObject = when (this) {
        Busy -> JSONObject().put("kind", "busy")
        Gone -> JSONObject().put("kind", "gone")
        Refused -> JSONObject().put("kind", "refused")
        Transient -> JSONObject().put("kind", "transient")
        Unavailable -> JSONObject().put("kind", "unavailable")
        is Current -> tokensWire("current", record)
        is Rotated -> if (unsaved) tokensWire("rotated", record).put("unsaved", true) else tokensWire("rotated", record)
    }
}

private fun tokensWire(kind: String, record: TokenRecord): JSONObject =
    JSONObject().put("kind", kind).put("accessToken", record.accessToken).apply {
        // A saturated or wrapped expiry is left off: JavaScript can't hold it above 2^53 - 1.
        record.expiresAtMillis?.takeIf { it in 1..9_007_199_254_740_991L }?.let { put("accessTokenExpiresAt", it) }
    }

enum class TokenRevokeResult {
    REVOKED,
    GONE,
    TRANSIENT;

    fun wire(): JSONObject = JSONObject().put("kind", name.lowercase())
}

object TokenBudgets {
    const val APP_GRANT_MILLIS = 8_000L
    const val LEASE_MARGIN_MILLIS = 5_000L
    const val LONGEST_LIFETIME_MILLIS = 30_000L
    const val REMOVAL_WAIT_MILLIS = 1_000L
    const val REVOKE_WAIT_MILLIS = 1_000L
    const val REVOKE_REQUEST_MILLIS = 2_000L
}

/** Blocking: call it on a worker thread. */
interface TokenVault {
    fun read(userId: String): TokenVaultRead

    /** Adds or updates. */
    fun write(userId: String, record: TokenRecord): Boolean

    /** Never adds: a removed record stays removed. */
    fun update(userId: String, record: TokenRecord): TokenVaultWrite

    fun remove(userId: String): Boolean

    fun removeAll(): Boolean
}
