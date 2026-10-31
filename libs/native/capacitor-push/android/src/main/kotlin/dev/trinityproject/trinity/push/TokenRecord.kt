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
