//! A timeline item as `TimelineEngine`'s row (map §1.1). A remote item's content is mapped from
//! its raw JSON, because the SDK's message content drops `data-mx-emoticon` and the reply
//! fallback; the SDK supplies the item's kind, send state, reactions, receipts, poll results and
//! why a message could not be decrypted.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

use matrix_sdk::{
    Room,
    ruma::{
        EventId, OwnedUserId, UserId,
        events::{
            AnyMessageLikeEventContent, AnySyncTimelineEvent, MessageLikeEventType, StateEventType,
            poll::unstable_start::UnstablePollStartEventContent,
            room::message::{MessageType, Relation},
        },
        room_version_rules::RoomVersionRules,
        serde::Raw,
    },
    send_queue::LocalEcho,
    serde_helpers::extract_thread_root,
};
use matrix_sdk_ui::{
    eyeball_im::Vector,
    timeline::{
        EmbeddedEvent, EncryptedMessage, EventSendState, EventTimelineItem, MsgLikeContent,
        MsgLikeKind, PollState, ReactionsByKeyBySender, TimelineDetails, TimelineEventShieldState,
        TimelineEventShieldStateCode, TimelineItem, TimelineItemContent,
    },
};
use serde_json::Value;
use tokio::sync::OnceCell;

use super::{
    content::{Mapped, is_poll_start, message_like, poll_start, state_change, truthy, utd_reason},
    dto::{
        EventTimelineItemDto, InReplyToDetailsDto, InReplyToDto, PollOptionDto, PollViewDto,
        ProfileDto, ReactionGroupDto, SendStateDto, ShieldCodeDto, ShieldColourDto,
        ShieldReasonDto, TimelineItemContentDto, TimelineItemDto, TimelineRoomStateDto,
        TombstoneDto, UndecryptableReasonDto,
    },
};
use crate::{
    engines::room_list::{
        RoomEncryptionDto, UnencryptedMarkDto,
        rows::{encrypted_at, mark, preview, saturated},
    },
    failure::{FailureKind, classify},
};

/// How many readers an item names: past this the avatars are noise.
const MAX_READERS: usize = 5;
/// How many reactors a reaction names; the rest come from `reactionDetails`.
const MAX_NAMED_REACTORS: usize = 3;

/// How many members one row reads, because a body from another user can link thousands. Enough
/// for the sender, a quote, the readers, three reactors on each of a dozen keys and a score of
/// mentions; a mention past it shows its user id, as a member with no name does.
const MAX_PROFILES: usize = 64;

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

/// The state events `systemLine` words.
fn is_system_type(event_type: &StateEventType) -> bool {
    matches!(
        event_type,
        StateEventType::RoomMember
            | StateEventType::RoomName
            | StateEventType::RoomTopic
            | StateEventType::RoomAvatar
            | StateEventType::RoomCanonicalAlias
            | StateEventType::RoomJoinRules
            | StateEventType::RoomHistoryVisibility
            | StateEventType::RoomGuestAccess
            | StateEventType::RoomEncryption
            | StateEventType::RoomCreate
    )
}

/// What js shows (`isDisplayableMessage`, `isPresentableSystemEvent`). Not chained on the SDK's
/// default: that refuses a custom msgtype and the stable poll, and shows a deleted row for a
/// custom type.
pub(super) fn event_filter(event: &AnySyncTimelineEvent, _rules: &RoomVersionRules) -> bool {
    match event {
        AnySyncTimelineEvent::State(state) => {
            state.original_content().is_some() && is_system_type(&state.event_type())
        }
        AnySyncTimelineEvent::MessageLike(msg) => match msg.original_content() {
            None => matches!(
                msg.event_type(),
                MessageLikeEventType::RoomMessage
                    | MessageLikeEventType::Sticker
                    | MessageLikeEventType::RoomEncrypted
                    | MessageLikeEventType::PollStart
                    | MessageLikeEventType::UnstablePollStart
            ),
            Some(AnyMessageLikeEventContent::RoomMessage(content)) => {
                !matches!(content.relates_to, Some(Relation::Replacement(_)))
            }
            Some(
                AnyMessageLikeEventContent::Sticker(_)
                | AnyMessageLikeEventContent::PollStart(_)
                | AnyMessageLikeEventContent::UnstablePollStart(UnstablePollStartEventContent::New(
                    _,
                ))
                | AnyMessageLikeEventContent::RoomEncrypted(_),
            ) => true,
            Some(_) => false,
        },
    }
}

/// Whether an event that did not parse was redacted: a list item has lost its JSON, and one that
/// arrived so says it in `unsigned`.
fn arrived_redacted(item: &EventTimelineItem) -> bool {
    item.original_json().is_none()
        || json_of(item.original_json())
            .is_some_and(|event| truthy(&event["unsigned"]["redacted_because"]))
}

/// A list item js has no row for and `event_filter` could not stop: the SDK lists an event that
/// did not parse without asking the filter, and a redaction leaves a state item in place.
// shortcut: the SDK lists a threaded reply that did not parse in the live list too, where js hides
// it; T12 hides it there with the focus and `extract_thread_root`.
pub(super) fn is_hidden(item: &EventTimelineItem) -> bool {
    match item.content() {
        TimelineItemContent::FailedToParseMessageLike { event_type, .. } => match event_type {
            MessageLikeEventType::PollStart | MessageLikeEventType::UnstablePollStart => false,
            MessageLikeEventType::RoomMessage | MessageLikeEventType::Sticker => {
                json_of(item.original_json()).is_some_and(|event| {
                    event["content"]["m.relates_to"]["rel_type"] == "m.replace"
                })
            }
            _ => true,
        },
        TimelineItemContent::FailedToParseState { event_type, .. } => {
            !is_system_type(event_type) || arrived_redacted(item)
        }
        TimelineItemContent::MembershipChange(_)
        | TimelineItemContent::ProfileChange(_)
        | TimelineItemContent::OtherState(_) => item.original_json().is_none(),
        _ => false,
    }
}

/// A row js counts as a message, not as room state.
pub(super) fn is_message_row(content: &TimelineItemContent) -> bool {
    matches!(
        content,
        TimelineItemContent::MsgLike(_) | TimelineItemContent::FailedToParseMessageLike { .. }
    )
}

/// What the rows of one mapping pass share.
pub(super) struct Pass<'a> {
    items: &'a Vector<Arc<TimelineItem>>,
    events: Option<HashMap<&'a EventId, &'a EventTimelineItem>>,
    /// A member costs about six store reads, and the stream polls nothing while it maps.
    profiles: HashMap<String, Option<ProfileDto>>,
}

impl<'a> Pass<'a> {
    /// A pass over the rows of `items`, the SDK's whole list at this point.
    pub(super) fn new(items: &'a Vector<Arc<TimelineItem>>) -> Self {
        Self {
            items,
            events: None,
            profiles: HashMap::new(),
        }
    }

    fn event(&mut self, id: &EventId) -> Option<&'a EventTimelineItem> {
        let items = self.items;
        let events = self.events.get_or_insert_with(|| {
            (items.iter())
                .filter_map(|item| {
                    let event = item.as_event()?;
                    Some((event.event_id()?, event))
                })
                .collect()
        });
        events.get(id).copied()
    }

    async fn profile(&mut self, room: &Room, id: &str) -> Option<ProfileDto> {
        if let Some(known) = self.profiles.get(id) {
            return known.clone();
        }
        let profile = profile_of(room, id).await;
        self.profiles.insert(id.to_owned(), profile.clone());
        profile
    }
}

/// The row for one item of the SDK's list. Dividers never get here: the fold drops them.
pub(super) async fn row(
    item: &TimelineItem,
    ctx: &RowContext,
    pass: &mut Pass<'_>,
) -> TimelineItemDto {
    let unique_id = item.unique_id().0.clone();
    match item.as_event() {
        Some(event) => TimelineItemDto::Event(Box::new(EventTimelineItemDto {
            unique_id,
            ..item_row(event, ctx, pass).await
        })),
        None if item.is_timeline_start() => TimelineItemDto::TimelineStart { unique_id },
        None => TimelineItemDto::ReadMarker { unique_id },
    }
}

fn json_of(raw: Option<&Raw<AnySyncTimelineEvent>>) -> Option<Value> {
    raw?.deserialize_as().ok()
}

/// The row of one event item.
pub(super) async fn item_row(
    item: &EventTimelineItem,
    ctx: &RowContext,
    pass: &mut Pass<'_>,
) -> EventTimelineItemDto {
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

    let Mapped { content, named } =
        content_of(item, original.as_ref(), edit.as_ref(), reply_fallback, me);

    let in_reply_to = match msg.and_then(|m| m.in_reply_to.as_ref()) {
        _ if thread_fallback => None,
        Some(reply) => {
            let quote_mark = match pass.event(&reply.event_id) {
                Some(quoted) => clear_mark(quoted, ctx).await,
                None => None,
            };
            Some(InReplyToDto {
                event_id: reply.event_id.to_string(),
                details: reply_details(&reply.event, quote_mark),
            })
        }
        None => raw_reply
            .filter(|id| !id.is_empty())
            .map(|id| InReplyToDto {
                event_id: id.to_owned(),
                details: InReplyToDetailsDto::Unavailable,
            }),
    };

    let reactions = msg.map_or_else(Vec::new, |m| reaction_groups(&m.reactions, me));
    let read_by: Vec<String> = (item.read_receipts().keys())
        .filter(|user| **user != ctx.me && user.as_str() != sender)
        .take(MAX_READERS)
        .map(ToString::to_string)
        .collect();

    let (shield, _) = shield_of(&item.get_shield(false));
    let unencrypted_mark = clear_mark(item, ctx).await;

    // As js orders them, and the mentions last: the cap should cost a pill's name, not an avatar.
    let mut ids = vec![sender.clone()];
    if let Some(InReplyToDto {
        details: InReplyToDetailsDto::Ready { sender, .. },
        ..
    }) = &in_reply_to
    {
        ids.push(sender.clone());
    }
    ids.extend(reactions.iter().flat_map(|group| group.senders.clone()));
    ids.extend(read_by.clone());
    ids.extend(named);
    let mut asked = HashSet::new();
    let mut profiles = BTreeMap::new();
    let distinct = ids.into_iter().filter(|id| asked.insert(id.clone()));
    for id in distinct.take(MAX_PROFILES) {
        if let Some(profile) = pass.profile(&ctx.room, &id).await {
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
        timestamp: f64::from(item.timestamp().get()),
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

/// js `unencryptedMarkFor`: only a message that arrived in the clear in an encrypted room, never
/// room state or a deleted message.
async fn clear_mark(item: &EventTimelineItem, ctx: &RowContext) -> Option<UnencryptedMarkDto> {
    let is_text = match item.content() {
        TimelineItemContent::MsgLike(msg) => !matches!(msg.kind, MsgLikeKind::Redacted),
        TimelineItemContent::FailedToParseMessageLike { .. } => !arrived_redacted(item),
        _ => false,
    };
    if !is_text || !shield_of(&item.get_shield(false)).1 {
        return None;
    }
    let at = *ctx
        .encrypted_at
        .get_or_init(|| encrypted_at(&ctx.room))
        .await;
    mark(true, true, Some(u64::from(item.timestamp().get())), at)
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
        (Some(original), Some(content)) => original["type"].as_str().map(|event_type| {
            if is_poll_start(event_type) {
                let id = item.event_id().map(ToString::to_string).unwrap_or_default();
                let poll = poll_start(content, &id);
                Mapped::plain(TimelineItemContentDto::Poll { poll })
            } else {
                message_like(event_type, content, reply_fallback, me)
            }
        }),
        _ => None,
    };
    let deleted = || {
        Mapped::plain(TimelineItemContentDto::Redacted {
            reply_fallback: false,
        })
    };
    match item.content() {
        TimelineItemContent::MsgLike(msg) => match &msg.kind {
            MsgLikeKind::Redacted => deleted(),
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
            MsgLikeKind::Message(_) | MsgLikeKind::Sticker(_) | MsgLikeKind::Other(_) => from_raw()
                .or_else(|| {
                    let (event_type, content) = typed(msg)?;
                    Some(message_like(event_type, &content, reply_fallback, me))
                })
                .unwrap_or_else(|| unsupported("")),
            MsgLikeKind::LiveLocation(_) => unsupported(""),
        },
        TimelineItemContent::FailedToParseMessageLike { .. } if arrived_redacted(item) => deleted(),
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

// shortcut: nothing fetches a quoted event, so one outside the list reads `Unavailable` and
// `Pending` never shows; call `fetch_details_for_event` when a quote must show from further back.
fn reply_details(
    event: &TimelineDetails<Box<EmbeddedEvent>>,
    unencrypted_mark: Option<UnencryptedMarkDto>,
) -> InReplyToDetailsDto {
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
        unencrypted_mark,
    }
}

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
pub(super) async fn profile_of(room: &Room, user_id: &str) -> Option<ProfileDto> {
    let member = room
        .get_member_no_sync(<&UserId>::try_from(user_id).ok()?)
        .await
        .ok()??;
    let (display_name, display_name_ambiguous) =
        shown_name(member.display_name(), user_id, member.name_ambiguous());
    Some(ProfileDto {
        display_name,
        display_name_ambiguous,
        avatar_mxc: member.avatar_url().map(ToString::to_string),
    })
}

/// js `RoomMember.name` from a raw display name: a name of hidden characters is none, and
/// direction overrides go. Bidi marks count as ambiguous, which the SDK's `shared` does not cover;
/// it does cover a name like a user id.
// shortcut: `shared` also counts a name with a zero-width character, such as a joined emoji, which
// js does not: such a member shows their id too; compare the store's count if anyone minds.
fn shown_name(name: Option<&str>, user_id: &str, shared: bool) -> (Option<String>, bool) {
    let hidden = |c: char| {
        c.is_whitespace()
            || matches!(
                c,
                '\u{2000}'..='\u{200f}'
                    | '\u{202a}'..='\u{202f}'
                    | '\u{300}'..='\u{36f}'
                    | '\u{feff}'
                    | '\u{61c}'
                    | '\u{2800}'
                    | '\u{2062}'..='\u{2063}'
            )
    };
    let Some(raw) = name.filter(|name| *name != user_id && !name.chars().all(hidden)) else {
        return (None, false);
    };
    let bidi = |c: char| matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202f}');
    let ambiguous = shared || raw.contains(bidi);
    let shown = raw.replace(['\u{202d}', '\u{202e}'], "");
    if !ambiguous && shown == user_id {
        return (None, false);
    }
    (Some(shown), ambiguous)
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

#[cfg(test)]
pub(super) mod tests {
    use std::{pin::pin, time::Duration};

    use futures_util::StreamExt;
    use matrix_sdk::{
        ruma::{MilliSecondsSinceUnixEpoch, UInt, event_id, owned_user_id, room_id, user_id},
        timeout::timeout,
    };
    use matrix_sdk_ui::timeline::ReactionInfo;
    use serde_json::json;
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    use super::{
        super::{Focus, TimelineFocusDto, hub::Hub, is_marker, is_virtual, marker_row, timeline},
        *,
    };
    use crate::{
        accounts::{AccountRuntime, Engine},
        dispatch::dispatch,
        testing::{engine_in, sync, syncing},
    };

    const ME: &str = "@a:b";
    const ROOM: &str = "!r:b";

    fn event(event_type: &str, id: &str, content: Value) -> Value {
        json!({"type": event_type, "event_id": id, "sender": "@b:b", "origin_server_ts": 5,
            "content": content})
    }

    fn state(event_type: &str, id: &str, content: Value) -> Value {
        let mut state = event(event_type, id, content);
        state["state_key"] = json!("");
        state
    }

    fn redacted(mut event: Value) -> Value {
        event["unsigned"] = json!({"redacted_because": {"type": "m.room.redaction",
            "event_id": "$why", "sender": "@b:b", "origin_server_ts": 6, "content": {}}});
        event
    }

    fn text(id: &str) -> Value {
        event(
            "m.room.message",
            id,
            json!({"msgtype": "m.text", "body": "hi"}),
        )
    }

    fn own(id: &str) -> Value {
        let mut own = text(id);
        own["sender"] = json!(ME);
        own
    }

    fn encrypted() -> Value {
        state(
            "m.room.encryption",
            "$enc",
            json!({"algorithm": "m.megolm.v1.aes-sha2"}),
        )
    }

    fn poll_answer() -> Value {
        json!({"m.id": "a", "m.text": [{"body": "A"}]})
    }

    /// A room's list as the SDK holds it, reached through the real sync and timeline.
    struct Listed {
        _root: TempDir,
        _engine: Arc<Engine>,
        _rt: Arc<AccountRuntime>,
        _hub: Arc<Hub>,
        room: Room,
        items: Vector<Arc<TimelineItem>>,
    }

    fn joined(events: Vec<Value>, room_state: Vec<Value>, fully_read: Option<&str>) -> Value {
        let read = fully_read.map_or_else(Vec::new, |id| {
            vec![json!({"type": "m.fully_read", "content": {"event_id": id}})]
        });
        json!({"rooms": {"join": {ROOM: {
            "timeline": {"events": events},
            "state_after": {"events": room_state},
            "account_data": {"events": read},
        }}}})
    }

    /// `events`, whose last has the id `$end`, synced into a room that holds `room_state`.
    async fn listed(
        room_state: Vec<Value>,
        events: Vec<Value>,
        fully_read: Option<&str>,
    ) -> Listed {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let bodies = vec![
            joined(vec![], room_state, None),
            joined(events, vec![], fully_read),
        ];
        let rt = syncing(&engine, bodies).await;
        sync(&rt.client).await;
        let room = rt.client.get_room(room_id!("!r:b")).unwrap();
        let hub = rt.hubs.open(&room, Focus::Live).await.unwrap();
        let (mut items, batches) = hub.timeline.subscribe().await;
        let mut batches = pin!(batches);
        sync(&rt.client).await;
        let ready = |items: &Vector<Arc<TimelineItem>>| {
            let has = |id: &str| {
                (items.iter()).any(|item| {
                    let event = item.as_event().and_then(|event| event.event_id());
                    event.is_some_and(|event| event == id)
                })
            };
            has("$end") && (fully_read.is_none() || items.iter().any(|item| is_marker(item)))
        };
        while !ready(&items) {
            let batch = timeout(batches.next(), Duration::from_secs(5)).await;
            for diff in batch.expect("the events in time").unwrap() {
                diff.apply(&mut items);
            }
        }
        Listed {
            _root: root,
            _engine: engine,
            _rt: rt,
            _hub: hub,
            room,
            items,
        }
    }

    impl Listed {
        fn ctx(&self) -> RowContext {
            RowContext::new(self.room.clone(), owned_user_id!("@a:b"))
        }

        /// The rows the interface gets, by event id.
        async fn rows(&self) -> BTreeMap<String, Value> {
            let ctx = self.ctx();
            let mut pass = Pass::new(&self.items);
            let mut rows = BTreeMap::new();
            for item in self.items.iter().filter(|item| !is_virtual(item)) {
                let shown = serde_json::to_value(row(item, &ctx, &mut pass).await).unwrap();
                if let Some(id) = shown["eventId"].as_str() {
                    rows.insert(id.to_owned(), shown.clone());
                }
            }
            rows
        }
    }

    #[test]
    fn the_filter_lets_through_what_js_shows() {
        let message = json!({"msgtype": "m.text", "body": "x"});
        let edit = json!({"msgtype": "org.example.zap", "body": "x", "m.new_content": message,
            "m.relates_to": {"rel_type": "m.replace", "event_id": "$o"}});
        let target =
            json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$o", "key": "k"}});
        let reference = json!({"rel_type": "m.reference", "event_id": "$o"});
        let stable_poll = json!({"m.text": [{"body": "q"}], "m.poll": {
            "question": {"m.text": [{"body": "q"}]}, "answers": [poll_answer()]}});
        let unstable_poll = json!({"org.matrix.msc1767.text": "q",
            "org.matrix.msc3381.poll.start": {"question": {"org.matrix.msc1767.text": "q"},
                "kind": "org.matrix.msc3381.poll.disclosed", "max_selections": 1,
                "answers": [{"id": "a", "org.matrix.msc1767.text": "A"}]}});
        let cases = [
            (event("m.room.message", "$", message.clone()), true),
            (
                event(
                    "m.room.message",
                    "$",
                    json!({"msgtype": "org.example.zap", "body": "zap"}),
                ),
                true,
            ),
            (event("m.room.message", "$", edit), false),
            (
                event(
                    "m.sticker",
                    "$",
                    json!({"body": "s", "url": "mxc://x/s", "info": {}}),
                ),
                true,
            ),
            (event("m.poll.start", "$", stable_poll), true),
            (
                event("org.matrix.msc3381.poll.start", "$", unstable_poll),
                true,
            ),
            (
                event(
                    "m.room.encrypted",
                    "$",
                    json!({"algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "c",
                        "sender_key": "k", "session_id": "s", "device_id": "d"}),
                ),
                true,
            ),
            (event("m.reaction", "$", target), false),
            (
                event(
                    "org.matrix.msc3381.poll.response",
                    "$",
                    json!({"m.relates_to": reference,
                        "org.matrix.msc3381.poll.response": {"answers": ["a"]}}),
                ),
                false,
            ),
            (
                event(
                    "m.call.invite",
                    "$",
                    json!({"call_id": "c", "lifetime": 1, "version": 0,
                        "offer": {"type": "offer", "sdp": ""}}),
                ),
                false,
            ),
            (
                event("org.example.custom", "$", json!({"body": "x"})),
                false,
            ),
            (redacted(event("m.room.message", "$", json!({}))), true),
            (redacted(event("m.sticker", "$", json!({}))), true),
            (redacted(event("m.room.encrypted", "$", json!({}))), true),
            (redacted(event("m.poll.start", "$", json!({}))), true),
            (
                redacted(event("org.matrix.msc3381.poll.response", "$", json!({}))),
                false,
            ),
            (redacted(event("m.call.invite", "$", json!({}))), false),
            (redacted(event("m.reaction", "$", json!({}))), false),
            (redacted(event("org.example.custom", "$", json!({}))), false),
            (state("m.room.name", "$", json!({"name": "n"})), true),
            (
                state("m.room.create", "$", json!({"creator": "@b:b"})),
                true,
            ),
            (state("m.room.power_levels", "$", json!({})), false),
            (state("org.example.state", "$", json!({})), false),
            (redacted(state("m.room.name", "$", json!({}))), false),
        ];
        let rules = RoomVersionRules::V11;
        for (raw, shown) in cases {
            let parsed: AnySyncTimelineEvent = serde_json::from_value(raw.clone()).unwrap();
            assert_eq!(event_filter(&parsed, &rules), shown, "{raw}");
        }
    }

    #[test]
    fn a_shield_is_its_code_and_a_clear_message_has_none() {
        use TimelineEventShieldStateCode as Code;
        let red = |code| TimelineEventShieldState::Red { code };
        assert_eq!(shield_of(&TimelineEventShieldState::None), (None, false));
        assert_eq!(shield_of(&red(Code::SentInClear)), (None, true));
        let grey = TimelineEventShieldState::Grey {
            code: Code::UnknownDevice,
        };
        assert_eq!(
            shield_of(&grey),
            (
                Some(ShieldCodeDto {
                    colour: ShieldColourDto::Grey,
                    reason: ShieldReasonDto::UnknownDevice,
                }),
                false
            )
        );
        let table = [
            (
                Code::AuthenticityNotGuaranteed,
                ShieldReasonDto::AuthenticityNotGuaranteed,
            ),
            (Code::UnsignedDevice, ShieldReasonDto::UnsignedDevice),
            (
                Code::UnverifiedIdentity,
                ShieldReasonDto::UnverifiedIdentity,
            ),
            (
                Code::VerificationViolation,
                ShieldReasonDto::VerificationViolation,
            ),
            (Code::MismatchedSender, ShieldReasonDto::MismatchedSender),
        ];
        for (code, reason) in table {
            let (shield, in_clear) = shield_of(&red(code));
            assert_eq!(shield.unwrap().reason, reason);
            assert!(!in_clear);
        }
    }

    #[test]
    fn reactions_group_by_count_then_the_earliest() {
        let mut reactions = ReactionsByKeyBySender::default();
        let info = |ms: u32| ReactionInfo {
            timestamp: MilliSecondsSinceUnixEpoch(UInt::from(ms)),
            send_state: None,
        };
        let mut react = |key: &str, sender: &UserId, ms| {
            (reactions.entry(key.to_owned()).or_default()).insert(sender.to_owned(), info(ms));
        };
        let (a, b, c, d) = (
            user_id!("@a:b"),
            user_id!("@b:b"),
            user_id!("@c:b"),
            user_id!("@d:b"),
        );
        react("later", b, 9);
        react("earlier", c, 3);
        react("most", d, 40);
        react("most", b, 30);
        react("most", a, 20);
        react("most", c, 10);
        react("", a, 1);
        reactions.insert("nobody".to_owned(), Default::default());
        let groups = reaction_groups(&reactions, ME);
        let keys: Vec<_> = groups.iter().map(|group| group.key.as_str()).collect();
        assert_eq!(keys, ["most", "earlier", "later"]);
        assert_eq!(groups[0].count, 4);
        assert!(groups[0].reacted_by_me);
        assert_eq!(groups[0].senders, ["@c:b", "@a:b", "@b:b"]);
        assert!(!groups[1].reacted_by_me);
    }

    #[test]
    fn a_name_is_cleaned_as_js_cleans_it() {
        let id = "@u:b";
        let table = [
            (None, false, (None, false)),
            (Some(""), false, (None, false)),
            (Some(id), false, (None, false)),
            (
                Some(" \u{200b}\u{feff}\u{2800}\u{300}\t"),
                true,
                (None, false),
            ),
            (Some("Bob"), false, (Some("Bob"), false)),
            (Some("Bob"), true, (Some("Bob"), true)),
            (Some("B\u{202e}ob\u{202d}"), false, (Some("Bob"), true)),
            (Some("Bo\u{200f}b"), false, (Some("Bo\u{200f}b"), true)),
            (Some("Bo\u{200b}b"), false, (Some("Bo\u{200b}b"), false)),
            (Some("@u\u{2060}:b"), false, (Some("@u\u{2060}:b"), false)),
        ];
        for (name, shared, (shown, ambiguous)) in table {
            assert_eq!(
                shown_name(name, id, shared),
                (shown.map(str::to_owned), ambiguous),
                "{name:?}"
            );
        }
    }

    pub(in super::super) fn hostile() -> Vec<(Value, Option<Value>)> {
        let unsupported =
            |body: &str| Some(json!({"kind": "unsupported", "body": body, "replyFallback": false}));
        let deleted = Some(json!({"kind": "redacted", "replyFallback": false}));
        let member = json!({"kind": "membership", "actorId": "@b:b", "membership": null,
            "previousMembership": null, "actorIsTarget": false, "targetId": "@c:b",
            "previousDisplayName": null, "displayName": null, "avatarChanged": false, "reason": null});
        let mut bad_member = event("m.room.member", "$bad-member", json!("x"));
        bad_member["state_key"] = json!("@c:b");
        let poll = |id: &str, question: &str, options: Value| {
            Some(
                json!({"kind": "poll", "poll": {"id": id, "question": question, "options": options,
                "totalVotes": 0, "maxSelections": 1, "ended": false}}),
            )
        };
        vec![
            (
                event(
                    "m.room.message",
                    "$far-away",
                    json!({"msgtype": "m.location", "body": "there",
                        "geo_uri": format!("geo:{},0", "9".repeat(400))}),
                ),
                unsupported("there"),
            ),
            (
                event("m.sticker", "$sticker-text", json!("x")),
                unsupported("[sticker]"),
            ),
            (
                event("m.sticker", "$sticker-list", json!([1])),
                unsupported("[sticker]"),
            ),
            (
                event("m.room.message", "$text-text", json!("x")),
                unsupported(""),
            ),
            (
                event(
                    "m.room.message",
                    "$text-number",
                    json!({"msgtype": "m.text", "body": 1}),
                ),
                unsupported(""),
            ),
            (
                event(
                    "m.room.message",
                    "$custom",
                    json!({"msgtype": "org.example.zap", "body": "zap"}),
                ),
                unsupported("zap"),
            ),
            (
                event(
                    "m.room.message",
                    "$bad-edit",
                    json!({"msgtype": 1,
                    "m.relates_to": {"rel_type": "m.replace", "event_id": "$x"}}),
                ),
                None,
            ),
            (
                event(
                    "m.reaction",
                    "$bad-reaction",
                    json!({"msgtype": "m.text", "body": "boo"}),
                ),
                None,
            ),
            (
                event("org.matrix.msc3381.poll.response", "$bad-vote", json!("x")),
                None,
            ),
            (
                state("m.room.power_levels", "$bad-levels", json!({"users": "x"})),
                None,
            ),
            (
                state(
                    "m.room.message",
                    "$state-message",
                    json!({"msgtype": "m.text", "body": "x"}),
                ),
                None,
            ),
            (bad_member, Some(json!({"kind": "state", "change": member}))),
            (
                event("org.example.custom", "$custom-type", json!({"body": "x"})),
                None,
            ),
            (
                event(
                    "m.poll.start",
                    "$js-poll",
                    json!({"m.poll.start": {
                    "question": {"m.text": "q"}, "answers": [{"id": "a", "m.text": "A"}]}}),
                ),
                poll(
                    "$js-poll",
                    "q",
                    json!([{"id": "a", "text": "A", "votes": 0, "chosen": false}]),
                ),
            ),
            (
                event(
                    "m.poll.start",
                    "$stable-poll",
                    json!({"m.text": [{"body": "q"}], "m.poll": {
                    "question": {"m.text": [{"body": "q"}]}, "answers": [poll_answer()]}}),
                ),
                poll("$stable-poll", "", json!([])),
            ),
            (
                event("m.poll.start", "$bad-poll", json!("x")),
                poll("$bad-poll", "", json!([])),
            ),
            (
                redacted(state("m.room.name", "$gone-name", json!({}))),
                None,
            ),
            (
                redacted(event(
                    "org.matrix.msc3381.poll.response",
                    "$gone-vote",
                    json!({}),
                )),
                None,
            ),
            (
                redacted(event("m.call.invite", "$gone-call", json!({}))),
                None,
            ),
            (
                redacted(event("m.room.message", "$gone-text", json!({}))),
                deleted.clone(),
            ),
            (
                redacted(event("m.room.message", "$gone-bad", json!("x"))),
                deleted,
            ),
            (
                redacted(state("m.room.member", "$gone-bad-state", json!("x"))),
                None,
            ),
            (
                json!({"type": "m.room.message", "event_id": "$no-sender", "content": "x"}),
                None,
            ),
            (
                json!({"type": "m.room.message", "sender": "@b:b", "content": "x"}),
                None,
            ),
            (
                event(
                    "m.reaction",
                    "$reacts-to-text",
                    json!({"m.relates_to": "x"}),
                ),
                None,
            ),
            (
                event(
                    "m.reaction",
                    "$reaction-key",
                    json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$sticker-text", "key": 7}}),
                ),
                None,
            ),
            (
                event(
                    "m.reaction",
                    "$relates-to-itself",
                    json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$relates-to-itself", "key": "k"}}),
                ),
                None,
            ),
        ]
    }

    #[tokio::test]
    async fn a_hostile_event_is_a_row_or_nothing_in_the_list() {
        let cases = hostile();
        let mut events: Vec<Value> = cases.iter().map(|(raw, _)| raw.clone()).collect();
        events.push(text("$end"));
        let rows = listed(vec![encrypted()], events, None).await.rows().await;
        assert!(rows.contains_key("$end"));
        for (raw, expected) in cases {
            let Some(id) = raw["event_id"].as_str() else {
                continue;
            };
            let content = rows.get(id).map(|row| row["content"].clone());
            assert_eq!(content, expected, "{raw}");
        }
    }

    #[tokio::test]
    async fn a_stream_outlives_hostile_events_and_opens_on_them() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let mut events: Vec<Value> = hostile().into_iter().map(|(raw, _)| raw).collect();
        events.push(text("$end"));
        let bodies = vec![
            joined(vec![], vec![encrypted()], None),
            joined(events, vec![], None),
        ];
        let rt = syncing(&engine, bodies).await;
        sync(&rt.client).await;
        let open = || {
            let live = TimelineFocusDto::Live;
            timeline(Arc::clone(&engine), ME.into(), ROOM.into(), live)
        };
        let mut live = open();
        let next = async |items: &mut crate::dispatch::Stream| {
            let frame = timeout(items.next(), Duration::from_secs(5)).await;
            frame.expect("a frame in time").unwrap().expect("no fault")
        };
        next(&mut live).await;
        sync(&rt.client).await;
        while !next(&mut live).await.to_string().contains("$end") {}
        let reopened = next(&mut open()).await.to_string();
        assert!(reopened.contains("$sticker-text") && reopened.contains("$end"));
    }

    #[tokio::test]
    async fn a_redaction_takes_a_state_row_away_and_leaves_a_message_deleted() {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let shown = vec![
            state("m.room.name", "$name", json!({"name": "n"})),
            text("$text"),
        ];
        let redaction = |id: &str, target: &str| {
            let mut redaction = event("m.room.redaction", id, json!({"redacts": target}));
            redaction["redacts"] = json!(target);
            redaction
        };
        let bodies = vec![
            joined(vec![], vec![encrypted()], None),
            joined(shown, vec![], None),
            joined(
                vec![redaction("$r1", "$name"), redaction("$r2", "$text")],
                vec![],
                None,
            ),
        ];
        let rt = syncing(&engine, bodies).await;
        sync(&rt.client).await;
        let live = TimelineFocusDto::Live;
        let mut items = timeline(Arc::clone(&engine), ME.into(), ROOM.into(), live);
        let mut next = async || {
            let frame = timeout(items.next(), Duration::from_secs(5)).await;
            frame.expect("a frame in time").unwrap().unwrap()
        };
        next().await;
        sync(&rt.client).await;
        while !next().await.to_string().contains("$text") {}
        sync(&rt.client).await;
        let mut changes = Vec::new();
        while changes.len() < 2 {
            changes.extend(next().await["diffs"].as_array().unwrap().iter().cloned());
        }
        assert_eq!(changes[0]["op"], "remove", "{changes:?}");
        assert_eq!(changes[0]["index"], 0, "{changes:?}");
        assert_eq!(changes[1]["op"], "set", "{changes:?}");
        assert_eq!(changes[1]["value"]["content"]["kind"], "redacted");
    }

    #[tokio::test]
    async fn a_clear_message_is_marked_and_quoted_with_its_mark() {
        let reply = json!({"msgtype": "m.text", "body": "hi",
            "m.relates_to": {"m.in_reply_to": {"event_id": "$clear"}}});
        let events = vec![
            text("$clear"),
            event("m.room.message", "$reply", reply),
            state("m.room.name", "$state", json!({"name": "n"})),
            redacted(event("m.room.message", "$deleted", json!({}))),
            event("m.room.message", "$bad", json!("x")),
            text("$end"),
        ];
        let rows = listed(vec![encrypted()], events, None).await.rows().await;
        let mark = |id: &str| rows[id]["unencryptedMark"].clone();
        assert_eq!(mark("$clear"), "unencrypted");
        assert_eq!(mark("$bad"), "unencrypted", "a message that did not parse");
        assert_eq!(mark("$state"), Value::Null);
        assert_eq!(mark("$deleted"), Value::Null);
        assert_eq!(rows["$clear"]["shield"], Value::Null);
        let quote = &rows["$reply"]["inReplyTo"]["details"];
        assert_eq!(quote["kind"], "ready");
        assert_eq!(quote["unencryptedMark"], "unencrypted");
    }

    #[tokio::test]
    async fn the_marker_goes_before_the_first_unread_message_or_nowhere() {
        let me = user_id!("@a:b");
        let unread = listed(
            vec![],
            vec![
                text("$read"),
                own("$mine"),
                state("m.room.name", "$name", json!({"name": "n"})),
                state("m.room.power_levels", "$hidden", json!({"users": "x"})),
                event("m.room.message", "$unread", json!("x")),
                text("$end"),
            ],
            Some("$read"),
        )
        .await;
        let ctx = RowContext::new(unread.room.clone(), me.to_owned());
        let target = marker_row(&unread._hub, &ctx, &unread.items, false).await;
        let target = target.expect("an unread message");
        assert!(matches!(target.1, TimelineItemDto::ReadMarker { .. }));
        assert_eq!(
            target.0, 3,
            "past our own and the state row, counting no hidden row"
        );
        let in_thread = marker_row(&unread._hub, &ctx, &unread.items, true).await;
        assert!(in_thread.is_none(), "a thread has none");

        let only_state = state("m.room.name", "$end", json!({"name": "m"}));
        let caught_up = listed(vec![], vec![text("$read"), only_state], Some("$read")).await;
        assert!(
            caught_up.items.iter().any(|item| is_marker(item)),
            "the SDK has one, before the state row"
        );
        let ctx = RowContext::new(caught_up.room.clone(), me.to_owned());
        let target = marker_row(&caught_up._hub, &ctx, &caught_up.items, false).await;
        assert!(target.is_none());
    }

    /// A stream's rows, by event id, or by kind for a row with none.
    fn apply_frame(rows: &mut Vec<String>, frame: &Value) {
        let name = |row: &Value| {
            let name = row["eventId"].as_str().or(row["kind"].as_str());
            name.unwrap().to_owned()
        };
        let at = |diff: &Value| usize::try_from(diff["index"].as_u64().unwrap()).unwrap();
        for diff in frame["diffs"].as_array().unwrap() {
            match diff["op"].as_str().unwrap() {
                "reset" => {
                    *rows = diff["values"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(name)
                        .collect()
                }
                "append" => rows.extend(diff["values"].as_array().unwrap().iter().map(name)),
                "pushFront" => rows.insert(0, name(&diff["value"])),
                "pushBack" => rows.push(name(&diff["value"])),
                "insert" => rows.insert(at(diff), name(&diff["value"])),
                "set" => rows[at(diff)] = name(&diff["value"]),
                "remove" => drop(rows.remove(at(diff))),
                other => panic!("{other}"),
            }
        }
    }

    /// An account whose `m.fully_read` names `$read`, past a sync of `events`, the last with the
    /// id `$end` and in the event cache. `later` answers its next syncs.
    async fn read_up_to(
        root: &TempDir,
        events: Vec<Value>,
        later: Vec<Value>,
    ) -> (Arc<Engine>, Arc<AccountRuntime>) {
        let engine = engine_in(root);
        let bodies = vec![
            joined(vec![], vec![encrypted()], None),
            joined(events, vec![], Some("$read")),
        ];
        let rt = syncing(&engine, [bodies, later].concat()).await;
        sync(&rt.client).await;
        sync(&rt.client).await;
        let room = rt.client.get_room(room_id!("!r:b")).unwrap();
        let (cache, _handles) = room.event_cache().await.unwrap();
        let cached = async {
            while cache.find_event(event_id!("$end")).await.unwrap().is_none() {
                matrix_sdk::sleep::sleep(Duration::from_millis(5)).await;
            }
        };
        timeout(cached, Duration::from_secs(5)).await.unwrap();
        (engine, rt)
    }

    /// The stream's frames, polled from a task of their own as the carrier polls.
    fn frames_of(engine: &Arc<Engine>) -> mpsc::UnboundedReceiver<Value> {
        let live = TimelineFocusDto::Live;
        let mut stream = timeline(Arc::clone(engine), ME.into(), ROOM.into(), live);
        let (shown, frames) = mpsc::unbounded_channel();
        matrix_sdk::executor::spawn(async move {
            while let Some(Ok(frame)) = stream.next().await {
                let _ = shown.send(frame);
            }
        });
        frames
    }

    async fn next_frame(frames: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        let frame = timeout(frames.recv(), Duration::from_secs(5)).await;
        frame.expect("a frame in time").unwrap()
    }

    /// The rows of the first frame of a room read up to `$read`.
    async fn first_rows(events: Vec<Value>) -> Vec<String> {
        let root = TempDir::new().unwrap();
        let (engine, _rt) = read_up_to(&root, events, vec![]).await;
        let mut rows = Vec::new();
        apply_frame(&mut rows, &next_frame(&mut frames_of(&engine)).await);
        rows
    }

    #[tokio::test]
    async fn a_fully_read_event_no_row_shows_keeps_the_marker() {
        let reaction = json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$before", "key": "k"}});
        let edit = json!({"msgtype": "m.text", "body": "* x",
            "m.new_content": {"msgtype": "m.text", "body": "x"},
            "m.relates_to": {"rel_type": "m.replace", "event_id": "$before"}});
        let hidden = [
            event("m.reaction", "$read", reaction),
            event("m.room.message", "$read", edit),
            state("m.room.power_levels", "$read", json!({"users": {}})),
        ];
        for hidden in hidden {
            let rows = first_rows(vec![text("$before"), hidden.clone(), text("$end")]).await;
            assert_eq!(rows, ["$before", "readMarker", "$end"], "{hidden}");
        }

        let hidden = state("m.room.power_levels", "$read", json!({"users": {}}));
        let rows = first_rows(vec![text("$before"), hidden, own("$end")]).await;
        assert_eq!(rows, ["$before", "$end"], "nothing unread, no marker");

        let hidden = state("m.room.power_levels", "$read", json!({"users": {}}));
        let rows = first_rows(vec![hidden, text("$end")]).await;
        assert_eq!(rows, ["readMarker", "$end"], "before the first row");
    }

    #[tokio::test]
    async fn a_marker_above_the_window_waits_for_its_page() {
        let hidden = state("m.room.power_levels", "$read", json!({"users": {}}));
        let mut events = vec![hidden];
        events.extend((0..30).map(|n| text(&format!("$m{n}"))));
        events.push(text("$end"));
        let root = TempDir::new().unwrap();
        let (engine, _rt) = read_up_to(&root, events, vec![]).await;
        let mut frames = frames_of(&engine);
        let mut rows = Vec::new();
        apply_frame(&mut rows, &next_frame(&mut frames).await);
        assert!(
            rows.len() <= 20 && !rows.contains(&"readMarker".to_owned()),
            "{rows:?}"
        );

        let args = vec![json!(ME), json!(ROOM), json!({"kind": "live"}), json!(30)];
        let page = dispatch(&engine, "timeline.paginateBackwards", args);
        let reply = timeout(page.unwrap().next(), Duration::from_secs(5)).await;
        assert_eq!(reply.unwrap().unwrap().unwrap()["ok"], true);
        while let Ok(frame) = frames.try_recv() {
            apply_frame(&mut rows, &frame);
        }
        let marker = rows.iter().position(|row| row == "readMarker");
        let marker = marker.unwrap_or_else(|| panic!("{rows:?}"));
        assert_eq!(rows[marker + 1], "$m0", "{rows:?}");
    }

    #[tokio::test]
    async fn a_live_batch_places_the_marker_and_moves_it() {
        let hidden = |id: &str| state("m.room.power_levels", id, json!({"users": {}}));
        let later = vec![
            joined(vec![own("$mine")], vec![], None),
            joined(vec![text("$unread")], vec![], None),
            joined(
                vec![hidden("$later"), text("$newest")],
                vec![],
                Some("$later"),
            ),
        ];
        let events = vec![text("$before"), hidden("$read"), own("$end")];
        let root = TempDir::new().unwrap();
        let (engine, rt) = read_up_to(&root, events, later).await;
        let mut frames = frames_of(&engine);
        let mut rows = Vec::new();
        apply_frame(&mut rows, &next_frame(&mut frames).await);
        assert_eq!(rows, ["$before", "$end"], "nothing unread yet");

        let mut until_shows = async |rows: &mut Vec<String>, id: &str| {
            sync(&rt.client).await;
            while !rows.iter().any(|row| row == id) {
                apply_frame(rows, &next_frame(&mut frames).await);
            }
        };
        until_shows(&mut rows, "$mine").await;
        assert_eq!(rows, ["$before", "$end", "$mine"], "our own is no unread");
        until_shows(&mut rows, "$unread").await;
        assert_eq!(rows, ["$before", "$end", "$mine", "readMarker", "$unread"]);
        until_shows(&mut rows, "$newest").await;
        assert_eq!(
            rows,
            [
                "$before",
                "$end",
                "$mine",
                "$unread",
                "readMarker",
                "$newest"
            ],
            "a fully-read event no row shows moves it"
        );
    }

    #[tokio::test]
    async fn a_row_reads_a_bounded_number_of_profiles_and_keeps_every_mention() {
        let member = |user: &str, name: &str| {
            let mut member = state(
                "m.room.member",
                "$member",
                json!({"membership": "join", "displayname": name}),
            );
            member["state_key"] = json!(user);
            member["sender"] = json!(user);
            member
        };
        let over = MAX_PROFILES + 10;
        let html: String = (0..over)
            .map(|n| format!("<a href=\"https://matrix.to/#/@u{n}:b\">u</a>"))
            .collect();
        let reply = json!({"msgtype": "m.text", "body": "hi", "format": "org.matrix.custom.html",
            "formatted_body": html, "m.relates_to": {"m.in_reply_to": {"event_id": "$quoted"}}});
        let mut quoted = text("$quoted");
        quoted["sender"] = json!("@c:b");
        let list = listed(
            vec![member("@b:b", "Bob"), member("@c:b", "Cy")],
            vec![quoted, event("m.room.message", "$end", reply)],
            None,
        )
        .await;
        let end = (list.items.iter())
            .find_map(|item| item.as_event().filter(|event| event.sender() == "@b:b"))
            .unwrap();
        let mut pass = Pass::new(&list.items);
        let shown = item_row(end, &list.ctx(), &mut pass).await;
        assert_eq!(pass.profiles.len(), MAX_PROFILES, "the store reads");
        let name = |user: &str| shown.profiles[user].display_name.as_deref();
        assert_eq!(name("@b:b"), Some("Bob"), "the sender comes first");
        assert_eq!(
            name("@c:b"),
            Some("Cy"),
            "then who it quotes, before any mention"
        );
        let TimelineItemContentDto::Message { mentions, .. } = &shown.content else {
            panic!("{:?}", shown.content);
        };
        assert_eq!(mentions.len(), over);
    }

    #[tokio::test]
    async fn a_member_is_read_once_a_pass_and_named_as_js_names_them() {
        let member = |name: &str| {
            let mut member = state(
                "m.room.member",
                "$member",
                json!({"membership": "join", "displayname": name}),
            );
            member["state_key"] = json!("@b:b");
            member
        };
        let list = listed(vec![member("Bo\u{202e}b")], vec![text("$end")], None).await;
        let rows = list.rows().await;
        assert_eq!(
            rows["$end"]["profiles"]["@b:b"],
            json!({"displayName": "Bob", "displayNameAmbiguous": true, "avatarMxc": null})
        );

        let mut pass = Pass::new(&list.items);
        let known = ProfileDto {
            display_name: Some("from this pass".into()),
            display_name_ambiguous: false,
            avatar_mxc: None,
        };
        pass.profiles.insert("@b:b".into(), Some(known.clone()));
        let end = (list.items.iter())
            .find_map(|item| item.as_event().filter(|event| event.sender() == "@b:b"))
            .unwrap();
        let shown = item_row(end, &list.ctx(), &mut pass).await;
        assert_eq!(shown.profiles["@b:b"], known);
    }
}
