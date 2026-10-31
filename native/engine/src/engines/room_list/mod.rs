//! `RoomListEngine` (`libs/data-access/room-library/src/lib/room-list-engine.ts`): the plain-data
//! shapes it sends and receives.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

const DTO: &str = "data-access/room-library/src/lib/rust-dto/";

/// `RoomInfo`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct RoomInfoDto {
    pub room_id: String,
    pub membership: RoomMembershipDto,
    pub is_space: bool,
    pub display_name: String,
    pub avatar_mxc: Option<String>,
    pub topic: String,
    pub joined_member_count: u32,
    pub direct_user_id: Option<String>,
    pub encryption: RoomEncryptionDto,
    pub history_visibility: HistoryVisibilityDto,
    pub notification_count: u32,
    pub highlight_count: u32,
    pub marked_unread: bool,
    // Milliseconds since the epoch, which exceed `u32`.
    pub recency_stamp: f64,
    #[ts(inline)]
    pub latest_message: Option<LatestMessageDto>,
    pub favourite: bool,
    pub low_priority: bool,
    #[ts(inline)]
    pub inviter: Option<InviterDto>,
}

/// `RoomInfo['latestMessage']`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LatestMessageDto {
    pub text: String,
    #[ts(inline)]
    pub mark: Option<UnencryptedMarkDto>,
}

/// `UnencryptedMark`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum UnencryptedMarkDto {
    Unencrypted,
    UnencryptedHistory,
}

/// `RoomInfo['inviter']`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InviterDto {
    pub user_id: String,
    pub display_name: String,
    pub is_direct: bool,
}

/// `RoomMembership`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum RoomMembershipDto {
    Join,
    Invite,
    Knock,
}

/// `RoomInfo['encryption']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum RoomEncryptionDto {
    Encrypted,
    Unencrypted,
    Unknown,
}

/// `RoomInfo['historyVisibility']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = DTO)]
pub enum HistoryVisibilityDto {
    Invited,
    Joined,
    Shared,
    WorldReadable,
}

/// `TypingMember`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct TypingMemberDto {
    pub user_id: String,
    pub display_name: String,
}

/// The typing members of each room, by room id.
// A newtype serialises as its inner map without `#[serde(transparent)]`, which ts-rs warns it
// cannot parse.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = DTO)]
pub struct TypingMapDto(pub BTreeMap<String, Vec<TypingMemberDto>>);

/// The other users' direct rooms, by user id.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = DTO)]
pub struct DirectMapDto(pub BTreeMap<String, Vec<String>>);

/// `SpaceChildLink`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct SpaceChildLinkDto {
    pub child_id: String,
    pub via: Vec<String>,
    pub suggested: bool,
    pub order: String,
}

/// `HierarchyEntry`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct HierarchyEntryDto {
    pub room_id: String,
    pub name: Option<String>,
    pub canonical_alias: Option<String>,
    pub topic: Option<String>,
    pub avatar_mxc: Option<String>,
    pub joined_member_count: u32,
    pub join_rule: Option<String>,
    pub is_space: bool,
    pub children_state: Vec<SpaceChildLinkDto>,
}

/// `InviteBlocking`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct InviteBlockingDto {
    pub supported: bool,
    pub blocked: bool,
}

/// `{ roomId }`, what `createRoom`, `createDirectMessage`, `resolveAlias` and `join` answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct RoomIdDto {
    pub room_id: String,
}

/// `CreateRoomRequest`.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct CreateRoomRequestDto {
    pub name: String,
    pub topic: Option<String>,
    pub is_public: bool,
    pub kind: RoomKindDto,
    pub parent_space_id: Option<String>,
}

/// `CreateRoomRequest['kind']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum RoomKindDto {
    Room,
    Space,
}

/// The `tag` of `setTag`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub enum RoomTagDto {
    Favourite,
    LowPriority,
}

/// The `receipts` of `markRead`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum ReceiptsDto {
    Public,
    Private,
}

/// `Omit<SpaceChildLink, 'childId'>`, the `link` of `setSpaceChild`.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct SpaceChildLinkInputDto {
    pub via: Vec<String>,
    pub suggested: bool,
    pub order: String,
}

/// The `options` of `spaceHierarchy`.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct HierarchyOptionsDto {
    pub max_pages: Option<u32>,
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn to_json(value: impl serde::Serialize) -> Value {
        serde_json::to_value(value).unwrap()
    }

    #[test]
    fn room_info_serialises_like_the_typescript_row() {
        let row = RoomInfoDto {
            room_id: "!a:x".into(),
            membership: RoomMembershipDto::Join,
            is_space: false,
            display_name: "A".into(),
            avatar_mxc: None,
            topic: String::new(),
            joined_member_count: 2,
            direct_user_id: None,
            encryption: RoomEncryptionDto::Encrypted,
            history_visibility: HistoryVisibilityDto::WorldReadable,
            notification_count: 1,
            highlight_count: 0,
            marked_unread: false,
            recency_stamp: 5.0,
            latest_message: Some(LatestMessageDto {
                text: "hi".into(),
                mark: Some(UnencryptedMarkDto::UnencryptedHistory),
            }),
            favourite: false,
            low_priority: true,
            inviter: None,
        };
        assert_eq!(
            to_json(row),
            json!({
                "roomId": "!a:x",
                "membership": "join",
                "isSpace": false,
                "displayName": "A",
                "avatarMxc": null,
                "topic": "",
                "joinedMemberCount": 2,
                "directUserId": null,
                "encryption": "encrypted",
                "historyVisibility": "world_readable",
                "notificationCount": 1,
                "highlightCount": 0,
                "markedUnread": false,
                "recencyStamp": 5.0,
                "latestMessage": {"text": "hi", "mark": "unencrypted-history"},
                "favourite": false,
                "lowPriority": true,
                "inviter": null,
            })
        );
    }

    #[test]
    fn the_maps_serialise_as_bare_objects() {
        let typing = TypingMapDto(BTreeMap::from([(
            "!a:x".to_owned(),
            vec![TypingMemberDto {
                user_id: "@b:x".into(),
                display_name: "B".into(),
            }],
        )]));
        assert_eq!(
            to_json(typing),
            json!({"!a:x": [{"userId": "@b:x", "displayName": "B"}]})
        );
        let direct = DirectMapDto(BTreeMap::from([(
            "@b:x".to_owned(),
            vec!["!a:x".to_owned()],
        )]));
        assert_eq!(to_json(direct), json!({"@b:x": ["!a:x"]}));
        assert_eq!(to_json(TypingMapDto::default()), json!({}));
    }

    #[test]
    fn inputs_decode_from_the_typescript_shapes() {
        let request: CreateRoomRequestDto = serde_json::from_value(json!({
            "name": "x",
            "topic": null,
            "isPublic": false,
            "kind": "room",
            "parentSpaceId": null,
        }))
        .unwrap();
        assert_eq!(request.name, "x");
        assert_eq!(request.topic, None);
        assert!(!request.is_public);
        assert_eq!(request.kind, RoomKindDto::Room);
        assert_eq!(request.parent_space_id, None);
        assert_eq!(
            serde_json::from_value::<RoomTagDto>(json!("lowPriority")).unwrap(),
            RoomTagDto::LowPriority
        );
        assert_eq!(
            serde_json::from_value::<ReceiptsDto>(json!("private")).unwrap(),
            ReceiptsDto::Private
        );
        let link: SpaceChildLinkInputDto =
            serde_json::from_value(json!({"via": ["b"], "suggested": true, "order": "m"})).unwrap();
        assert_eq!(link.via, ["b"]);
        assert!(link.suggested);
        assert_eq!(link.order, "m");
        let options: HierarchyOptionsDto =
            serde_json::from_value(json!({"maxPages": null})).unwrap();
        assert_eq!(options.max_pages, None);
    }
}
