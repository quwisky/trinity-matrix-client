package dev.trinityproject.trinity.push

import org.json.JSONObject

/** What one notification shows. An empty subtitle shows nothing. */
data class RenderedNotification(val title: String, val subtitle: String, val body: String)

/** A room as the app stored it in the push handoff. */
data class HandoffRoom(val name: String, val direct: Boolean)

/**
 * Trinity's notification text rules, mirrored in Swift by `PushRenderRules` in the
 * TrinityPush package. Both run native/push-render/push-render-cases.json; change the
 * fixture and both implementations together.
 */
object PushRenderRules {
    const val FALLBACK_TITLE = "Trinity"
    const val FALLBACK_BODY = "New message"
    const val ENCRYPTED_BODY = "Encrypted message"
    private const val MAX_BODY_CODE_POINTS = 200
    private const val ELLIPSIS = "…"

    private val MEDIA_BODIES = mapOf(
        "m.image" to "sent an image",
        "m.video" to "sent a video",
        "m.audio" to "sent an audio message",
        "m.file" to "sent a file",
        "m.location" to "shared a location",
    )

    fun render(
        event: JSONObject?,
        storedRoom: HandoffRoom?,
        stateRoomName: String?,
        senderName: String?,
    ): RenderedNotification {
        val title = storedRoom?.name?.takeIf(::hasText)
            ?: stateRoomName?.takeIf(::hasText)
            ?: FALLBACK_TITLE
        val sender = senderName?.takeIf(::hasText)
            ?: event?.let { stringOrNull(it, "sender") }
        val subtitle = if (storedRoom?.direct == true || sender == null) "" else sender
        return RenderedNotification(title, subtitle, body(event, sender.orEmpty()))
    }

    fun stringOrNull(json: JSONObject, key: String): String? = json.opt(key) as? String

    private fun body(event: JSONObject?, sender: String): String {
        if (event == null) return FALLBACK_BODY
        if (event.optJSONObject("unsigned")?.has("redacted_because") == true) return FALLBACK_BODY
        return when (stringOrNull(event, "type")) {
            "m.room.encrypted" -> ENCRYPTED_BODY
            "m.sticker" -> "sent a sticker"
            "m.room.message" -> messageBody(event.optJSONObject("content"), sender)
            else -> FALLBACK_BODY
        }
    }

    private fun messageBody(content: JSONObject?, sender: String): String {
        val msgtype = content?.let { stringOrNull(it, "msgtype") } ?: return FALLBACK_BODY
        MEDIA_BODIES[msgtype]?.let { return it }
        val text = stringOrNull(content, "body")?.let(::trimAndCap)
        if (text.isNullOrEmpty()) return FALLBACK_BODY
        return when (msgtype) {
            "m.text", "m.notice" -> text
            "m.emote" -> "* $sender $text"
            else -> FALLBACK_BODY
        }
    }

    /** Trim Unicode whitespace; past 200 code points keep 199 and add an ellipsis. */
    private fun trimAndCap(body: String): String {
        val trimmed = body.trim(::isUnicodeWhiteSpace)
        if (trimmed.codePointCount(0, trimmed.length) <= MAX_BODY_CODE_POINTS) return trimmed
        val end = trimmed.offsetByCodePoints(0, MAX_BODY_CODE_POINTS - 1)
        return trimmed.substring(0, end) + ELLIPSIS
    }

    private fun hasText(value: String): Boolean = !value.all(::isUnicodeWhiteSpace)

    /**
     * The Unicode `White_Space` property, which Swift's `Unicode.Scalar.Properties.isWhitespace`
     * reads too. Java's `Character.isWhitespace` differs: it includes U+001C-U+001F and leaves
     * out U+0085 and the no-break spaces.
     */
    private fun isUnicodeWhiteSpace(char: Char): Boolean = when (char.code) {
        in 0x0009..0x000D, 0x0020, 0x0085, 0x00A0, 0x1680,
        in 0x2000..0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000 -> true
        else -> false
    }
}
