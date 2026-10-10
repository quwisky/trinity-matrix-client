import Foundation

/// What one notification shows. An empty subtitle shows nothing.
public struct RenderedNotification: Equatable {
    public let title: String
    public let subtitle: String
    public let body: String

    public init(title: String, subtitle: String, body: String) {
        self.title = title
        self.subtitle = subtitle
        self.body = body
    }
}

/// A room as the app stored it in the push handoff.
public struct HandoffRoom: Codable, Equatable {
    public let name: String
    public let direct: Bool

    public init(name: String, direct: Bool) {
        self.name = name
        self.direct = direct
    }
}

/// Trinity's notification text rules, mirrored in Kotlin by `PushRenderRules` (Android).
/// Both run native/push-render/push-render-cases.json; change the fixture and both together.
public enum PushRenderRules {
    public static let fallbackTitle = "Trinity"
    public static let fallbackBody = "New message"
    public static let encryptedBody = "Encrypted message"
    static let maxBodyCodePoints = 200

    private static let mediaBodies: [String: String] = [
        "m.image": "sent an image",
        "m.video": "sent a video",
        "m.audio": "sent an audio message",
        "m.file": "sent a file",
        "m.location": "shared a location",
    ]

    public static func render(
        event: [String: Any]?,
        storedRoom: HandoffRoom?,
        stateRoomName: String?,
        senderName: String?
    ) -> RenderedNotification {
        let title = nonBlank(storedRoom?.name) ?? nonBlank(stateRoomName) ?? fallbackTitle
        let sender = nonBlank(senderName) ?? (event?["sender"] as? String)
        let subtitle = storedRoom?.direct == true ? "" : (sender ?? "")
        return RenderedNotification(title: title, subtitle: subtitle, body: body(event: event, sender: sender ?? ""))
    }

    /// The value unless it is empty or only Unicode `White_Space` (the set Kotlin's
    /// `isUnicodeWhiteSpace` spells out).
    static func nonBlank(_ value: String?) -> String? {
        guard let value, !value.unicodeScalars.allSatisfy(\.properties.isWhitespace) else { return nil }
        return value
    }

    private static func body(event: [String: Any]?, sender: String) -> String {
        guard let event else { return fallbackBody }
        if (event["unsigned"] as? [String: Any])?["redacted_because"] != nil { return fallbackBody }
        switch event["type"] as? String {
        case "m.room.encrypted": return encryptedBody
        case "m.sticker": return "sent a sticker"
        case "m.room.message": return messageBody(content: event["content"] as? [String: Any], sender: sender)
        default: return fallbackBody
        }
    }

    private static func messageBody(content: [String: Any]?, sender: String) -> String {
        guard let msgtype = content?["msgtype"] as? String else { return fallbackBody }
        if let media = mediaBodies[msgtype] { return media }
        guard let raw = content?["body"] as? String else { return fallbackBody }
        let text = trimAndCap(raw)
        if text.isEmpty { return fallbackBody }
        switch msgtype {
        case "m.text", "m.notice": return text
        case "m.emote": return "* \(sender) \(text)"
        default: return fallbackBody
        }
    }

    /// Trim Unicode whitespace; past 200 code points keep 199 and add an ellipsis. Counts
    /// Unicode scalars, never grapheme clusters or UTF-16 units, so no scalar is split.
    static func trimAndCap(_ body: String) -> String {
        let scalars = body.unicodeScalars
        guard let first = scalars.firstIndex(where: { !$0.properties.isWhitespace }),
              let last = scalars.lastIndex(where: { !$0.properties.isWhitespace })
        else { return "" }
        let trimmed = scalars[first...last]
        guard trimmed.count > maxBodyCodePoints else { return String(trimmed) }
        var kept = String.UnicodeScalarView()
        kept.append(contentsOf: trimmed.prefix(maxBodyCodePoints - 1))
        return String(kept) + "\u{2026}"
    }
}
