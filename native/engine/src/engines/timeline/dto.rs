//! `TimelineEngine` (`libs/data-access/timeline/src/lib/timeline-engine.ts`): the plain-data shapes
//! a timeline stream sends.

use std::{collections::BTreeMap, fmt};

use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use super::BackPagination;
use crate::{
    engines::room_list::{RoomEncryptionDto, UnencryptedMarkDto},
    vector_diff::VectorDiffDto,
};

pub(super) const DTO: &str = "data-access/timeline/src/lib/rust-dto/";

/// `TimelineUpdate`.
#[derive(Debug, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = DTO)]
pub(super) enum TimelineUpdateDto {
    RoomUnavailable,
    Items {
        // Inlined: the generated file would otherwise import `util/matrix`, across libraries.
        #[ts(inline)]
        diffs: Vec<VectorDiffDto<TimelineItemDto>>,
        back_pagination: BackPagination,
        room: TimelineRoomStateDto,
    },
}

/// `TimelineItem`.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = DTO)]
pub(super) enum TimelineItemDto {
    Event(Box<EventTimelineItemDto>),
    ReadMarker { unique_id: String },
    TimelineStart { unique_id: String },
}

/// `EventTimelineItem` without its `kind`.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct EventTimelineItemDto {
    pub unique_id: String,
    pub event_id: Option<String>,
    pub transaction_id: Option<String>,
    pub sender: String,
    pub is_own: bool,
    // Milliseconds since the epoch, which exceed `u32`.
    pub timestamp: f64,
    pub send_state: Option<SendStateDto>,
    pub content: TimelineItemContentDto,
    pub edited: bool,
    pub in_reply_to: Option<InReplyToDto>,
    pub reactions: Vec<ReactionGroupDto>,
    pub read_by: Vec<String>,
    pub shield: Option<ShieldCodeDto>,
    #[ts(inline)]
    pub unencrypted_mark: Option<UnencryptedMarkDto>,
    pub profiles: BTreeMap<String, ProfileDto>,
}

/// `TimelineRoomState`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct TimelineRoomStateDto {
    #[ts(inline)]
    pub encryption: RoomEncryptionDto,
    pub has_encryption_state_event: bool,
    #[ts(inline)]
    pub tombstone: Option<TombstoneDto>,
    pub latest_confirmed_event_id: Option<String>,
    pub oldest_event_id: Option<String>,
}

impl TimelineRoomStateDto {
    /// What a stream says before it has read the room.
    pub(super) fn unknown() -> Self {
        Self {
            encryption: RoomEncryptionDto::Unknown,
            has_encryption_state_event: false,
            tombstone: None,
            latest_confirmed_event_id: None,
            oldest_event_id: None,
        }
    }
}

/// `TimelineRoomState['tombstone']`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct TombstoneDto {
    pub replacement_room_id: String,
    pub body: String,
}

/// `Profile`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct ProfileDto {
    pub display_name: Option<String>,
    pub display_name_ambiguous: bool,
    pub avatar_mxc: Option<String>,
}

/// `ReactionDetailGroup`.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct ReactionDetailGroupDto {
    pub key: String,
    pub senders: Vec<String>,
    pub profiles: BTreeMap<String, ProfileDto>,
}

/// `SendState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) enum SendStateDto {
    Sending,
    Waiting,
    Failed { recoverable: bool },
}

/// `ShieldCode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct ShieldCodeDto {
    pub colour: ShieldColourDto,
    pub reason: ShieldReasonDto,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub(super) enum ShieldColourDto {
    Red,
    Grey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = DTO)]
pub(super) enum ShieldReasonDto {
    UnverifiedIdentity,
    UnsignedDevice,
    UnknownDevice,
    AuthenticityNotGuaranteed,
    VerificationViolation,
    MismatchedSender,
}

/// `ReactionGroup`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct ReactionGroupDto {
    pub key: String,
    pub count: u32,
    pub reacted_by_me: bool,
    pub senders: Vec<String>,
}

/// `InReplyTo`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct InReplyToDto {
    pub event_id: String,
    pub details: InReplyToDetailsDto,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = DTO)]
pub(super) enum InReplyToDetailsDto {
    Pending,
    Unavailable,
    Ready {
        sender: String,
        body: String,
        redacted: bool,
        #[ts(inline)]
        unencrypted_mark: Option<UnencryptedMarkDto>,
    },
}

/// `TimelineItemContent`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = DTO)]
pub(super) enum TimelineItemContentDto {
    Message {
        msgtype: TextKindDto,
        body: String,
        formatted_body: Option<String>,
        reply_fallback: bool,
        mentions_me: bool,
        mentions: Vec<String>,
    },
    Media {
        msgtype: MediaKindDto,
        source: MediaPayloadDto,
        body: String,
        caption: Option<String>,
        formatted_caption: Option<String>,
        reply_fallback: bool,
        mentions_me: bool,
        mentions: Vec<String>,
    },
    Sticker {
        source: MediaPayloadDto,
        body: Option<String>,
        url: Option<String>,
        #[ts(type = "Record<string, unknown> | null")]
        info: Option<StickerInfoDto>,
    },
    Location {
        lat: f64,
        lng: f64,
        label: String,
    },
    Poll {
        poll: PollViewDto,
    },
    Redacted {
        reply_fallback: bool,
    },
    UnableToDecrypt {
        reason: Option<UndecryptableReasonDto>,
        reply_fallback: bool,
    },
    Unsupported {
        body: String,
        reply_fallback: bool,
    },
    State {
        change: SystemChangeDto,
    },
}

/// A sticker's `info` as sent. Its `Debug` shows none of it: it can hold a thumbnail's file key.
#[derive(Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub(super) struct StickerInfoDto(pub Value);

impl fmt::Debug for StickerInfoDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StickerInfoDto(<redacted>)")
    }
}

/// The `msgtype` of a `message` item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub(super) enum TextKindDto {
    Text,
    Emote,
    Notice,
}

/// `MediaKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub(super) enum MediaKindDto {
    Image,
    File,
    Video,
    Audio,
}

/// `UndecryptableReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = DTO)]
pub(super) enum UndecryptableReasonDto {
    MissingKey,
    DeviceUnverified,
    Withheld,
    HistoryLocked,
    SentBeforeSignIn,
    SentBeforeJoining,
    UnverifiedSenderDevice,
    SenderIdentityChanged,
}

/// `MediaPayload`. Sizes are `f64`, which is what JSON numbers are.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct MediaPayloadDto {
    pub kind: MediaKindDto,
    pub mxc: Option<String>,
    pub file: Option<EncryptedFileInfoDto>,
    pub filename: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duration_ms: Option<f64>,
    pub thumbnail_mxc: Option<String>,
    pub thumbnail_file: Option<EncryptedFileInfoDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thumbnail_mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_voice: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub waveform: Option<Vec<f64>>,
}

/// `EncryptedFileInfo`. Its `Debug` leaves the key out: it must reach no log or fault.
#[derive(Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct EncryptedFileInfoDto {
    pub url: String,
    #[ts(type = "JsonWebKey")]
    pub key: Value,
    pub iv: String,
    pub hashes: BTreeMap<String, String>,
    pub v: String,
}

impl fmt::Debug for EncryptedFileInfoDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EncryptedFileInfoDto")
            .field("key", &"<redacted>")
            .finish_non_exhaustive()
    }
}

/// `PollView`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct PollViewDto {
    pub id: String,
    pub question: String,
    pub options: Vec<PollOptionDto>,
    pub total_votes: u32,
    pub max_selections: u32,
    pub ended: bool,
}

/// `PollOption`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub(super) struct PollOptionDto {
    pub id: String,
    pub text: String,
    pub votes: u32,
    pub chosen: bool,
}

/// `SystemChange`: each kind names its actor by id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = DTO)]
pub(super) enum SystemChangeDto {
    Membership {
        actor_id: String,
        membership: Option<String>,
        previous_membership: Option<String>,
        actor_is_target: bool,
        target_id: String,
        previous_display_name: Option<String>,
        display_name: Option<String>,
        avatar_changed: bool,
        reason: Option<String>,
    },
    RoomName {
        actor_id: String,
        previous_name: Option<String>,
        name: Option<String>,
    },
    RoomTopic {
        actor_id: String,
        previous_topic: Option<String>,
        topic: Option<String>,
    },
    RoomAvatar {
        actor_id: String,
        previous_url: Option<String>,
        url: Option<String>,
    },
    CanonicalAlias {
        actor_id: String,
        previous_alias: Option<String>,
        alias: Option<String>,
    },
    JoinRules {
        actor_id: String,
        previous_rule: Option<String>,
        rule: Option<String>,
    },
    HistoryVisibility {
        actor_id: String,
        previous_visibility: Option<String>,
        visibility: Option<String>,
    },
    GuestAccess {
        actor_id: String,
        previous_access: Option<String>,
        access: Option<String>,
    },
    Encryption {
        actor_id: String,
    },
    Create {
        actor_id: String,
    },
}
