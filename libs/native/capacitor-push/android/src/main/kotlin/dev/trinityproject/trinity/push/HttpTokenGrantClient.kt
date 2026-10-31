package dev.trinityproject.trinity.push

import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import org.json.JSONException
import org.json.JSONObject

/** Blocking: call it on a worker thread. A failure is an answer, never an exception. */
interface TokenGrantClient {
    fun grant(record: TokenRecord, deadline: Deadline): TokenGrantAnswer

    /** True only when every token held was revoked. */
    fun revoke(record: TokenRecord, deadline: Deadline): Boolean
}

/**
 * Grants and revocations over HttpURLConnection, to the record's pinned endpoints only, with no
 * retry, no discovery and no redirect. Logs nothing: bodies and URLs carry tokens and endpoints.
 */
class HttpTokenGrantClient : TokenGrantClient {
    private class Answer(val status: Int, val body: String)

    override fun grant(record: TokenRecord, deadline: Deadline): TokenGrantAnswer {
        val endpoint = record.tokenEndpoint ?: return TokenGrantAnswer.Failed
        val refreshToken = record.refreshToken ?: return TokenGrantAnswer.Failed
        val clientId = record.clientId ?: return TokenGrantAnswer.Failed
        val form = listOf("grant_type" to "refresh_token", "client_id" to clientId, "refresh_token" to refreshToken)
        val answer = post(endpoint, form, deadline) ?: return TokenGrantAnswer.Failed
        return when (answer.status) {
            HttpURLConnection.HTTP_OK -> tokens(answer.body)
            HttpURLConnection.HTTP_BAD_REQUEST, HttpURLConnection.HTTP_UNAUTHORIZED ->
                if (isOAuthError(answer.body)) TokenGrantAnswer.Refused else TokenGrantAnswer.Failed
            else -> TokenGrantAnswer.Failed
        }
    }

    override fun revoke(record: TokenRecord, deadline: Deadline): Boolean {
        val endpoint = record.revocationEndpoint ?: return false
        val clientId = record.clientId ?: return false
        val tokens = listOfNotNull(
            "access_token" to record.accessToken,
            record.refreshToken?.let { "refresh_token" to it },
        )
        // map, not all: one token failing must not leave the other unrevoked.
        return tokens.map { (hint, token) ->
            val form = listOf("token" to token, "token_type_hint" to hint, "client_id" to clientId)
            post(endpoint, form, deadline)?.let { it.status in 200..299 } == true
        }.all { it }
    }

    private fun tokens(body: String): TokenGrantAnswer {
        val json = parse(body) ?: return TokenGrantAnswer.Failed
        val accessToken = PushRenderRules.stringOrNull(json, "access_token")?.takeIf { it.isNotEmpty() }
            ?: return TokenGrantAnswer.Failed
        return TokenGrantAnswer.Tokens(
            accessToken,
            PushRenderRules.stringOrNull(json, "refresh_token")?.takeIf { it.isNotEmpty() },
            // Past Int range it is no real lifetime, and turning it into an expiry would wrap.
            accessTokenExpiryFrom(json.opt("expires_in"))?.takeIf { it <= Int.MAX_VALUE },
        )
    }

    // A proxy or captive portal answers 400 and 401 too, and a Matrix error is not a refusal.
    private fun isOAuthError(body: String): Boolean {
        val json = parse(body) ?: return false
        return PushRenderRules.stringOrNull(json, "error") != null && !json.has("errcode")
    }

    private fun parse(body: String): JSONObject? = try {
        JSONObject(body)
    } catch (error: JSONException) {
        null
    }

    private fun post(endpoint: String, form: List<Pair<String, String>>, deadline: Deadline): Answer? {
        val remaining = deadline.remainingMillis()
        // HttpURLConnection reads a 0 timeout as none.
        if (remaining <= 0) return null
        val connection = try {
            URI.create(endpoint).toURL().openConnection() as HttpURLConnection
        } catch (error: Exception) {
            return null
        }
        return try {
            // The body is the refresh token: never let a redirect carry it to another host.
            connection.instanceFollowRedirects = false
            connection.connectTimeout = remaining.toInt()
            connection.readTimeout = remaining.toInt()
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            connection.setRequestProperty("Accept", "application/json")
            connection.outputStream.use { it.write(encode(form).toByteArray()) }
            val status = connection.responseCode
            val stream = if (status < HttpURLConnection.HTTP_BAD_REQUEST) connection.inputStream else connection.errorStream
            Answer(status, stream?.bufferedReader()?.use { it.readText() }.orEmpty())
        } catch (error: Exception) {
            // Not only IOException: a failure must stay a value, and on a revocation's daemon
            // thread an escaped one would take the process down.
            null
        } finally {
            connection.disconnect()
        }
    }

    private fun encode(form: List<Pair<String, String>>): String = form.joinToString("&") { (name, value) ->
        "$name=${URLEncoder.encode(value, Charsets.UTF_8.name())}"
    }
}
