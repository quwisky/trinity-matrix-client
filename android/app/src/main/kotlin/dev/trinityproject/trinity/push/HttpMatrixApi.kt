package dev.trinityproject.trinity.push

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import org.json.JSONException
import org.json.JSONObject

/** One percent-encoded path segment: `/`, `+`, `$`, `!`, `:` and `@` never reach a path raw. */
fun encodePathSegment(value: String): String =
    URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

/**
 * [MatrixApi] over HttpURLConnection. Each read gets what is left of the push's [Deadline]
 * as its connect and read timeout and is never retried. Logs nothing: URLs carry room and
 * event IDs and headers carry the token.
 */
class HttpMatrixApi : MatrixApi {
    override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): JSONObject? =
        get(account, "${room(roomId)}/event/${encodePathSegment(eventId)}", deadline)

    override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String? =
        get(account, "${room(roomId)}/state/m.room.member/${encodePathSegment(userId)}", deadline)
            ?.let { PushRenderRules.stringOrNull(it, "displayname") }
            ?.takeIf(PushRenderRules::hasText)

    override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? =
        get(account, "${room(roomId)}/state/m.room.name", deadline)
            ?.let { PushRenderRules.stringOrNull(it, "name") }
            ?.takeIf(PushRenderRules::hasText)

    private fun room(roomId: String) = "/_matrix/client/v3/rooms/${encodePathSegment(roomId)}"

    private fun get(account: HandoffAccount, path: String, deadline: Deadline): JSONObject? {
        val remaining = deadline.remainingMillis()
        if (remaining <= 0) return null
        val connection = try {
            URI.create(account.homeserverUrl.trimEnd('/') + path).toURL().openConnection() as HttpURLConnection
        } catch (error: IllegalArgumentException) {
            return null
        } catch (error: IOException) {
            return null
        }
        return try {
            // The token is a header: never let a redirect carry it to another host.
            connection.instanceFollowRedirects = false
            connection.connectTimeout = remaining.toInt()
            connection.readTimeout = remaining.toInt()
            connection.setRequestProperty("Authorization", "Bearer ${account.accessToken}")
            connection.setRequestProperty("Accept", "application/json")
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                null
            } else {
                JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            }
        } catch (error: IOException) {
            null
        } catch (error: JSONException) {
            null
        } finally {
            connection.disconnect()
        }
    }
}
