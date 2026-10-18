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

/// A room as the app stored it in the push handoff. `encrypted` is false only when the app
/// wrote that the room is not encrypted: an entry stored without the flag counts as encrypted.
public struct HandoffRoom: Codable, Equatable {
    public let name: String
    public let direct: Bool
    public let encrypted: Bool

    public init(name: String, direct: Bool, encrypted: Bool = true) {
        self.name = name
        self.direct = direct
        self.encrypted = encrypted
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        direct = try container.decode(Bool.self, forKey: .direct)
        encrypted = try container.decodeIfPresent(Bool.self, forKey: .encrypted) ?? true
    }
}

/// Trinity's notification text rules, mirrored in Kotlin by `PushRenderRules` (Android).
/// Both run native/push-render/push-render-cases.json; change the fixture and both together.
public enum PushRenderRules {
    public static let fallbackTitle = "Trinity"
    public static let fallbackBody = "New message"
    /// The body when the stored access token had expired, so nothing was read: only the
    /// running app can renew an OAuth token, and opening Trinity does.
    public static let expiredTokenBody = "Open Trinity to read this message"
    public static let encryptedBody = "Encrypted message"
    /// Registered by the app at launch with the placeholder "New message".
    public static let privateCategory = "trinity.message.private"
    static let maxBodyCodePoints = 200

    private static let mediaBodies: [String: String] = [
        "m.image": "sent an image",
        "m.video": "sent a video",
        "m.audio": "sent an audio message",
        "m.file": "sent a file",
        "m.location": "shared a location",
    ]

    /// `tokenExpired`: the account's stored token had expired, so nothing was read and `event`
    /// is nil. The body then says how to read the message instead of "New message".
    public static func render(
        event: [String: Any]?,
        storedRoom: HandoffRoom?,
        stateRoomName: String?,
        senderName: String?,
        tokenExpired: Bool = false,
        mode: NotificationTextMode = .show
    ) -> RenderedNotification {
        // Before anything reads the event. No title: the system shows the app's own name.
        if mode == .alwaysHide {
            return RenderedNotification(title: "", subtitle: "", body: fallbackBody)
        }
        let title = nonBlank(storedRoom?.name) ?? nonBlank(stateRoomName) ?? fallbackTitle
        let sender = nonBlank(senderName) ?? (event?["sender"] as? String)
        let subtitle = storedRoom?.direct == true ? "" : (sender ?? "")
        return RenderedNotification(
            title: title,
            subtitle: subtitle,
            body: body(
                event: event,
                sender: sender ?? "",
                tokenExpired: tokenExpired,
                unencryptedRoom: storedRoom?.encrypted == false
            )
        )
    }

    /// The value unless it is empty or only Unicode `White_Space` (the set Kotlin's
    /// `isUnicodeWhiteSpace` spells out).
    static func nonBlank(_ value: String?) -> String? {
        guard let value, !value.unicodeScalars.allSatisfy(\.properties.isWhitespace) else { return nil }
        return value
    }

    private static func body(
        event: [String: Any]?,
        sender: String,
        tokenExpired: Bool,
        unencryptedRoom: Bool
    ) -> String {
        guard let event else { return tokenExpired ? expiredTokenBody : fallbackBody }
        if (event["unsigned"] as? [String: Any])?["redacted_because"] != nil { return fallbackBody }
        let type = event["type"] as? String
        if type == "m.room.encrypted" { return encryptedBody }
        // Anyone whose server takes part in the room can send it unencrypted text under a
        // member's name. Unless the app stored the room as unencrypted, show none of it.
        guard unencryptedRoom else { return fallbackBody }
        switch type {
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

/// The text fields of a notification's content, so the presentation step stays testable without
/// UserNotifications.
public protocol PushTextContent: AnyObject {
    var title: String { get set }
    var subtitle: String { get set }
    var body: String { get set }
    var categoryIdentifier: String { get set }
}

public extension PushRenderRules {
    /// The last change before the content goes to the system. Always hide drops everything about
    /// the message (no title: the system shows the app's own name); Hide on the lock screen keeps
    /// the text and lets iOS show the private category's placeholder while it hides previews.
    static func present(_ mode: NotificationTextMode, on content: PushTextContent) {
        switch mode {
        case .show:
            break
        case .hideOnLockScreen:
            content.categoryIdentifier = privateCategory
        case .alwaysHide:
            content.title = ""
            content.subtitle = ""
            content.body = fallbackBody
            content.categoryIdentifier = ""
        }
    }
}

public extension PushRenderRules {
    /// Whether to render the message at all: not under Always hide (no fallback naming the room,
    /// no fetch), nor without a store.
    static func rendersMessage(store: HandoffReading?) -> Bool {
        NotificationTextMode.mirrored(by: store) != .alwaysHide
    }

    /// `handler`, reading the mirror again and applying it just before the content is handed
    /// over, on time or when time runs out, so a change made meanwhile still applies.
    static func presenting<Content: PushTextContent>(
        store: HandoffReading?,
        handler: @escaping (Content) -> Void
    ) -> (Content) -> Void {
        { content in
            present(NotificationTextMode.mirrored(by: store), on: content)
            handler(content)
        }
    }
}

public extension NotificationTextMode {
    /// What `store` holds; with no store (no app group), everything is hidden.
    static func mirrored(by store: HandoffReading?) -> NotificationTextMode {
        store?.notificationText() ?? .alwaysHide
    }
}
