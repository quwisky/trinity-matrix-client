//! `rooms`: the account's joined, invited and knocked rooms, read from the SDK's room store.

use std::{
    collections::{BTreeSet, HashSet},
    future::ready,
    pin::pin,
    sync::Arc,
};

use futures_util::{
    StreamExt,
    stream::{self, PollNext},
};
use matrix_sdk::{
    Room, RoomState, check_validity_of_replacement_events,
    deserialized_responses::{RawSyncOrStrippedState, TimelineEvent},
    latest_events::LatestEventValue,
    ruma::{
        EventId, OwnedDirectUserIdentifier, OwnedRoomId, UserId,
        events::room::{
            encryption::RoomEncryptionEventContent, history_visibility::HistoryVisibility,
        },
    },
};
use matrix_sdk_base::RoomInfoNotableUpdate;
use serde_json::{Value, json};
use tokio::sync::broadcast::{
    self,
    error::{RecvError, TryRecvError},
};

use super::{
    HistoryVisibilityDto, InviterDto, LatestMessageDto, RoomEncryptionDto, RoomInfoDto,
    RoomMembershipDto, UnencryptedMarkDto,
};
use crate::{
    accounts::Engine,
    dispatch::Stream,
    engines::member::account_stream,
    vector_diff::{VectorDiffDto, frames},
};

/// What makes `room_rows` read again.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Trigger {
    Nudge,
    Changed(BTreeSet<OwnedRoomId>),
    Lagged,
}

/// The rooms a read covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    All,
    Rooms(BTreeSet<OwnedRoomId>),
}

/// `[reset]` first; then one item per frame. A change re-reads its rooms; a nudge re-reads all; a
/// lag re-reads all and answers with a fresh `[reset]`. An unchanged row yields nothing.
// shortcut: the first read, a lag and a nudge naming no room re-read every room, each with its
// member lookups; upgrade to a store-wide diff if piece 3 measures them slow beside N1.
pub(crate) fn room_rows<R, F>(
    triggers: impl futures_util::Stream<Item = Trigger>,
    mut read: R,
) -> impl futures_util::Stream<Item = Vec<VectorDiffDto<RoomInfoDto>>>
where
    R: FnMut(Scope) -> F,
    F: Future<Output = Vec<(OwnedRoomId, Option<RoomInfoDto>)>>,
{
    async_stream::stream! {
        let mut triggers = pin!(stream::once(ready(Trigger::Lagged)).chain(triggers));
        let mut rows: Vec<RoomInfoDto> = Vec::new();
        while let Some(trigger) = triggers.next().await {
            let scope = match trigger {
                Trigger::Changed(ids) => Scope::Rooms(ids),
                Trigger::Nudge => Scope::All,
                Trigger::Lagged => {
                    let fetched = read(Scope::All).await;
                    rows = fetched.into_iter().filter_map(|(_, row)| row).collect();
                    yield vec![VectorDiffDto::Reset { values: rows.clone() }];
                    continue;
                }
            };
            let all = matches!(scope, Scope::All);
            let fetched = read(scope).await;
            let mut diffs = Vec::new();
            if all {
                let listed: HashSet<&str> = fetched.iter().map(|(id, _)| id.as_str()).collect();
                let gone: Vec<String> = (rows.iter())
                    .filter(|row| !listed.contains(row.room_id.as_str()))
                    .map(|row| row.room_id.clone())
                    .collect();
                diffs.extend(gone.iter().filter_map(|id| update(&mut rows, id, None)));
            }
            let changed = (fetched.into_iter()).map(|(id, row)| update(&mut rows, id.as_str(), row));
            diffs.extend(changed.flatten());
            for frame in frames(diffs) {
                yield frame;
            }
        }
    }
}

/// Set for a changed row, PushBack for a new one, Remove for one no longer listed; None when equal
/// or absent.
// shortcut: a linear search, so a full re-read is O(N²) in rows; upgrade by indexing the rows by
// room id once piece 3 measures large accounts beside N1.
pub(crate) fn update(
    rows: &mut Vec<RoomInfoDto>,
    room_id: &str,
    row: Option<RoomInfoDto>,
) -> Option<VectorDiffDto<RoomInfoDto>> {
    let at = rows.iter().position(|known| known.room_id == room_id);
    match (at, row) {
        (Some(at), Some(row)) if rows[at] != row => {
            rows[at] = row.clone();
            Some(VectorDiffDto::Set {
                index: saturated(at),
                value: row,
            })
        }
        (Some(at), None) => {
            rows.remove(at);
            Some(VectorDiffDto::Remove {
                index: saturated(at),
            })
        }
        (None, Some(row)) => {
            rows.push(row.clone());
            Some(VectorDiffDto::PushBack { value: row })
        }
        _ => None,
    }
}

pub(crate) fn saturated(n: impl TryInto<u32>) -> u32 {
    n.try_into().unwrap_or(u32::MAX)
}

pub(super) fn membership_of(state: RoomState) -> Option<RoomMembershipDto> {
    match state {
        RoomState::Joined => Some(RoomMembershipDto::Join),
        RoomState::Invited => Some(RoomMembershipDto::Invite),
        RoomState::Knocked => Some(RoomMembershipDto::Knock),
        RoomState::Left | RoomState::Banned => None,
    }
}

fn history_of(v: Option<HistoryVisibility>) -> HistoryVisibilityDto {
    match v {
        Some(HistoryVisibility::Invited) => HistoryVisibilityDto::Invited,
        Some(HistoryVisibility::Joined) => HistoryVisibilityDto::Joined,
        Some(HistoryVisibility::WorldReadable) => HistoryVisibilityDto::WorldReadable,
        _ => HistoryVisibilityDto::Shared,
    }
}

/// The smallest valid user id: the set has no order, and js takes the first in `m.direct`.
fn direct_user_id(targets: &HashSet<OwnedDirectUserIdentifier>) -> Option<String> {
    let users = targets
        .iter()
        .filter_map(OwnedDirectUserIdentifier::as_user_id);
    users.min().map(ToString::to_string)
}

/// `messagePreview`: the reply fallback stripped, whitespace collapsed, `…` when nothing is left.
pub(crate) fn preview(body: Option<&str>, utd: bool, redacted: bool) -> String {
    if utd {
        return "⚠️ Unable to decrypt".to_owned();
    }
    if redacted {
        return "(message deleted)".to_owned();
    }
    // The blank line after the fallback quote collapses with the rest of the whitespace.
    let lines = body.unwrap_or_default().split('\n');
    let words: Vec<_> = (lines.skip_while(|line| line.starts_with('>')))
        .flat_map(str::split_whitespace)
        .collect();
    if words.is_empty() {
        "…".to_owned()
    } else {
        words.join(" ")
    }
}

/// `unencryptedMarkFor`: only a real date before the room's encryption earns the quieter mark.
pub(crate) fn mark(
    room_encrypted: bool,
    in_clear: bool,
    ts: Option<u64>,
    encrypted_at: Option<u64>,
) -> Option<UnencryptedMarkDto> {
    if !room_encrypted || !in_clear {
        return None;
    }
    match (ts, encrypted_at) {
        (Some(ts), Some(at)) if 0 < ts && ts < at => Some(UnencryptedMarkDto::UnencryptedHistory),
        _ => Some(UnencryptedMarkDto::Unencrypted),
    }
}

/// The body to preview: an edit's new content, else the content.
fn body_of(content: &Value) -> Option<&str> {
    let shown = content.get("m.new_content").unwrap_or(content);
    shown.get("body")?.as_str()
}

/// Map §1 "RoomInfo row mapping"; `None` for a room that is not listed.
async fn row(room: &Room) -> Option<RoomInfoDto> {
    let membership = membership_of(room.state())?;
    let direct_user_id = direct_user_id(&room.direct_targets());
    let inviter = match membership {
        RoomMembershipDto::Invite => inviter_of(room).await,
        RoomMembershipDto::Join | RoomMembershipDto::Knock => None,
    };
    // An invite's stripped state holds only two members, so there `is_direct` decides.
    let peer = match &inviter {
        Some(inviter) => inviter.is_direct.then_some(inviter.user_id.as_str()),
        None => direct_user_id.as_deref(),
    };
    let avatar_mxc = avatar_of(room, peer).await;
    let encryption = room.encryption_state();
    let encryption = if encryption.is_encrypted() {
        RoomEncryptionDto::Encrypted
    } else if encryption.is_unknown() {
        RoomEncryptionDto::Unknown
    } else {
        RoomEncryptionDto::Unencrypted
    };
    let latest_message = latest_message_of(room, encryption).await;
    Some(RoomInfoDto {
        room_id: room.room_id().to_string(),
        membership,
        is_space: room.is_space(),
        display_name: (room.cached_display_name())
            .map_or_else(|| room.room_id().to_string(), |name| name.to_string()),
        avatar_mxc,
        topic: room.topic().unwrap_or_default(),
        joined_member_count: saturated(room.joined_members_count()),
        direct_user_id,
        encryption,
        history_visibility: history_of(room.history_visibility()),
        notification_count: saturated(room.num_unread_notifications()),
        highlight_count: saturated(room.num_unread_mentions()),
        marked_unread: room.is_marked_unread(),
        recency_stamp: (room.latest_event_timestamp()).map_or(0.0, |ts| f64::from(ts.get())),
        latest_message,
        favourite: room.is_favourite(),
        low_priority: room.is_low_priority(),
        inviter,
    })
}

/// Our invite's sender, by member name or user id, and its `is_direct`.
async fn inviter_of(room: &Room) -> Option<InviterDto> {
    let invite = room.invite_details().await.ok()?;
    let user_id = invite.inviter_id.to_string();
    let name = (invite.inviter.as_ref())
        .and_then(|member| member.display_name())
        .filter(|name| !name.is_empty());
    Some(InviterDto {
        display_name: name.map_or_else(|| user_id.clone(), str::to_owned),
        user_id,
        is_direct: room.is_direct().await.unwrap_or(false),
    })
}

/// The room's own avatar, else, for a DM, the peer's: its member event, else its hero.
async fn avatar_of(room: &Room, peer: Option<&str>) -> Option<String> {
    if let Some(url) = room.avatar_url() {
        return Some(url.to_string());
    }
    let peer = <&UserId>::try_from(peer?).ok()?;
    let member = room.get_member_no_sync(peer).await.ok().flatten();
    if let Some(url) = member.as_ref().and_then(|member| member.avatar_url()) {
        return Some(url.to_string());
    }
    let mut heroes = room.heroes().await.into_iter();
    let hero = heroes.find(|hero| hero.user_id == peer)?;
    hero.avatar_url.map(|url| url.to_string())
}

/// How the latest event reached the device.
#[derive(Clone, Copy, Debug)]
enum Origin {
    /// The account's own message, still being sent.
    Local,
    Remote {
        utd: bool,
        encrypted: bool,
        ts: Option<u64>,
    },
}

/// `latestMessage` for the latest event's JSON (O5, adjustment 9). `encrypted_at` is the room's
/// `m.room.encryption` date, which only a clear message in an encrypted room reads.
fn latest_message(
    event: &Value,
    origin: Origin,
    room: RoomEncryptionDto,
    encrypted_at: Option<u64>,
) -> Option<LatestMessageDto> {
    let utd = matches!(origin, Origin::Remote { utd: true, .. });
    if !utd && event["type"] != "m.room.message" {
        return None;
    }
    let Origin::Remote { encrypted, ts, .. } = origin else {
        return Some(LatestMessageDto {
            text: preview(body_of(&event["content"]), false, false),
            mark: None,
        });
    };
    let redacted = event["unsigned"].get("redacted_because").is_some();
    let in_clear = !utd && !redacted && !encrypted;
    if in_clear && room == RoomEncryptionDto::Unknown {
        // Held back until the room is known not to be encrypted.
        return Some(LatestMessageDto {
            text: String::new(),
            mark: None,
        });
    }
    let room_encrypted = room == RoomEncryptionDto::Encrypted;
    Some(LatestMessageDto {
        text: preview(body_of(&event["content"]), utd, redacted),
        mark: mark(room_encrypted, in_clear, ts, encrypted_at),
    })
}

/// `edit` may replace `target`. The SDK checked this before it picked the edit, but with the
/// target's encryption info in place of the edit's, so a clear edit of an encrypted message passes.
fn is_valid_edit(target: Option<&TimelineEvent>, edit: &TimelineEvent) -> bool {
    target.is_some_and(|target| {
        check_validity_of_replacement_events(
            target.raw(),
            target.encryption_info().map(Arc::as_ref),
            edit.raw(),
            edit.encryption_info().map(Arc::as_ref),
        )
        .is_ok()
    })
}

/// Whether the latest event's `m.new_content` may show. Any event can carry the field; only a valid
/// edit of a target still loaded replaces anything.
async fn shows_new_content(room: &Room, event: &TimelineEvent, json: &Value) -> bool {
    let relation = &json["content"]["m.relates_to"];
    if relation["rel_type"] != "m.replace" {
        return false;
    }
    let Some(target) = relation["event_id"].as_str() else {
        return false;
    };
    let (Ok(target), Ok((cache, _handles))) = (EventId::parse(target), room.event_cache().await)
    else {
        return false;
    };
    let target = cache.find_event(&target).await.ok().flatten();
    is_valid_edit(target.as_ref(), event)
}

/// `latestMessage` from the SDK's latest event.
async fn latest_message_of(room: &Room, encryption: RoomEncryptionDto) -> Option<LatestMessageDto> {
    let (event, origin) = match room.latest_event() {
        LatestEventValue::Remote(event) => {
            let origin = Origin::Remote {
                utd: event.kind.is_utd(),
                encrypted: event.encryption_info().is_some(),
                ts: event.timestamp().map(|ts| u64::from(ts.get())),
            };
            let mut json = event.raw().deserialize_as::<Value>().ok()?;
            if !shows_new_content(room, &event, &json).await
                && let Some(content) = json.get_mut("content").and_then(Value::as_object_mut)
            {
                content.remove("m.new_content");
            }
            (json, origin)
        }
        LatestEventValue::LocalIsSending(local)
        | LatestEventValue::LocalCannotBeSent(local)
        | LatestEventValue::LocalHasBeenSent { value: local, .. } => {
            let (content, event_type) = local.content.raw();
            let content = content.deserialize_as::<Value>().ok()?;
            let event = json!({"type": event_type, "content": content});
            (event, Origin::Local)
        }
        LatestEventValue::None | LatestEventValue::RemoteInvite { .. } => return None,
    };
    let encrypted_at = match origin {
        Origin::Remote {
            utd: false,
            encrypted: false,
            ..
        } if encryption == RoomEncryptionDto::Encrypted => encrypted_at(room).await,
        _ => None,
    };
    latest_message(&event, origin, encryption, encrypted_at)
}

/// The `origin_server_ts` of the room's `m.room.encryption` event.
pub(crate) async fn encrypted_at(room: &Room) -> Option<u64> {
    let event = room.get_state_event_static::<RoomEncryptionEventContent>();
    match event.await.ok()?? {
        RawSyncOrStrippedState::Sync(raw) => raw.get_field("origin_server_ts").ok()?,
        RawSyncOrStrippedState::Stripped(_) => None,
    }
}

/// A command's nudge re-reads the room it names, or every room, and goes before the notable
/// updates because the command waits for it.
fn triggers(
    nudges: impl futures_util::Stream<Item = Option<OwnedRoomId>>,
    changes: impl futures_util::Stream<Item = Trigger>,
) -> impl futures_util::Stream<Item = Trigger> {
    let nudges = nudges.map(|room| match room {
        Some(id) => Trigger::Changed(BTreeSet::from([id])),
        None => Trigger::Nudge,
    });
    stream::select_with_strategy(nudges, changes, |(): &mut ()| PollNext::Left)
}

/// One `Changed` per wake with every update already queued, so one sync gives one batch.
fn changes(
    mut updates: broadcast::Receiver<RoomInfoNotableUpdate>,
) -> impl futures_util::Stream<Item = Trigger> {
    async_stream::stream! {
        loop {
            let first = match updates.recv().await {
                Ok(update) => update.room_id,
                Err(RecvError::Lagged(_)) => {
                    yield Trigger::Lagged;
                    continue;
                }
                Err(RecvError::Closed) => return,
            };
            let mut changed = BTreeSet::from([first]);
            let lagged = loop {
                match updates.try_recv() {
                    Ok(update) => {
                        changed.insert(update.room_id);
                    }
                    Err(TryRecvError::Lagged(_)) => break true,
                    Err(TryRecvError::Empty | TryRecvError::Closed) => break false,
                }
            };
            yield if lagged { Trigger::Lagged } else { Trigger::Changed(changed) };
        }
    }
}

/// `RoomListEngine.rooms`. Not live: `[reset []]`.
pub fn rooms(engine: Arc<Engine>, account_id: String) -> Stream {
    let empty = vec![VectorDiffDto::<RoomInfoDto>::Reset { values: Vec::new() }];
    account_stream(engine, account_id, empty, |rt, client| {
        let changes = changes(client.room_info_notable_update_receiver());
        let mut registered = HashSet::new();
        room_rows(triggers(rt.nudged(), changes), move |scope| {
            let rooms: Vec<(OwnedRoomId, Option<Room>)> = match scope {
                Scope::All => (client.rooms().into_iter())
                    .map(|room| (room.room_id().to_owned(), Some(room)))
                    .collect(),
                Scope::Rooms(ids) => (ids.into_iter())
                    .map(|id| {
                        let room = client.get_room(&id);
                        (id, room)
                    })
                    .collect(),
            };
            let fresh: Vec<OwnedRoomId> = (rooms.iter())
                .filter(|(id, room)| {
                    let shown = room.as_ref().and_then(|room| membership_of(room.state()));
                    shown.is_some() && registered.insert(id.clone())
                })
                .map(|(id, _)| id.clone())
                .collect();
            let client = client.clone();
            async move {
                // Sliding sync registers them too; this covers a room it has not reached yet.
                if !fresh.is_empty() {
                    let latest = client.latest_events().await;
                    for id in &fresh {
                        if latest.listen_to_room(id).await.is_err() {
                            tracing::warn!("listening for a room's latest event failed");
                        }
                    }
                }
                let mut rows = Vec::with_capacity(rooms.len());
                for (id, room) in rooms {
                    let row = match &room {
                        Some(room) => row(room).await,
                        None => None,
                    };
                    rows.push((id, row));
                }
                rows
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use std::{
        cell::RefCell,
        collections::BTreeMap,
        future::{Ready, ready},
        pin::pin,
        rc::Rc,
        time::Duration,
    };

    use futures_util::{FutureExt, StreamExt};
    use matrix_sdk::{
        deserialized_responses::{
            AlgorithmInfo, DecryptedRoomEvent, DeviceLinkProblem, EncryptionInfo,
            VerificationLevel, VerificationState,
        },
        ruma::serde::Raw,
        sleep::sleep,
        timeout::timeout,
    };
    use serde_json::json;
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    use matrix_sdk_base::RoomInfoNotableUpdateReasons;

    use super::*;
    use crate::{
        config::EngineConfig,
        engines::room_list::RoomEncryptionDto,
        testing::{default_client, engine_in, live, password, scripted, sync, sync_answer},
    };

    fn id(room_id: &str) -> OwnedRoomId {
        OwnedRoomId::try_from(room_id).unwrap()
    }

    fn info(room_id: &str, name: &str) -> RoomInfoDto {
        RoomInfoDto {
            room_id: room_id.into(),
            membership: RoomMembershipDto::Join,
            is_space: false,
            display_name: name.into(),
            avatar_mxc: None,
            topic: String::new(),
            joined_member_count: 1,
            direct_user_id: None,
            encryption: RoomEncryptionDto::Unknown,
            history_visibility: HistoryVisibilityDto::Shared,
            notification_count: 0,
            highlight_count: 0,
            marked_unread: false,
            recency_stamp: 0.0,
            latest_message: None,
            favourite: false,
            low_priority: false,
            inviter: None,
        }
    }

    /// Items fed by hand.
    fn feed<T>() -> (
        mpsc::UnboundedSender<T>,
        impl futures_util::Stream<Item = T>,
    ) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        (tx, stream::poll_fn(move |cx| rx.poll_recv(cx)))
    }

    type Store = Rc<RefCell<BTreeMap<String, RoomInfoDto>>>;

    fn store(rows: &[RoomInfoDto]) -> Store {
        let rows = rows.iter().map(|row| (row.room_id.clone(), row.clone()));
        Rc::new(RefCell::new(rows.collect()))
    }

    /// A read from `store`: every room it holds, or the named ones, unlisted when it lacks them.
    fn read_from(
        store: &Store,
    ) -> impl FnMut(Scope) -> Ready<Vec<(OwnedRoomId, Option<RoomInfoDto>)>> + use<> {
        let store = Rc::clone(store);
        move |scope| {
            let store = store.borrow();
            ready(match scope {
                Scope::All => (store.values())
                    .map(|row| (id(&row.room_id), Some(row.clone())))
                    .collect(),
                Scope::Rooms(ids) => (ids.into_iter())
                    .map(|room_id| {
                        let row = store.get(room_id.as_str()).cloned();
                        (room_id, row)
                    })
                    .collect(),
            })
        }
    }

    #[test]
    fn update_sets_pushes_and_removes_by_room_id() {
        let mut rows = vec![info("!a:x", "A")];
        let b = info("!b:x", "B");
        let pushed = VectorDiffDto::PushBack { value: b.clone() };
        assert_eq!(update(&mut rows, "!b:x", Some(b)), Some(pushed));
        let renamed = info("!b:x", "B2");
        let set = VectorDiffDto::Set {
            index: 1,
            value: renamed.clone(),
        };
        assert_eq!(update(&mut rows, "!b:x", Some(renamed.clone())), Some(set));
        let removed = VectorDiffDto::Remove { index: 0 };
        assert_eq!(update(&mut rows, "!a:x", None), Some(removed));
        assert_eq!(rows, [renamed]);
        assert_eq!(update(&mut rows, "!a:x", None), None, "already gone");
    }

    #[test]
    fn update_yields_nothing_for_an_equal_row() {
        let mut rows = vec![info("!a:x", "A")];
        assert_eq!(update(&mut rows, "!a:x", Some(info("!a:x", "A"))), None);
        assert_eq!(rows, [info("!a:x", "A")]);
    }

    #[tokio::test]
    async fn room_rows_reset_first_then_diff_only_what_changed() {
        let (a, b) = (info("!a:x", "A"), info("!b:x", "B"));
        let store = store(&[a.clone(), b]);
        let (trigger, triggers) = feed();
        let mut rows = pin!(room_rows(triggers, read_from(&store)));
        let reset = VectorDiffDto::Reset {
            values: vec![a, info("!b:x", "B")],
        };
        assert_eq!(rows.next().await, Some(vec![reset]));
        let renamed = info("!b:x", "B2");
        store.borrow_mut().insert("!b:x".into(), renamed.clone());
        trigger.send(Trigger::Changed([id("!b:x")].into())).unwrap();
        let set = VectorDiffDto::Set {
            index: 1,
            value: renamed,
        };
        assert_eq!(rows.next().await, Some(vec![set]));
        trigger.send(Trigger::Changed([id("!a:x")].into())).unwrap();
        assert!(rows.next().now_or_never().is_none(), "a is unchanged");
    }

    #[tokio::test]
    async fn a_nudge_rereads_every_room_and_drops_an_unlisted_one() {
        let store = store(&[info("!a:x", "A"), info("!b:x", "B")]);
        let (trigger, triggers) = feed();
        let mut rows = pin!(room_rows(triggers, read_from(&store)));
        rows.next().await;
        store.borrow_mut().remove("!a:x");
        let c = info("!c:x", "C");
        store.borrow_mut().insert("!c:x".into(), c.clone());
        trigger.send(Trigger::Nudge).unwrap();
        let diffs = vec![
            VectorDiffDto::Remove { index: 0 },
            VectorDiffDto::PushBack { value: c },
        ];
        assert_eq!(rows.next().await, Some(diffs));
    }

    #[tokio::test]
    async fn a_nudge_naming_a_room_rereads_only_that_room() {
        let store = store(&[info("!a:x", "A"), info("!b:x", "B")]);
        let scopes = Rc::new(RefCell::new(Vec::new()));
        let (seen, mut read) = (Rc::clone(&scopes), read_from(&store));
        let (nudge, nudges) = feed();
        let triggers = triggers(nudges, stream::pending());
        let mut rows = pin!(room_rows(triggers, move |scope: Scope| {
            seen.borrow_mut().push(scope.clone());
            read(scope)
        }));
        rows.next().await;
        let renamed = info("!b:x", "B2");
        store.borrow_mut().insert("!b:x".into(), renamed.clone());
        nudge.send(Some(id("!b:x"))).unwrap();
        let set = VectorDiffDto::Set {
            index: 1,
            value: renamed,
        };
        assert_eq!(rows.next().await, Some(vec![set]));
        nudge.send(None).unwrap();
        assert!(rows.next().now_or_never().is_none(), "nothing changed");
        let b = Scope::Rooms([id("!b:x")].into());
        assert_eq!(*scopes.borrow(), [Scope::All, b, Scope::All]);
    }

    #[tokio::test]
    async fn changes_fold_queued_updates_and_survive_a_lag() {
        let touched = |room: &str| RoomInfoNotableUpdate {
            room_id: id(room),
            reasons: RoomInfoNotableUpdateReasons::NONE,
        };
        let (tx, rx) = broadcast::channel(2);
        let mut changes = pin!(changes(rx));
        for room in ["!a:x", "!b:x"] {
            tx.send(touched(room)).unwrap();
        }
        let both = Trigger::Changed([id("!a:x"), id("!b:x")].into());
        assert_eq!(changes.next().await, Some(both));
        for room in ["!a:x", "!b:x", "!c:x"] {
            tx.send(touched(room)).unwrap();
        }
        assert_eq!(changes.next().await, Some(Trigger::Lagged));
        let kept = Trigger::Changed([id("!b:x"), id("!c:x")].into());
        assert_eq!(changes.next().await, Some(kept), "the stream stays open");
    }

    #[test]
    fn latest_message_matches_js() {
        use RoomEncryptionDto::{Encrypted, Unencrypted, Unknown};
        let message = |content: Value| json!({"type": "m.room.message", "content": content});
        let remote = Origin::Remote {
            utd: false,
            encrypted: false,
            ts: Some(5),
        };
        let shown = |text: &str, mark| {
            Some(LatestMessageDto {
                text: text.into(),
                mark,
            })
        };
        let edit = message(json!({"body": "* new", "m.new_content": {"body": "new"}}));
        let plain = message(json!({"body": "hi"}));
        let topic = json!({"type": "m.room.topic", "content": {"topic": "t"}});
        let redacted =
            json!({"type": "m.room.message", "content": {}, "unsigned": {"redacted_because": {}}});
        let utd = Origin::Remote {
            utd: true,
            encrypted: false,
            ts: Some(5),
        };
        let history = Some(UnencryptedMarkDto::UnencryptedHistory);
        let cases = [
            (&edit, remote, Unencrypted, None, shown("new", None)),
            (&plain, remote, Unknown, None, shown("", None)),
            (&plain, Origin::Local, Encrypted, None, shown("hi", None)),
            (&plain, remote, Encrypted, Some(10), shown("hi", history)),
            (&topic, remote, Unencrypted, None, None),
            (&topic, Origin::Local, Unencrypted, None, None),
            (
                &redacted,
                remote,
                Unknown,
                None,
                shown("(message deleted)", None),
            ),
            (
                &topic,
                utd,
                Encrypted,
                None,
                shown("⚠️ Unable to decrypt", None),
            ),
        ];
        for (event, origin, room, encrypted_at, expected) in cases {
            let got = latest_message(event, origin, room, encrypted_at);
            assert_eq!(got, expected, "{event} {origin:?} {room:?}");
        }
    }

    /// `row`'s text once the SDK has picked a latest event from a sync of `events`.
    async fn latest_text(events: Vec<Value>) -> String {
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let room_id = "!r:b";
        let joined = json!({"rooms": {"join": {room_id: {
            "timeline": {"events": events},
            "state_after": {"events": [{
                "type": "m.room.encryption", "state_key": "", "event_id": "$e", "sender": "@b:b",
                "origin_server_ts": 1, "content": {"algorithm": "m.megolm.v1.aes-sha2"},
            }]},
        }}}});
        let (base, _seen) = scripted(vec![sync_answer(0, joined)]);
        let account = password(&base);
        let client = default_client(&engine, &account).await;
        let rt = live(&engine, &account, client).await;
        let id = id(room_id);
        let latest = rt.client.latest_events().await;
        sync(&rt.client).await;
        latest.listen_to_room(&id).await.unwrap();
        let room = rt.client.get_room(&id).unwrap();
        let picked = async {
            while matches!(room.latest_event(), LatestEventValue::None) {
                sleep(Duration::from_millis(5)).await;
            }
        };
        timeout(picked, Duration::from_secs(5)).await.unwrap();
        row(&room).await.unwrap().latest_message.unwrap().text
    }

    fn message_from(id: &str, sender: &str, content: Value) -> Value {
        json!({"type": "m.room.message", "event_id": id, "sender": sender,
            "origin_server_ts": 1, "content": content})
    }

    fn edit_of(target: &str) -> Value {
        json!({"msgtype": "m.text", "body": "* new",
            "m.new_content": {"msgtype": "m.text", "body": "new"},
            "m.relates_to": {"rel_type": "m.replace", "event_id": target}})
    }

    fn original() -> Value {
        message_from("$o", "@b:b", json!({"msgtype": "m.text", "body": "old"}))
    }

    #[tokio::test]
    async fn an_invalid_edit_keeps_its_targets_preview() {
        let edit = message_from("$edit", "@c:b", edit_of("$o"));
        assert_eq!(latest_text(vec![original(), edit]).await, "old");
    }

    #[tokio::test]
    async fn an_own_edit_previews_its_new_text() {
        let edit = message_from("$edit", "@b:b", edit_of("$o"));
        assert_eq!(latest_text(vec![original(), edit]).await, "new");
    }

    #[tokio::test]
    async fn new_content_on_what_is_no_edit_is_not_shown() {
        let hidden = json!({"msgtype": "m.text", "body": "hidden"});
        let plain = json!({"msgtype": "m.text", "body": "seen", "m.new_content": hidden});
        let relation = |relation: Value| {
            let mut content = plain.clone();
            content["m.relates_to"] = relation;
            content
        };
        let contents = [
            plain.clone(),
            relation(json!({"rel_type": "m.thread", "event_id": "$o"})),
            relation(json!({"m.in_reply_to": {"event_id": "$o"}})),
            relation(json!({"rel_type": "m.replace"})),
            relation(json!({"rel_type": "m.replace", "event_id": "not an id"})),
        ];
        for content in contents {
            let hostile = message_from("$m", "@b:b", content.clone());
            let text = latest_text(vec![original(), hostile]).await;
            assert_eq!(text, "seen", "{content}");
        }
        let elsewhere = message_from("$edit", "@b:b", edit_of("$not-loaded"));
        let text = latest_text(vec![original(), elsewhere]).await;
        assert_eq!(
            text, "old",
            "the SDK passes over an edit of what it can't see"
        );
    }

    fn sync_event(json: Value) -> TimelineEvent {
        TimelineEvent::from_plaintext(Raw::from_json(
            serde_json::value::to_raw_value(&json).unwrap(),
        ))
    }

    fn decrypted(json: Value) -> TimelineEvent {
        let info = EncryptionInfo {
            sender: "@b:b".try_into().unwrap(),
            sender_device: None,
            forwarder: None,
            algorithm_info: AlgorithmInfo::MegolmV1AesSha2 {
                curve25519_key: "k".to_owned(),
                sender_claimed_keys: BTreeMap::new(),
                session_id: None,
            },
            verification_state: VerificationState::Unverified(VerificationLevel::None(
                DeviceLinkProblem::MissingDevice,
            )),
        };
        TimelineEvent::from_decrypted(
            DecryptedRoomEvent {
                event: Raw::from_json(serde_json::value::to_raw_value(&json).unwrap()),
                encryption_info: Arc::new(info),
                unsigned_encryption_info: None,
            },
            None,
        )
    }

    #[test]
    fn an_edit_needs_a_loaded_target_and_as_much_encryption() {
        let edit = message_from("$edit", "@b:b", edit_of("$o"));
        let mallory = message_from("$edit", "@c:b", edit_of("$o"));
        let (clear, secret) = (sync_event(original()), decrypted(original()));
        assert!(
            !is_valid_edit(None, &sync_event(edit.clone())),
            "not loaded"
        );
        assert!(is_valid_edit(Some(&clear), &sync_event(edit.clone())));
        assert!(is_valid_edit(Some(&secret), &decrypted(edit.clone())));
        assert!(!is_valid_edit(Some(&secret), &sync_event(edit)), "in clear");
        assert!(
            !is_valid_edit(Some(&clear), &sync_event(mallory)),
            "not the sender"
        );
    }

    #[tokio::test]
    async fn a_lag_answers_with_a_fresh_reset() {
        let a = info("!a:x", "A");
        let store = store(std::slice::from_ref(&a));
        let (trigger, triggers) = feed();
        let mut rows = pin!(room_rows(triggers, read_from(&store)));
        rows.next().await;
        let b = info("!b:x", "B");
        store.borrow_mut().insert("!b:x".into(), b.clone());
        trigger.send(Trigger::Lagged).unwrap();
        let reset = VectorDiffDto::Reset { values: vec![a, b] };
        assert_eq!(rows.next().await, Some(vec![reset]));
    }

    #[test]
    fn rows_map_membership_history_and_the_dm_peer() {
        assert_eq!(
            membership_of(RoomState::Joined),
            Some(RoomMembershipDto::Join)
        );
        assert_eq!(
            membership_of(RoomState::Invited),
            Some(RoomMembershipDto::Invite)
        );
        assert_eq!(
            membership_of(RoomState::Knocked),
            Some(RoomMembershipDto::Knock)
        );
        assert_eq!(membership_of(RoomState::Left), None, "not listed");
        assert_eq!(membership_of(RoomState::Banned), None, "not listed");
        assert_eq!(history_of(None), HistoryVisibilityDto::Shared);
        assert_eq!(
            history_of(Some(HistoryVisibility::WorldReadable)),
            HistoryVisibilityDto::WorldReadable
        );
        let targets = ["@b:x", "@a:x", "not-a-user"].map(OwnedDirectUserIdentifier::from);
        assert_eq!(direct_user_id(&targets.into()).as_deref(), Some("@a:x"));
        assert_eq!(direct_user_id(&HashSet::new()), None);
    }

    #[test]
    fn preview_matches_js() {
        let body = Some("> quote\n\nhi  there\n");
        assert_eq!(preview(body, false, false), "hi there");
        assert_eq!(preview(Some(""), false, false), "…");
        assert_eq!(preview(None, true, false), "⚠️ Unable to decrypt");
        assert_eq!(preview(Some("x"), false, true), "(message deleted)");
    }

    #[test]
    fn mark_matches_js() {
        use UnencryptedMarkDto::{Unencrypted, UnencryptedHistory};
        assert_eq!(mark(false, true, Some(5), Some(10)), None);
        assert_eq!(mark(true, false, Some(5), Some(10)), None);
        assert_eq!(
            mark(true, true, Some(5), Some(10)),
            Some(UnencryptedHistory)
        );
        assert_eq!(mark(true, true, Some(15), Some(10)), Some(Unencrypted));
        assert_eq!(mark(true, true, Some(0), Some(10)), Some(Unencrypted));
        assert_eq!(mark(true, true, Some(5), None), Some(Unencrypted));
    }

    #[tokio::test]
    async fn rooms_on_an_account_that_is_not_live_emit_an_empty_reset() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let mut items = rooms(engine, "@x:y".into());
        let empty = json!([{"op": "reset", "values": []}]);
        assert_eq!(items.next().await, Some(Ok(empty)));
        assert!(
            items.next().now_or_never().is_none(),
            "the stream stays open"
        );
    }
}
