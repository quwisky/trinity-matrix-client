//! A row's content from an event's JSON, as `normalize-timeline-event.ts` and `timeline-item.ts`
//! map it. The SDK's own message content is not used: it strips `data-mx-emoticon` and the reply
//! fallback, which the renderer needs.

use std::collections::BTreeMap;

use matrix_sdk::ruma::UserId;
use matrix_sdk_base::crypto::types::events::UtdCause;
use serde_json::Value;

use super::dto::{
    EncryptedFileInfoDto, MediaKindDto, MediaPayloadDto, SystemChangeDto, TextKindDto,
    TimelineItemContentDto, UndecryptableReasonDto,
};

/// The most waveform bars a received voice message keeps: one DOM node each.
const MAX_WAVEFORM_BARS: usize = 512;

const VOICE: &str = "org.matrix.msc3245.voice";
const AUDIO: &str = "org.matrix.msc1767.audio";

/// Content, and the users it names, whose profiles the item carries.
#[derive(Debug, PartialEq)]
pub(super) struct Mapped {
    pub content: TimelineItemContentDto,
    pub named: Vec<String>,
}

impl Mapped {
    fn plain(content: TimelineItemContentDto) -> Self {
        Self {
            content,
            named: Vec::new(),
        }
    }
}

/// A string that is not empty: js `string()`.
fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.is_empty())
}

fn owned(value: &Value) -> Option<String> {
    text(value).map(str::to_owned)
}

fn html_of(content: &Value) -> Option<String> {
    (content["format"] == "org.matrix.custom.html")
        .then(|| content["formatted_body"].as_str().map(str::to_owned))
        .flatten()
}

/// Whether `m.mentions` names `me`: the one trustworthy sign a message is for them.
fn mentions(content: &Value, me: &str) -> bool {
    !me.is_empty()
        && (content["m.mentions"]["user_ids"].as_array())
            .is_some_and(|ids| ids.iter().any(|id| id == me))
}

/// A message-like event's content, from the content a row shows. `reply_fallback` is whether the
/// event names a replied-to event.
pub(super) fn message_like(
    event_type: &str,
    content: &Value,
    reply_fallback: bool,
    me: &str,
) -> Mapped {
    let unsupported = |body: &str| {
        Mapped::plain(TimelineItemContentDto::Unsupported {
            body: body.to_owned(),
            reply_fallback,
        })
    };
    if event_type == "m.sticker" {
        return sticker(content)
            .unwrap_or_else(|| unsupported(text(&content["body"]).unwrap_or("[sticker]")));
    }
    let msgtype = content["msgtype"].as_str().unwrap_or_default();
    match msgtype {
        "m.location" => match parse_geo_uri(&content["geo_uri"]) {
            Some((lat, lng)) => Mapped::plain(TimelineItemContentDto::Location {
                lat,
                lng,
                label: text(&content["body"])
                    .unwrap_or("Shared location")
                    .to_owned(),
            }),
            None => unsupported(text(&content["body"]).unwrap_or("[location]")),
        },
        "m.image" | "m.file" | "m.audio" | "m.video" => match media_payload(content, msgtype) {
            Some(source) => media(content, source, reply_fallback, me),
            None => {
                let kind = &msgtype["m.".len()..];
                unsupported(
                    &text(&content["body"]).map_or_else(|| format!("[{kind}]"), str::to_owned),
                )
            }
        },
        "m.text" | "m.emote" | "m.notice" => match content["body"].as_str() {
            Some(body) => {
                let formatted_body = html_of(content);
                let linked = formatted_body
                    .as_deref()
                    .map(linked_user_ids)
                    .unwrap_or_default();
                Mapped {
                    content: TimelineItemContentDto::Message {
                        msgtype: match msgtype {
                            "m.emote" => TextKindDto::Emote,
                            "m.notice" => TextKindDto::Notice,
                            _ => TextKindDto::Text,
                        },
                        body: body.to_owned(),
                        formatted_body,
                        reply_fallback,
                        mentions_me: mentions(content, me),
                        mentions: linked.clone(),
                    },
                    named: linked,
                }
            }
            None => unsupported(""),
        },
        _ => unsupported(content["body"].as_str().unwrap_or_default()),
    }
}

fn media(content: &Value, source: MediaPayloadDto, reply_fallback: bool, me: &str) -> Mapped {
    let body = content["body"].as_str().unwrap_or_default();
    let captioned = content["filename"].is_string() && !body.is_empty() && body != source.filename;
    let formatted_caption = html_of(content).filter(|_| captioned);
    let linked = formatted_caption
        .as_deref()
        .map(linked_user_ids)
        .unwrap_or_default();
    Mapped {
        content: TimelineItemContentDto::Media {
            msgtype: source.kind,
            body: source.filename.clone(),
            caption: captioned.then(|| body.to_owned()),
            formatted_caption,
            source,
            reply_fallback,
            mentions_me: mentions(content, me),
            mentions: linked.clone(),
        },
        named: linked,
    }
}

fn sticker(content: &Value) -> Option<Mapped> {
    let mut shaped = content.clone();
    let info = content["info"].as_object().cloned().unwrap_or_default();
    let mut shaped_info = info.clone();
    let mimetype = text(&info.get("mimetype").cloned().unwrap_or_default())
        .unwrap_or("image/png")
        .to_owned();
    shaped_info.insert("mimetype".into(), mimetype.into());
    shaped["info"] = Value::Object(shaped_info);
    let source =
        media_payload(&shaped, "m.image").filter(|s| s.mxc.as_deref().is_some_and(valid_mxc))?;
    Some(Mapped::plain(TimelineItemContentDto::Sticker {
        source,
        body: content["body"].as_str().map(str::to_owned),
        url: content["url"].as_str().map(str::to_owned),
        info: content["info"].is_object().then(|| content["info"].clone()),
    }))
}

/// `mxc://server/media`, with no whitespace and no `/` in the server.
fn valid_mxc(uri: &str) -> bool {
    let plain = |s: &str| !s.is_empty() && !s.contains(char::is_whitespace);
    uri.strip_prefix("mxc://")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(server, media)| plain(server) && plain(media))
}

/// An `m.image`/`m.file`/`m.video`/`m.audio` content block, or `None` without a source. The kind
/// is the msgtype's, downgraded to `file` for a declared type that mismatches it or is only for
/// download, so only recognisable media shows inline.
pub(super) fn media_payload(content: &Value, msgtype: &str) -> Option<MediaPayloadDto> {
    let file = encrypted_file(&content["file"]);
    // An encrypted source wins: a `url` beside it must never name or key the bytes.
    let mxc = if file.is_some() {
        None
    } else {
        owned_str(&content["url"])
    };
    if mxc.is_none() && file.is_none() {
        return None;
    }
    let none = Value::Null;
    let info = if content["info"].is_object() {
        &content["info"]
    } else {
        &none
    };
    let declared = info["mimetype"].as_str();
    let essence = mime_essence(declared);
    let mut kind = match msgtype {
        "m.image" => MediaKindDto::Image,
        "m.video" => MediaKindDto::Video,
        "m.audio" => MediaKindDto::Audio,
        _ => MediaKindDto::File,
    };
    let category = match kind {
        MediaKindDto::Image => Some("image/"),
        MediaKindDto::Video => Some("video/"),
        MediaKindDto::Audio => Some("audio/"),
        MediaKindDto::File => None,
    };
    if declared.is_some()
        && (DOWNLOAD_ONLY.contains(&essence.as_str())
            || category.is_some_and(|c| !(inline_essence(&essence) && essence.starts_with(c))))
    {
        kind = MediaKindDto::File;
    }
    let filename = text(&content["filename"])
        .or_else(|| text(&content["body"]))
        .unwrap_or("attachment")
        .to_owned();
    let thumbnail_file = encrypted_file(&info["thumbnail_file"]);
    let is_voice = kind == MediaKindDto::Audio && content.get(VOICE).is_some();
    let audio = &content[AUDIO];
    let waveform = (audio["waveform"].as_array()).map(|bars| {
        bars.iter()
            .take(MAX_WAVEFORM_BARS)
            .filter_map(Value::as_f64)
            .collect()
    });
    Some(MediaPayloadDto {
        kind,
        mxc,
        file,
        filename,
        mime_type: declared.unwrap_or("application/octet-stream").to_owned(),
        size: info["size"].as_f64(),
        width: info["w"].as_f64(),
        height: info["h"].as_f64(),
        duration_ms: info["duration"]
            .as_f64()
            .or_else(|| audio["duration"].as_f64()),
        thumbnail_mxc: if thumbnail_file.is_none() {
            owned_str(&info["thumbnail_url"])
        } else {
            None
        },
        thumbnail_file,
        thumbnail_mime_type: info["thumbnail_info"]["mimetype"]
            .as_str()
            .map(display_safe_mime),
        is_voice: is_voice.then_some(true),
        waveform: if is_voice {
            Some(waveform.unwrap_or_default())
        } else {
            None
        },
    })
}

/// Any string, empty included: js `typeof x === 'string'`.
fn owned_str(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// `content.file`: it needs a `url` and an `iv`, and a key.
fn encrypted_file(value: &Value) -> Option<EncryptedFileInfoDto> {
    let (url, iv) = (value["url"].as_str()?, value["iv"].as_str()?);
    let key = &value["key"];
    if matches!(key, Value::Null | Value::Bool(false)) {
        return None;
    }
    let strings = |map: &Value| -> BTreeMap<String, String> {
        (map.as_object().into_iter().flatten())
            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
            .collect()
    };
    Some(EncryptedFileInfoDto {
        url: url.to_owned(),
        key: key.clone(),
        iv: iv.to_owned(),
        hashes: strings(&value["hashes"]),
        v: value["v"].as_str().unwrap_or_default().to_owned(),
    })
}

/// Document types that are only offered as downloads, never shown inline.
const DOWNLOAD_ONLY: [&str; 5] = [
    "image/svg+xml",
    "text/html",
    "application/xhtml+xml",
    "application/xml",
    "text/xml",
];

/// Types a displayed attachment may be served with.
const DISPLAY_SAFE: [&str; 26] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/apng",
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime",
    "audio/mpeg",
    "audio/ogg",
    "audio/webm",
    "audio/mp4",
    "audio/aac",
    "audio/wav",
    "audio/x-wav",
    "audio/flac",
    "audio/opus",
    "audio/mp3",
    "audio/x-m4a",
    "audio/m4a",
    "audio/x-aac",
    "audio/3gpp",
    "video/x-m4v",
    "video/3gpp",
];

/// The declared type without parameters, trimmed and lowercased; empty when none.
fn mime_essence(declared: Option<&str>) -> String {
    let declared = declared.unwrap_or_default();
    declared
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase()
}

fn display_safe_mime(declared: &str) -> String {
    let essence = mime_essence(Some(declared));
    let canonical = if essence == "image/jpg" {
        "image/jpeg"
    } else {
        &essence
    };
    if DISPLAY_SAFE.contains(&canonical) {
        canonical.to_owned()
    } else {
        "application/octet-stream".to_owned()
    }
}

/// `^(?:image|video|audio)/[a-z0-9][a-z0-9.+-]*$`.
fn inline_essence(essence: &str) -> bool {
    let Some((category, subtype)) = essence.split_once('/') else {
        return false;
    };
    let mut chars = subtype.chars();
    matches!(category, "image" | "video" | "audio")
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '+' | '-'))
}

/// `geo:lat,lng`, ignoring uncertainty and altitude.
pub(super) fn parse_geo_uri(geo_uri: &Value) -> Option<(f64, f64)> {
    let rest = geo_uri.as_str()?.trim().strip_prefix("geo:")?;
    let (lat, rest) = number_prefix(rest)?;
    let (lng, _) = number_prefix(rest.strip_prefix(',')?)?;
    Some((lat, lng))
}

/// `-?\d+(\.\d+)?` at the start of `s`, and what follows.
fn number_prefix(s: &str) -> Option<(f64, &str)> {
    let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
    let sign = usize::from(s.starts_with('-'));
    let whole = digits(&s[sign..]);
    if whole == 0 {
        return None;
    }
    let mut end = sign + whole;
    if let Some(fraction) = s[end..].strip_prefix('.') {
        let fraction = digits(fraction);
        if fraction > 0 {
            end += 1 + fraction;
        }
    }
    Some((s[..end].parse().ok()?, &s[end..]))
}

/// The users `html` links to: what the renderer shows as pills. Anchors only.
pub(super) fn linked_user_ids(html: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for href in anchor_hrefs(html) {
        // shortcut: ruma's id check stands in for `isWellFormedUserId`, which is as strict on
        // the server name; upgrade if a lookalike id ever reaches a pill.
        if let Some(id) = user_link(&href).filter(|id| id.len() <= 255 && UserId::parse(id).is_ok())
            && !ids.contains(&id)
        {
            ids.push(id);
        }
    }
    ids
}

/// The `href` of each `<a>` in `html`.
fn anchor_hrefs(html: &str) -> Vec<String> {
    let mut hrefs = Vec::new();
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        rest = &rest[open + 1..];
        let Some(tag) = rest.strip_prefix(['a', 'A']) else {
            continue;
        };
        if !tag.starts_with([' ', '\t', '\n', '\r', '\x0c']) {
            continue;
        }
        if let Some(href) = attributes(tag).into_iter().find(|(name, _)| name == "href") {
            hrefs.push(href.1);
        }
    }
    hrefs
}

/// A tag's attributes, up to its `>`; names lowercased and values with `&amp;` decoded.
fn attributes(mut s: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    loop {
        s = s.trim_start_matches([' ', '\t', '\n', '\r', '\x0c', '/']);
        if s.is_empty() || s.starts_with('>') {
            return found;
        }
        let end = s
            .find([' ', '\t', '\n', '\r', '\x0c', '=', '>', '/'])
            .unwrap_or(s.len());
        let name = s[..end].to_lowercase();
        s = s[end..].trim_start_matches([' ', '\t', '\n', '\r', '\x0c']);
        let mut value = "";
        if let Some(after) = s.strip_prefix('=') {
            s = after.trim_start_matches([' ', '\t', '\n', '\r', '\x0c']);
            if let Some(quote) = s.chars().next().filter(|c| matches!(c, '"' | '\'')) {
                let inner = &s[1..];
                let close = inner.find(quote).unwrap_or(inner.len());
                (value, s) = (&inner[..close], inner.get(close + 1..).unwrap_or_default());
            } else {
                let close = s
                    .find([' ', '\t', '\n', '\r', '\x0c', '>'])
                    .unwrap_or(s.len());
                (value, s) = (&s[..close], &s[close..]);
            }
        }
        if !name.is_empty() {
            found.push((name, value.replace("&amp;", "&")));
        }
    }
}

/// The user a `matrix.to` link or `matrix:` URI names.
fn user_link(href: &str) -> Option<String> {
    let starts = |prefix: &str| {
        href.get(..prefix.len())
            .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
    };
    if starts("https://matrix.to/#/") || starts("http://matrix.to/#/") {
        let fragment = &href[href.find("#/")? + 2..];
        let path = fragment.split('?').next()?;
        let segments = path
            .split('/')
            .map(percent_decode)
            .collect::<Option<Vec<_>>>()?;
        return match segments.as_slice() {
            [user] if user.starts_with('@') => Some(user.clone()),
            _ => None,
        };
    }
    if starts("matrix:") {
        let path = href["matrix:".len()..].split(['#', '?']).next()?;
        let path = match path.strip_prefix("//") {
            Some(authority) => authority.split_once('/')?.1,
            None => path,
        };
        let segments = path
            .split('/')
            .map(percent_decode)
            .collect::<Option<Vec<_>>>()?;
        return match segments.as_slice() {
            [kind, id] if matches!(kind.as_str(), "u" | "user") && !id.is_empty() => {
                Some(format!("@{id}"))
            }
            _ => None,
        };
    }
    None
}

/// `decodeURIComponent`: `None` for a bad escape or non-UTF-8 bytes.
fn percent_decode(s: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(s.len());
    let mut raw = s.bytes();
    while let Some(b) = raw.next() {
        if b == b'%' {
            let hex = [raw.next()?, raw.next()?];
            bytes.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes)
        .ok()
        .filter(|decoded| !decoded.is_empty())
}

/// The change a state event makes, and the users it names. `None` for a type js does not show.
pub(super) fn state_change(event: &Value) -> Option<(SystemChangeDto, Vec<String>)> {
    let content = &event["content"];
    let previous = &event["unsigned"]["prev_content"];
    let actor_id = event["sender"].as_str().unwrap_or_default().to_owned();
    let (string, previous_string) = (
        |key: &str| owned(&content[key]),
        |key: &str| owned(&previous[key]),
    );
    let mut named = vec![actor_id.clone()];
    let change = match event["type"].as_str()? {
        "m.room.member" => {
            let target_id = event["state_key"].as_str().unwrap_or_default().to_owned();
            named.push(target_id.clone());
            SystemChangeDto::Membership {
                membership: string("membership"),
                previous_membership: previous_string("membership"),
                actor_is_target: actor_id == target_id,
                target_id,
                previous_display_name: previous_string("displayname"),
                display_name: string("displayname"),
                avatar_changed: previous.get("avatar_url") != content.get("avatar_url"),
                reason: string("reason"),
                actor_id,
            }
        }
        "m.room.name" => SystemChangeDto::RoomName {
            actor_id,
            previous_name: previous_string("name"),
            name: string("name"),
        },
        "m.room.topic" => SystemChangeDto::RoomTopic {
            actor_id,
            previous_topic: previous_string("topic"),
            topic: string("topic"),
        },
        "m.room.avatar" => SystemChangeDto::RoomAvatar {
            actor_id,
            previous_url: previous_string("url"),
            url: string("url"),
        },
        "m.room.canonical_alias" => SystemChangeDto::CanonicalAlias {
            actor_id,
            previous_alias: previous_string("alias"),
            alias: string("alias"),
        },
        "m.room.join_rules" => SystemChangeDto::JoinRules {
            actor_id,
            previous_rule: previous_string("join_rule"),
            rule: string("join_rule"),
        },
        "m.room.history_visibility" => SystemChangeDto::HistoryVisibility {
            actor_id,
            previous_visibility: previous_string("history_visibility"),
            visibility: string("history_visibility"),
        },
        "m.room.guest_access" => SystemChangeDto::GuestAccess {
            actor_id,
            previous_access: previous_string("guest_access"),
            access: string("guest_access"),
        },
        "m.room.encryption" => SystemChangeDto::Encryption { actor_id },
        "m.room.create" => SystemChangeDto::Create { actor_id },
        _ => return None,
    };
    Some((change, named))
}

/// js `undecryptableReasonOf`. The two historical causes are inferred from their names.
pub(super) fn utd_reason(cause: UtdCause) -> UndecryptableReasonDto {
    match cause {
        UtdCause::SentBeforeWeJoined => UndecryptableReasonDto::SentBeforeJoining,
        UtdCause::VerificationViolation => UndecryptableReasonDto::SenderIdentityChanged,
        UtdCause::UnsignedDevice | UtdCause::UnknownDevice => {
            UndecryptableReasonDto::UnverifiedSenderDevice
        }
        UtdCause::HistoricalMessageAndBackupIsDisabled => UndecryptableReasonDto::HistoryLocked,
        UtdCause::WithheldForUnverifiedOrInsecureDevice => UndecryptableReasonDto::DeviceUnverified,
        UtdCause::WithheldBySender => UndecryptableReasonDto::Withheld,
        UtdCause::HistoricalMessageAndDeviceIsUnverified => {
            UndecryptableReasonDto::SentBeforeSignIn
        }
        _ => UndecryptableReasonDto::MissingKey,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn to_json(value: impl serde::Serialize) -> Value {
        serde_json::to_value(value).unwrap()
    }

    fn message(content: &Value) -> Value {
        to_json(message_like("m.room.message", content, false, "@me:x").content)
    }

    #[test]
    fn data_mx_emoticon_survives() {
        let html = r#"hi <img data-mx-emoticon src="mxc://x/smile" alt=":smile:" height="32"> <a href="https://matrix.to/#/%40me:x">me</a>"#;
        let mapped = message_like(
            "m.room.message",
            &json!({"msgtype": "m.text", "body": "hi", "format": "org.matrix.custom.html", "formatted_body": html,
                "m.mentions": {"user_ids": ["@me:x"]}}),
            false,
            "@me:x",
        );
        assert_eq!(
            to_json(&mapped.content),
            json!({"kind": "message", "msgtype": "text", "body": "hi", "formattedBody": html,
                "replyFallback": false, "mentionsMe": true, "mentions": ["@me:x"]})
        );
        assert_eq!(mapped.named, ["@me:x"]);
    }

    #[test]
    fn reply_fallback_is_flagged_not_stripped() {
        let content = json!({"msgtype": "m.text", "body": "> <@b:x> q\n\nanswer"});
        let flagged = message_like("m.room.message", &content, true, "@me:x").content;
        assert_eq!(
            to_json(flagged),
            json!({"kind": "message", "msgtype": "text", "body": "> <@b:x> q\n\nanswer", "formattedBody": null,
                "replyFallback": true, "mentionsMe": false, "mentions": []})
        );
    }

    #[test]
    fn membership_state_maps_each_change_with_actor() {
        let event = |prev: Value, content: Value| {
            json!({"type": "m.room.member", "sender": "@a:x", "state_key": "@b:x",
                "content": content, "unsigned": {"prev_content": prev}})
        };
        let cases = [
            (
                event(
                    json!({}),
                    json!({"membership": "invite", "displayname": "B"}),
                ),
                json!({"kind": "membership", "actorId": "@a:x", "membership": "invite", "previousMembership": null,
                    "actorIsTarget": false, "targetId": "@b:x", "previousDisplayName": null, "displayName": "B",
                    "avatarChanged": false, "reason": null}),
            ),
            (
                event(
                    json!({"membership": "join"}),
                    json!({"membership": "leave", "reason": "bye"}),
                ),
                json!({"kind": "membership", "actorId": "@a:x", "membership": "leave", "previousMembership": "join",
                    "actorIsTarget": false, "targetId": "@b:x", "previousDisplayName": null, "displayName": null,
                    "avatarChanged": false, "reason": "bye"}),
            ),
            (
                event(
                    json!({"membership": "join", "displayname": "B", "avatar_url": "mxc://x/1"}),
                    json!({"membership": "join", "displayname": "Bee", "avatar_url": "mxc://x/2"}),
                ),
                json!({"kind": "membership", "actorId": "@a:x", "membership": "join", "previousMembership": "join",
                    "actorIsTarget": false, "targetId": "@b:x", "previousDisplayName": "B", "displayName": "Bee",
                    "avatarChanged": true, "reason": null}),
            ),
        ];
        for (event, expected) in cases {
            let (change, named) = state_change(&event).unwrap();
            assert_eq!(to_json(change), expected);
            assert_eq!(named, ["@a:x", "@b:x"]);
        }
        let own = json!({"type": "m.room.member", "sender": "@a:x", "state_key": "@a:x", "content": {"membership": "join"}});
        let (change, _) = state_change(&own).unwrap();
        assert_eq!(to_json(change)["actorIsTarget"], true);

        let named = json!({"type": "m.room.name", "sender": "@a:x", "content": {"name": "N"}, "unsigned": {"prev_content": {"name": "O"}}});
        assert_eq!(
            to_json(state_change(&named).unwrap().0),
            json!({"kind": "room-name", "actorId": "@a:x", "previousName": "O", "name": "N"})
        );
        assert!(
            state_change(&json!({"type": "m.room.power_levels", "sender": "@a:x", "content": {}}))
                .is_none()
        );
    }

    #[test]
    fn location_parses_geo_uri() {
        let located =
            |uri: &str| message(&json!({"msgtype": "m.location", "body": "Park", "geo_uri": uri}));
        assert_eq!(
            located("geo:51.5,-0.12;u=30"),
            json!({"kind": "location", "lat": 51.5, "lng": -0.12, "label": "Park"})
        );
        assert_eq!(located(" geo:3,4 ")["lat"], 3.0);
        let broken = located("geo:north,south");
        assert_eq!(
            broken,
            json!({"kind": "unsupported", "body": "Park", "replyFallback": false})
        );
        let label = message(&json!({"msgtype": "m.location", "geo_uri": "geo:1,2"}));
        assert_eq!(label["label"], "Shared location");
    }

    #[test]
    fn media_payload_skips_absent_fields() {
        let payload =
            media_payload(&json!({"url": "mxc://x/a", "body": "a.png"}), "m.image").unwrap();
        assert_eq!(
            to_json(payload),
            json!({"kind": "image", "mxc": "mxc://x/a", "file": null, "filename": "a.png",
                "mimeType": "application/octet-stream", "thumbnailMxc": null, "thumbnailFile": null})
        );
        let full = media_payload(
            &json!({"url": "mxc://x/a", "body": "caption", "filename": "a.ogg", "msgtype": "m.audio",
                VOICE: {}, AUDIO: {"duration": 900, "waveform": [1, 512, "x"]},
                "info": {"mimetype": "audio/ogg; codecs=opus", "size": 12, "thumbnail_url": "mxc://x/t",
                    "thumbnail_info": {"mimetype": "image/jpg"}}}),
            "m.audio",
        )
        .unwrap();
        assert_eq!(
            to_json(full),
            json!({"kind": "audio", "mxc": "mxc://x/a", "file": null, "filename": "a.ogg",
                "mimeType": "audio/ogg; codecs=opus", "size": 12.0, "durationMs": 900.0,
                "thumbnailMxc": "mxc://x/t", "thumbnailFile": null, "thumbnailMimeType": "image/jpeg",
                "isVoice": true, "waveform": [1.0, 512.0]})
        );
        assert!(media_payload(&json!({"body": "no source"}), "m.file").is_none());
    }

    #[test]
    fn media_kind_follows_the_declared_type_and_the_encrypted_source_wins() {
        let kind = |msgtype: &str, mime: &str| {
            to_json(
                media_payload(
                    &json!({"url": "mxc://x/a", "info": {"mimetype": mime}}),
                    msgtype,
                )
                .unwrap(),
            )["kind"]
                .clone()
        };
        assert_eq!(kind("m.image", "image/png"), "image");
        assert_eq!(kind("m.image", "image/svg+xml"), "file");
        assert_eq!(kind("m.image", "video/mp4"), "file");
        assert_eq!(kind("m.video", "Video/MP4; x=y"), "video");
        let both = media_payload(
            &json!({"url": "mxc://x/plain", "file": {"url": "mxc://x/enc", "iv": "i", "key": {"k": "secret"},
                "hashes": {"sha256": "h"}, "v": "v2"}}),
            "m.file",
        )
        .unwrap();
        assert_eq!(both.mxc, None);
        assert_eq!(both.file.unwrap().url, "mxc://x/enc");
    }

    #[test]
    fn a_file_key_is_in_no_debug_output() {
        let payload = media_payload(
            &json!({"file": {"url": "mxc://x/enc", "iv": "i", "key": {"k": "TOPSECRET"}, "hashes": {}, "v": "v2"}}),
            "m.file",
        )
        .unwrap();
        let shown = format!(
            "{payload:?} {:?}",
            message_like(
                "m.room.message",
                &json!({"msgtype": "m.file", "body": "f",
            "file": {"url": "mxc://x/enc", "iv": "i", "key": {"k": "TOPSECRET"}}}),
                false,
                ""
            )
        );
        assert!(!shown.contains("TOPSECRET"), "{shown}");
        assert!(shown.contains("<redacted>"));
    }

    #[test]
    fn unknown_msgtype_is_unsupported() {
        assert_eq!(
            message(&json!({"msgtype": "org.example.zap", "body": "zap"})),
            json!({"kind": "unsupported", "body": "zap", "replyFallback": false})
        );
        assert_eq!(
            message(&json!({"msgtype": "m.text"})),
            json!({"kind": "unsupported", "body": "", "replyFallback": false})
        );
        assert_eq!(
            message(&json!({"msgtype": "m.image", "body": "nothing"}))["body"],
            "nothing"
        );
        assert_eq!(message(&json!({"msgtype": "m.video"}))["body"], "[video]");
    }

    #[test]
    fn a_sticker_needs_a_valid_mxc() {
        let content = json!({"body": "wave", "url": "mxc://x/s", "info": {"w": 8}});
        let mapped = to_json(message_like("m.sticker", &content, false, "").content);
        assert_eq!(mapped["kind"], "sticker");
        assert_eq!(mapped["source"]["mimeType"], "image/png");
        assert_eq!(mapped["info"], json!({"w": 8}));
        let bad =
            to_json(message_like("m.sticker", &json!({"url": "http://x/s"}), false, "").content);
        assert_eq!(
            bad,
            json!({"kind": "unsupported", "body": "[sticker]", "replyFallback": false})
        );
    }

    #[test]
    fn linked_users_are_read_from_matrix_links_only() {
        let html = concat!(
            r#"<a href="https://matrix.to/#/%40a:x">a</a> <A HREF='matrix:u/b:y'>b</A> "#,
            r#"<a href="https://matrix.to/#/!room:x">room</a> <a href="https://example.com/#/@c:x">c</a> "#,
            r#"<a href="https://matrix.to/#/@a:x?via=x">again</a> <abbr href="https://matrix.to/#/@d:x">d</abbr> "#,
            r#"<a href="https://matrix.to/#/@bad">e</a> <a name=x href=https://matrix.to/#/@f:x>f</a>"#,
        );
        assert_eq!(linked_user_ids(html), ["@a:x", "@b:y", "@f:x"]);
    }

    #[test]
    fn utd_reasons_map_each_cause() {
        use UndecryptableReasonDto::*;
        let table = [
            (UtdCause::SentBeforeWeJoined, SentBeforeJoining),
            (UtdCause::VerificationViolation, SenderIdentityChanged),
            (UtdCause::UnsignedDevice, UnverifiedSenderDevice),
            (UtdCause::UnknownDevice, UnverifiedSenderDevice),
            (
                UtdCause::HistoricalMessageAndBackupIsDisabled,
                HistoryLocked,
            ),
            (
                UtdCause::WithheldForUnverifiedOrInsecureDevice,
                DeviceUnverified,
            ),
            (UtdCause::WithheldBySender, Withheld),
            (
                UtdCause::HistoricalMessageAndDeviceIsUnverified,
                SentBeforeSignIn,
            ),
            (UtdCause::Unknown, MissingKey),
        ];
        for (cause, reason) in table {
            assert_eq!(utd_reason(cause), reason, "{cause:?}");
        }
    }
}
