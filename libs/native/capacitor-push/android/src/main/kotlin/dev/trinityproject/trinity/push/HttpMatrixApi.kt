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
    override fun event(account: HandoffAccount, roomId: String, eventId: String, deadline: Deadline): PushEventRead =
        get(account, "${room(roomId)}/event/${encodePathSegment(eventId)}", deadline)

    override fun memberDisplayName(account: HandoffAccount, roomId: String, userId: String, deadline: Deadline): String? =
        name(get(account, "${room(roomId)}/state/m.room.member/${encodePathSegment(userId)}", deadline), "displayname")

    override fun roomName(account: HandoffAccount, roomId: String, deadline: Deadline): String? =
        name(get(account, "${room(roomId)}/state/m.room.name", deadline), "name")

    private fun name(read: PushEventRead, key: String): String? =
        (read as? PushEventRead.Event)?.json
            ?.let { PushRenderRules.stringOrNull(it, key) }
            ?.takeIf(PushRenderRules::hasText)

    private fun room(roomId: String) = "/_matrix/client/v3/rooms/${encodePathSegment(roomId)}"

    private fun get(account: HandoffAccount, path: String, deadline: Deadline): PushEventRead {
        val remaining = deadline.remainingMillis()
        if (remaining <= 0) return PushEventRead.Failed
        val connection = try {
            URI.create(account.homeserverUrl.trimEnd('/') + path).toURL().openConnection() as HttpURLConnection
        } catch (error: IllegalArgumentException) {
            return PushEventRead.Failed
        } catch (error: IOException) {
            return PushEventRead.Failed
        }
        return try {
            // The token is a header: never let a redirect carry it to another host.
            connection.instanceFollowRedirects = false
            connection.connectTimeout = remaining.toInt()
            connection.readTimeout = remaining.toInt()
            connection.setRequestProperty("Authorization", "Bearer ${account.accessToken}")
            connection.setRequestProperty("Accept", "application/json")
            when (connection.responseCode) {
                HttpURLConnection.HTTP_UNAUTHORIZED -> PushEventRead.Unauthorized
                HttpURLConnection.HTTP_OK ->
                    PushEventRead.Event(JSONObject(connection.inputStream.bufferedReader().use { it.readText() }))
                else -> PushEventRead.Failed
            }
        } catch (error: IOException) {
            PushEventRead.Failed
        } catch (error: JSONException) {
            PushEventRead.Failed
        } finally {
            connection.disconnect()
        }
    }
}
