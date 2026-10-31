//! A timeline item as `TimelineEngine`'s row (map §1.1). A remote item's content is mapped from
//! its raw JSON, because the SDK's message content drops `data-mx-emoticon` and the reply
//! fallback; the SDK supplies the item's kind, send state, reactions, receipts, poll results and
//! why a message could not be decrypted.

use std::collections::BTreeMap;

use matrix_sdk::{
    Room,
    ruma::{
        EventId, OwnedUserId, UserId,
        events::{
            AnySyncMessageLikeEvent, AnySyncStateEvent, AnySyncTimelineEvent,
            room::message::MessageType,
        },
        room_version_rules::RoomVersionRules,
        serde::Raw,
    },
    send_queue::LocalEcho,
    serde_helpers::extract_thread_root,
};
use matrix_sdk_ui::timeline::{
    EmbeddedEvent, EncryptedMessage, EventSendState, EventTimelineItem, MsgLikeContent,
    MsgLikeKind, PollState, ReactionsByKeyBySender, TimelineDetails, TimelineEventShieldState,
    TimelineEventShieldStateCode, TimelineItem, TimelineItemContent, default_event_filter,
};
use serde_json::Value;
use tokio::sync::OnceCell;

use super::{
    content::{Mapped, message_like, state_change, utd_reason},
    dto::{
        EventTimelineItemDto, InReplyToDetailsDto, InReplyToDto, PollOptionDto, PollViewDto,
        ProfileDto, ReactionGroupDto, SendStateDto, ShieldCodeDto, ShieldColourDto,
        ShieldReasonDto, TimelineItemContentDto, TimelineItemDto, TimelineRoomStateDto,
        TombstoneDto, UndecryptableReasonDto,
    },
};
use crate::{
    engines::room_list::{
        RoomEncryptionDto,
        rows::{encrypted_at, mark, preview, saturated},
    },
    failure::{FailureKind, classify},
};

/// How many readers an item names: past this the avatars are noise.
const MAX_READERS: usize = 5;
/// How many reactors a reaction names; the rest come from `reactionDetails`.
const MAX_NAMED_REACTORS: usize = 3;

/// What mapping the items of one room needs besides the item.
#[derive(Debug)]
pub(super) struct RowContext {
    pub room: Room,
    pub me: OwnedUserId,
    /// The date of the room's `m.room.encryption`, read when a clear message first needs it.
    pub encrypted_at: OnceCell<Option<u64>>,
    #[expect(dead_code, reason = "T6 calls it")]
    pub echoes: OnceCell<Vec<LocalEcho>>,
}

impl RowContext {
    pub(super) fn new(room: Room, me: OwnedUserId) -> Self {
        Self {
            room,
            me,
            encrypted_at: OnceCell::new(),
            echoes: OnceCell::new(),
        }
    }
}

/// The SDK's default filter, narrowed to what js shows: of the state events, the ten kinds
/// `systemLine` words, and no call events (H14).
pub(super) fn event_filter(event: &AnySyncTimelineEvent, rules: &RoomVersionRules) -> bool {
    default_event_filter(event, rules)
        && match event {
            AnySyncTimelineEvent::State(state) => matches!(
                state,
                AnySyncStateEvent::RoomMember(_)
                    | AnySyncStateEvent::RoomName(_)
                    | AnySyncStateEvent::RoomTopic(_)
                    | AnySyncStateEvent::RoomAvatar(_)
                    | AnySyncStateEvent::RoomCanonicalAlias(_)
                    | AnySyncStateEvent::RoomJoinRules(_)
                    | AnySyncStateEvent::RoomHistoryVisibility(_)
                    | AnySyncStateEvent::RoomGuestAccess(_)
                    | AnySyncStateEvent::RoomEncryption(_)
                    | AnySyncStateEvent::RoomCreate(_)
            ),
            AnySyncTimelineEvent::MessageLike(
                AnySyncMessageLikeEvent::CallInvite(_)
                | AnySyncMessageLikeEvent::RtcNotification(_),
            ) => false,
            AnySyncTimelineEvent::MessageLike(_) => true,
        }
}

/// The row for one item of the SDK's list. Dividers never get here: the fold drops them.
pub(super) async fn row(item: &TimelineItem, ctx: &RowContext) -> TimelineItemDto {
    let unique_id = item.unique_id().0.clone();
    match item.as_event() {
        Some(event) => TimelineItemDto::Event(Box::new(EventTimelineItemDto {
            unique_id,
            ..item_row(event, ctx).await
        })),
        None if item.is_timeline_start() => TimelineItemDto::TimelineStart { unique_id },
        None => TimelineItemDto::ReadMarker { unique_id },
    }
}

fn json_of(raw: Option<&Raw<AnySyncTimelineEvent>>) -> Option<Value> {
    raw?.deserialize_as().ok()
}

/// The row of one event item.
pub(super) async fn item_row(item: &EventTimelineItem, ctx: &RowContext) -> EventTimelineItemDto {
    let original = json_of(item.original_json());
    let edit = json_of(item.latest_edit_json());
    let msg = item.content().as_msglike();
    let me = ctx.me.as_str();
    let sender = item.sender().to_string();

    let relation = original.as_ref().map(|o| &o["content"]["m.relates_to"]);
    let raw_reply = relation.and_then(|r| r["m.in_reply_to"]["event_id"].as_str());
    let reply_fallback = match relation {
        Some(_) => raw_reply.is_some_and(|id| !id.is_empty()),
        None => msg.is_some_and(|m| m.in_reply_to.is_some()),
    };
    let thread_fallback =
        relation.is_some_and(|r| r["rel_type"] == "m.thread" && r["is_falling_back"] == true);

    let Mapped { content, mut named } =
        content_of(item, original.as_ref(), edit.as_ref(), reply_fallback, me);

    let in_reply_to = match msg.and_then(|m| m.in_reply_to.as_ref()) {
        _ if thread_fallback => None,
        Some(reply) => Some(InReplyToDto {
            event_id: reply.event_id.to_string(),
            details: reply_details(&reply.event),
        }),
        None => raw_reply
            .filter(|id| !id.is_empty())
            .map(|id| InReplyToDto {
                event_id: id.to_owned(),
                details: InReplyToDetailsDto::Unavailable,
            }),
    };
    if let Some(InReplyToDto {
        details: InReplyToDetailsDto::Ready { sender, .. },
        ..
    }) = &in_reply_to
    {
        named.insert(0, sender.clone());
    }

    let reactions = msg.map_or_else(Vec::new, |m| reaction_groups(&m.reactions, me));
    let read_by: Vec<String> = (item.read_receipts().keys())
        .filter(|user| **user != ctx.me && user.as_str() != sender)
        .take(MAX_READERS)
        .map(ToString::to_string)
        .collect();

    let (shield, in_clear) = shield_of(&item.get_shield(false));
    let timestamp = item.timestamp();
    let unencrypted_mark = if in_clear {
        let at = *ctx
            .encrypted_at
            .get_or_init(|| encrypted_at(&ctx.room))
            .await;
        mark(true, true, Some(u64::from(timestamp.get())), at)
    } else {
        None
    };

    let mut ids = vec![sender.clone()];
    ids.extend(named);
    ids.extend(reactions.iter().flat_map(|group| group.senders.clone()));
    ids.extend(read_by.clone());
    let mut profiles = BTreeMap::new();
    for id in ids {
        if profiles.contains_key(&id) {
            continue;
        }
        if let Some(profile) = profile_of(&ctx.room, &id).await {
            profiles.insert(id, profile);
        }
    }

    EventTimelineItemDto {
        // The list item's, which `row` sets.
        unique_id: String::new(),
        event_id: item.event_id().map(ToString::to_string),
        // shortcut: the remote echo's raw `unsigned.transaction_id`, which a restart or another
        // device's send lacks; T5 reads its send table first.
        transaction_id: original
            .as_ref()
            .and_then(|o| o["unsigned"]["transaction_id"].as_str())
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
        sender,
        is_own: item.is_own(),
        timestamp: f64::from(timestamp.get()),
        send_state: send_state_of(item),
        content,
        edited: item.content().as_message().is_some_and(|m| m.is_edited()),
        in_reply_to,
        reactions,
        read_by,
        shield,
        unencrypted_mark,
        profiles,
    }
}

/// An event's content and the users it names.
fn content_of(
    item: &EventTimelineItem,
    original: Option<&Value>,
    edit: Option<&Value>,
    reply_fallback: bool,
    me: &str,
) -> Mapped {
    let unsupported = |body: &str| Mapped {
        content: TimelineItemContentDto::Unsupported {
            body: body.to_owned(),
            reply_fallback,
        },
        named: Vec::new(),
    };
    // The valid edit's `m.new_content` is what shows, the original's relation is what counts.
    let shown = || {
        edit.map(|edit| &edit["content"]["m.new_content"])
            .filter(|content| content.is_object())
            .or_else(|| original.map(|original| &original["content"]))
    };
    let from_raw = || match (original, shown()) {
        (Some(original), Some(content)) => original["type"]
            .as_str()
            .map(|event_type| message_like(event_type, content, reply_fallback, me)),
        _ => None,
    };
    match item.content() {
        TimelineItemContent::MsgLike(msg) => match &msg.kind {
            MsgLikeKind::Redacted => Mapped {
                content: TimelineItemContentDto::Redacted {
                    reply_fallback: false,
                },
                named: Vec::new(),
            },
            MsgLikeKind::UnableToDecrypt(encrypted) => Mapped {
                content: TimelineItemContentDto::UnableToDecrypt {
                    reason: Some(reason_of(encrypted)),
                    reply_fallback,
                },
                named: Vec::new(),
            },
            MsgLikeKind::Poll(state) => Mapped {
                content: TimelineItemContentDto::Poll {
                    poll: poll_view(state, item.event_id(), me),
                },
                named: Vec::new(),
            },
            MsgLikeKind::Message(_) | MsgLikeKind::Sticker(_) => from_raw()
                .or_else(|| {
                    let (event_type, content) = typed(msg)?;
                    Some(message_like(event_type, &content, reply_fallback, me))
                })
                .unwrap_or_else(|| unsupported("")),
            MsgLikeKind::Other(_) | MsgLikeKind::LiveLocation(_) => unsupported(""),
        },
        TimelineItemContent::FailedToParseMessageLike { .. } => {
            from_raw().unwrap_or_else(|| unsupported(""))
        }
        TimelineItemContent::MembershipChange(_)
        | TimelineItemContent::ProfileChange(_)
        | TimelineItemContent::OtherState(_)
        | TimelineItemContent::FailedToParseState { .. } => original
            .and_then(state_change)
            .map(|(change, named)| Mapped {
                content: TimelineItemContentDto::State { change },
                named,
            })
            .unwrap_or_else(|| unsupported("")),
        _ => unsupported(""),
    }
}

/// A local echo has no raw event: its content as the SDK holds it, with the SDK's sanitising.
fn typed(msg: &MsgLikeContent) -> Option<(&'static str, Value)> {
    match &msg.kind {
        MsgLikeKind::Message(message) => {
            let msgtype: &MessageType = message.msgtype();
            let mut content = Value::Object(msgtype.data().into_owned());
            content["msgtype"] = msgtype.msgtype().into();
            if let Some(mentions) = message.mentions() {
                content["m.mentions"] = serde_json::to_value(mentions).ok()?;
            }
            Some(("m.room.message", content))
        }
        MsgLikeKind::Sticker(sticker) => {
            Some(("m.sticker", serde_json::to_value(sticker.content()).ok()?))
        }
        _ => None,
    }
}

fn reason_of(encrypted: &EncryptedMessage) -> UndecryptableReasonDto {
    match encrypted {
        EncryptedMessage::MegolmV1AesSha2 { cause, .. } => utd_reason(*cause),
        _ => UndecryptableReasonDto::MissingKey,
    }
}

/// The results the SDK counts.
// shortcut: the SDK lets anyone who can post end a poll and counts votes in an encrypted room
// that were sent in the clear; T15 ports js's power-level and encryption rules.
fn poll_view(state: &PollState, id: Option<&EventId>, me: &str) -> PollViewDto {
    let results = state.results();
    let mut voters = std::collections::BTreeSet::new();
    let options = (results.answers.iter())
        .map(|answer| {
            let votes = results.votes.get(&answer.id).map_or(&[][..], Vec::as_slice);
            voters.extend(votes.iter());
            PollOptionDto {
                id: answer.id.clone(),
                text: answer.text.clone(),
                votes: saturated(votes.len()),
                chosen: votes.iter().any(|voter| voter == me),
            }
        })
        .collect();
    PollViewDto {
        id: id.map(ToString::to_string).unwrap_or_default(),
        question: results.question,
        options,
        total_votes: saturated(voters.len()),
        max_selections: saturated(results.max_selections).max(1),
        ended: results.end_time.is_some(),
    }
}

fn reply_details(event: &TimelineDetails<Box<EmbeddedEvent>>) -> InReplyToDetailsDto {
    let TimelineDetails::Ready(quoted) = event else {
        return match event {
            TimelineDetails::Pending => InReplyToDetailsDto::Pending,
            _ => InReplyToDetailsDto::Unavailable,
        };
    };
    let redacted = matches!(
        quoted.content.as_msglike().map(|m| &m.kind),
        Some(MsgLikeKind::Redacted)
    );
    let body = match quoted.content.as_msglike().map(|m| &m.kind) {
        Some(MsgLikeKind::Message(message)) => Some(message.body()),
        Some(MsgLikeKind::Sticker(sticker)) => Some(sticker.content().body.as_str()),
        _ => None,
    };
    InReplyToDetailsDto::Ready {
        sender: quoted.sender.to_string(),
        body: if redacted {
            String::new()
        } else {
            preview(body, false, false)
        },
        redacted,
        // shortcut: an embedded event carries no encryption info, so a quote has no mark; look
        // the quoted item up to mark it.
        unencrypted_mark: None,
    }
}

/// `Pending` is not produced: the quoted event is never fetched here.
fn send_state_of(item: &EventTimelineItem) -> Option<SendStateDto> {
    match item.send_state()? {
        EventSendState::NotSentYet { .. } => Some(SendStateDto::Sending),
        EventSendState::Sent { .. } => None,
        EventSendState::SendingFailed {
            error,
            is_recoverable,
        } => {
            let temporary = matches!(
                classify(error).0,
                FailureKind::Network | FailureKind::RateLimit
            );
            let text = item.content().as_message().is_some_and(|m| {
                matches!(
                    m.msgtype(),
                    MessageType::Text(_) | MessageType::Emote(_) | MessageType::Notice(_)
                )
            });
            Some(if *is_recoverable && temporary && text {
                SendStateDto::Waiting
            } else {
                SendStateDto::Failed {
                    recoverable: *is_recoverable,
                }
            })
        }
    }
}

/// Groups by count, most first, the earliest reaction breaking a tie; the earliest reactors
/// first within a group.
fn reaction_groups(reactions: &ReactionsByKeyBySender, me: &str) -> Vec<ReactionGroupDto> {
    let mut groups: Vec<_> = reactions
        .iter()
        .filter(|(key, senders)| !key.is_empty() && !senders.is_empty())
        .map(|(key, senders)| {
            let mut by_time: Vec<_> = senders.iter().collect();
            by_time.sort_by_key(|(_, info)| info.timestamp);
            let first = by_time[0].1.timestamp;
            let group = ReactionGroupDto {
                key: key.clone(),
                count: saturated(by_time.len()),
                reacted_by_me: by_time.iter().any(|(sender, _)| sender.as_str() == me),
                senders: (by_time.iter())
                    .take(MAX_NAMED_REACTORS)
                    .map(|(sender, _)| sender.to_string())
                    .collect(),
            };
            (first, group)
        })
        .collect();
    groups.sort_by(|(a_first, a), (b_first, b)| b.count.cmp(&a.count).then(a_first.cmp(b_first)));
    groups.into_iter().map(|(_, group)| group).collect()
}

/// The shield js shows, and whether the item arrived in the clear in an encrypted room, which
/// the unencrypted mark covers instead.
fn shield_of(state: &TimelineEventShieldState) -> (Option<ShieldCodeDto>, bool) {
    let (colour, code) = match state {
        TimelineEventShieldState::None => return (None, false),
        TimelineEventShieldState::Red { code } => (ShieldColourDto::Red, code),
        TimelineEventShieldState::Grey { code } => (ShieldColourDto::Grey, code),
    };
    let reason = match code {
        TimelineEventShieldStateCode::SentInClear => return (None, true),
        TimelineEventShieldStateCode::AuthenticityNotGuaranteed => {
            ShieldReasonDto::AuthenticityNotGuaranteed
        }
        TimelineEventShieldStateCode::UnknownDevice => ShieldReasonDto::UnknownDevice,
        TimelineEventShieldStateCode::UnsignedDevice => ShieldReasonDto::UnsignedDevice,
        TimelineEventShieldStateCode::UnverifiedIdentity => ShieldReasonDto::UnverifiedIdentity,
        TimelineEventShieldStateCode::VerificationViolation => {
            ShieldReasonDto::VerificationViolation
        }
        TimelineEventShieldStateCode::MismatchedSender => ShieldReasonDto::MismatchedSender,
    };
    (Some(ShieldCodeDto { colour, reason }), false)
}

/// js `profileOf`: a name that is the user id is no name. A stranger has no profile.
// shortcut: one store read per named user per row; a hub-wide cache if piece 3 measures it slow.
pub(super) async fn profile_of(room: &Room, user_id: &str) -> Option<ProfileDto> {
    let member = room
        .get_member_no_sync(<&UserId>::try_from(user_id).ok()?)
        .await
        .ok()??;
    let avatar_mxc = member.avatar_url().map(ToString::to_string);
    let name = member
        .display_name()
        .filter(|name| !name.is_empty() && *name != user_id);
    Some(ProfileDto {
        display_name_ambiguous: name.is_some() && member.name_ambiguous(),
        display_name: name.map(str::to_owned),
        avatar_mxc,
    })
}

/// The room's own state; `oldest_event_id` is the caller's, from the rows it shows.
pub(super) async fn room_state(room: &Room) -> TimelineRoomStateDto {
    let encryption = room.encryption_state();
    TimelineRoomStateDto {
        encryption: if encryption.is_encrypted() {
            RoomEncryptionDto::Encrypted
        } else if encryption.is_unknown() {
            RoomEncryptionDto::Unknown
        } else {
            RoomEncryptionDto::Unencrypted
        },
        has_encryption_state_event: encryption.is_encrypted(),
        tombstone: room.successor_room().map(|successor| TombstoneDto {
            replacement_room_id: successor.room_id.to_string(),
            body: successor.reason.unwrap_or_default(),
        }),
        latest_confirmed_event_id: latest_confirmed(room).await,
        oldest_event_id: None,
    }
}

/// The newest event the room cache holds that is not a thread reply: what a read receipt
/// acknowledges, hidden events included.
async fn latest_confirmed(room: &Room) -> Option<String> {
    let (cache, _handles) = room.event_cache().await.ok()?;
    let found = cache.rfind_map_event_in_memory_by(|event| {
        let id = event.event_id()?.to_string();
        extract_thread_root(event.raw()).is_none().then_some(id)
    });
    found.await.ok()?
}
