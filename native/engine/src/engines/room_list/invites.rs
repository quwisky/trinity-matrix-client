//! Invite blocking (MSC4380) and rooms in common (MSC2666). The js plans are
//! `js-sdk/invite-permission.ts` and `js-sdk/mutual-rooms.ts`.

use std::{
    collections::BTreeSet,
    future::{Future, poll_fn},
    pin::pin,
    sync::Arc,
    task::Poll,
    time::Duration,
};

use futures_util::{
    Stream, StreamExt,
    stream::{self, select},
};
use matrix_sdk::{
    BoxFuture, Client, Error, RoomState,
    event_handler::EventHandlerDropGuard,
    ruma::{
        OwnedRoomId, RoomId, UserId,
        api::{
            FeatureFlag, MatrixVersion, SupportedVersions,
            client::membership::get_mutual_rooms::{unstable, v1},
        },
        events::{
            GlobalAccountDataEventType,
            room::member::{MembershipState, SyncRoomMemberEvent},
        },
    },
    sleep::sleep,
    timeout::timeout,
};
use matrix_sdk_base::RoomInfoNotableUpdate;
use serde_json::{Value, json};
use tokio::sync::{
    broadcast::{self, error::RecvError},
    mpsc,
};

use super::InviteBlockingDto;
use crate::{
    accounts::Engine,
    dispatch::{Stream as EngineStream, reply},
    engines::{
        account_data,
        member::{account_stream, bounded, on_account, sent_once},
        settle::{account_data_changes, settle},
    },
    failure::request_failed,
};

pub(crate) const ANSWER_LIMIT: Duration = Duration::from_secs(10);
pub(crate) const REFETCH_DELAY: Duration = Duration::from_secs(1);
pub(crate) const MAX_PAGES: usize = 10;

const STABLE_TYPE: &str = "m.invite_permission_config";
const UNSTABLE_TYPE: &str = "org.matrix.msc4380.invite_permission_config";
const NOT_SUPPORTED: InviteBlockingDto = InviteBlockingDto {
    supported: false,
    blocked: false,
};

/// Which of the two account-data types the server honours.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Support {
    pub stable: bool,
    pub unstable: bool,
}

/// stable: v1.18+ or `org.matrix.msc4380.stable`; unstable: `org.matrix.msc4380`.
pub(crate) fn blocking_support(v: &SupportedVersions) -> Support {
    Support {
        stable: v.versions.iter().any(|v| *v >= MatrixVersion::V1_18)
            || v.features.contains(&"org.matrix.msc4380.stable".into()),
        unstable: v.features.contains(&FeatureFlag::Msc4380),
    }
}

fn blocks(content: Option<&Value>) -> bool {
    let action = content.and_then(|content| content.get("default_action"));
    action.and_then(Value::as_str) == Some("block")
}

/// The state of the slots the server honours; a slot it does not honour is not read.
pub(crate) fn blocking(
    support: Option<&Support>,
    stable: Option<&Value>,
    unstable: Option<&Value>,
) -> InviteBlockingDto {
    match support {
        Some(support) if support.stable || support.unstable => InviteBlockingDto {
            supported: true,
            blocked: (support.stable && blocks(stable)) || (support.unstable && blocks(unstable)),
        },
        _ => NOT_SUPPORTED,
    }
}

/// js `writeInviteBlocking`: allowing also clears a block in the unstable slot.
pub(crate) fn writes(
    blocked: bool,
    support: &Support,
    unstable_blocks: bool,
) -> Vec<(&'static str, Value)> {
    if blocked {
        let kind = if support.stable {
            STABLE_TYPE
        } else {
            UNSTABLE_TYPE
        };
        return vec![(kind, json!({"default_action": "block"}))];
    }
    let mut writes = Vec::new();
    if support.stable {
        writes.push((STABLE_TYPE, json!({})));
    }
    if !support.stable || unstable_blocks {
        writes.push((UNSTABLE_TYPE, json!({})));
    }
    writes
}

/// The stored content of a global account-data event, from the SDK's store.
async fn slot(client: &Client, kind: &str) -> Option<Value> {
    let kind = GlobalAccountDataEventType::from(kind);
    let raw = client.account().account_data_raw(kind).await.ok()??;
    raw.deserialize_as_unchecked().ok()
}

/// `RoomListEngine.inviteBlocking`: unsupported at first, then the server's answer. A failed
/// `/versions` is asked again on the next change.
pub fn invite_blocking(engine: Arc<Engine>, account_id: String) -> EngineStream {
    account_stream(engine, account_id, NOT_SUPPORTED, |rt, client| {
        let types = select(
            account_data_changes(&client, STABLE_TYPE),
            account_data_changes(&client, UNSTABLE_TYPE),
        );
        let triggers = select(types, rt.nudged().map(|_| ()));
        async_stream::stream! {
            let mut triggers = pin!(triggers);
            yield NOT_SUPPORTED;
            let (mut support, mut last) = (None, NOT_SUPPORTED);
            loop {
                if support.is_none() {
                    let versions = bounded(client.supported_versions()).await.ok();
                    support = versions.map(|v| blocking_support(&v));
                }
                let (stable, unstable) =
                    (slot(&client, STABLE_TYPE).await, slot(&client, UNSTABLE_TYPE).await);
                let now = blocking(support.as_ref(), stable.as_ref(), unstable.as_ref());
                if now != last {
                    last = now;
                    yield now;
                }
                if triggers.next().await.is_none() {
                    return;
                }
            }
        }
    })
}

/// `RoomListEngine.setInviteBlocking`: replies once the store and every open `inviteBlocking` show
/// the result. A server with no support fails `request-failed`. Nudges every open stream about no
/// room in particular, so open `rooms()` streams read all rooms again; the command is rare.
// shortcut: worst about 200 s (`/versions` 30 s, two writes of 60 s, a 15 s settle after each,
// ~15 s of `ruled` waits, 5 s delivery), past `HOLDER_LIMIT`; a teardown stops the settles, so the
// overrun is the requests' ~165 s, and a store call after them fails on the closed store; upgrade to a whole-command bound or a detached command if a
// teardown gives up on it.
pub fn set_invite_blocking(engine: Arc<Engine>, account_id: String, blocked: bool) -> EngineStream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let versions = engine
                .ruled(&rt, bounded(rt.client.supported_versions()))
                .await?;
            let support = blocking_support(&versions);
            if !support.stable && !support.unstable {
                return Err(Error::UnknownError(
                    "this server does not support invite blocking".into(),
                ));
            }
            let unstable_blocks = blocks(slot(&rt.client, UNSTABLE_TYPE).await.as_ref());
            for (kind, content) in writes(blocked, &support, unstable_blocks) {
                let echoes = account_data_changes(&rt.client, kind);
                engine
                    .ruled(&rt, account_data::put(&rt.client, kind, &content))
                    .await?;
                settle(rt.retired(), echoes, || async {
                    slot(&rt.client, kind).await.as_ref() == Some(&content)
                })
                .await;
            }
            rt.nudge(None).delivered().await;
            Ok(())
        },
    ))
}

/// Which mutual-rooms endpoint the server has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MutualRooms {
    Stable,
    Unstable,
    Unsupported,
}

/// Stable: v1.19+ or `uk.half-shot.msc2666.query_mutual_rooms.stable`; Unstable:
/// `uk.half-shot.msc2666.query_mutual_rooms`.
pub(crate) fn mutual_rooms_support(v: &SupportedVersions) -> MutualRooms {
    if v.versions.iter().any(|v| *v >= MatrixVersion::V1_19)
        || v.features.contains(&FeatureFlag::Msc2666Stable)
    {
        MutualRooms::Stable
    } else if v.features.contains(&FeatureFlag::Msc2666) {
        MutualRooms::Unstable
    } else {
        MutualRooms::Unsupported
    }
}

/// Joined rooms where `user` is known joined, or unknown and listed by the server (MR L130-142).
pub(crate) fn in_common(
    rooms: &[(String, Option<bool>)],
    server: Option<&BTreeSet<String>>,
) -> Vec<String> {
    (rooms.iter())
        .filter(|(id, known)| known.unwrap_or_else(|| server.is_some_and(|ids| ids.contains(id))))
        .map(|(id, _)| id.clone())
        .collect()
}

async fn answer<FF: Future<Output = Option<BTreeSet<String>>>>(
    fetch: FF,
) -> Option<BTreeSet<String>> {
    timeout(fetch, ANSWER_LIMIT).await.ok().flatten()
}

enum Event {
    Change,
    Answer(Option<BTreeSet<String>>),
    Refetch,
}

/// The first item once `fetch` answers or ANSWER_LIMIT passes (None: local view only). A change
/// re-reads `local` at once and fetches again REFETCH_DELAY after the last change, keeping the old
/// answer meanwhile. Distinct.
pub(crate) fn rooms_in_common_of<L, LF, F, FF>(
    changes: impl Stream<Item = ()>,
    mut local: L,
    mut fetch: F,
) -> impl Stream<Item = Vec<String>>
where
    L: FnMut() -> LF,
    LF: Future<Output = Vec<(String, Option<bool>)>>,
    F: FnMut() -> FF,
    FF: Future<Output = Option<BTreeSet<String>>>,
{
    async_stream::stream! {
        let mut changes = pin!(changes.fuse());
        let mut fetching = Some(Box::pin(answer(fetch())));
        let mut refetch: Option<BoxFuture<'static, ()>> = None;
        let mut server: Option<Option<BTreeSet<String>>> = None;
        let mut last = None;
        loop {
            let event = poll_fn(|cx| {
                if let Poll::Ready(Some(())) = changes.poll_next_unpin(cx) {
                    return Poll::Ready(Event::Change);
                }
                if let Some(fetching) = fetching.as_mut()
                    && let Poll::Ready(found) = fetching.as_mut().poll(cx)
                {
                    return Poll::Ready(Event::Answer(found));
                }
                if let Some(refetch) = refetch.as_mut()
                    && let Poll::Ready(()) = refetch.as_mut().poll(cx)
                {
                    return Poll::Ready(Event::Refetch);
                }
                Poll::Pending
            })
            .await;
            match event {
                Event::Change => refetch = Some(Box::pin(sleep(REFETCH_DELAY))),
                Event::Answer(found) => {
                    fetching = None;
                    server = Some(found);
                }
                Event::Refetch => {
                    refetch = None;
                    fetching = Some(Box::pin(answer(fetch())));
                    continue;
                }
            }
            let Some(server) = &server else { continue };
            let rooms = in_common(&local().await, server.as_ref());
            if last.as_ref() != Some(&rooms) {
                last = Some(rooms.clone());
                yield rooms;
            }
        }
    }
}

/// A client handler that sends on `changed` for each member event of `user`, until the guard
/// drops. No `observe_events`, which keeps only the newest event of a sync.
fn member_events(
    client: &Client,
    user: &UserId,
    changed: mpsc::UnboundedSender<()>,
) -> EventHandlerDropGuard {
    let user = user.to_owned();
    let handle = client.add_event_handler(move |event: SyncRoomMemberEvent| {
        if *event.state_key() == user {
            let _ = changed.send(());
        }
        std::future::ready(())
    });
    client.event_handler_drop_guard(handle)
}

/// One item each time an update's room joins or leaves the held `joined` set; a lag re-reads every
/// room.
fn joined_changes(
    mut updates: broadcast::Receiver<RoomInfoNotableUpdate>,
    is_joined: impl Fn(&RoomId) -> bool,
    joined_rooms: impl Fn() -> BTreeSet<OwnedRoomId>,
) -> impl Stream<Item = ()> {
    let mut joined = joined_rooms();
    async_stream::stream! {
        loop {
            let changed = match updates.recv().await {
                Ok(update) if is_joined(&update.room_id) => joined.insert(update.room_id),
                Ok(update) => joined.remove(&update.room_id),
                Err(RecvError::Lagged(_)) => {
                    let now = joined_rooms();
                    let changed = now != joined;
                    joined = now;
                    changed
                }
                Err(RecvError::Closed) => return,
            };
            if changed {
                yield ();
            }
        }
    }
}

/// Member events of `user`, and the account's joined rooms changing. A join from an invite raises
/// no `MEMBERSHIP` notable update under sliding sync, so each update checks its room.
fn membership_changes(client: &Client, user: &UserId) -> impl Stream<Item = ()> + Unpin + use<> {
    let (changed, mut events) = mpsc::unbounded_channel();
    let guard = member_events(client, user, changed);
    let members = stream::poll_fn(move |cx| {
        let _ = &guard;
        events.poll_recv(cx)
    });
    let (joined, all) = (client.clone(), client.clone());
    let joins = joined_changes(
        client.room_info_notable_update_receiver(),
        move |id| (joined.get_room(id)).is_some_and(|room| room.state() == RoomState::Joined),
        move || {
            (all.joined_rooms().iter())
                .map(|room| room.room_id().to_owned())
                .collect()
        },
    );
    select(members, Box::pin(joins))
}

/// The rooms `user` has joined with the account, as the server lists them: at most `MAX_PAGES`
/// pages. Any failure is `None`.
async fn mutual_rooms(client: &Client, user: &UserId) -> Option<BTreeSet<String>> {
    let versions = client.supported_versions().await.ok()?;
    match mutual_rooms_support(&versions) {
        MutualRooms::Stable => {
            collect_pages(|from| {
                let mut request = v1::Request::new(user.to_owned());
                request.from = from;
                let sent = client.send(request).with_request_config(sent_once());
                async move { sent.await.map(|page| (page.joined, page.next_batch)) }
            })
            .await
        }
        MutualRooms::Unstable => {
            collect_pages(|from| {
                let mut request = unstable::Request::new(user.to_owned());
                request.from = from;
                let sent = client.send(request).with_request_config(sent_once());
                async move { sent.await.map(|page| (page.joined, page.next_batch)) }
            })
            .await
        }
        MutualRooms::Unsupported => None,
    }
}

async fn collect_pages<Page, Fut, E>(mut page: Page) -> Option<BTreeSet<String>>
where
    Page: FnMut(Option<String>) -> Fut,
    Fut: Future<Output = Result<(Vec<OwnedRoomId>, Option<String>), E>>,
{
    let (mut ids, mut from) = (BTreeSet::new(), None);
    for _ in 0..MAX_PAGES {
        let (joined, next) = page(from.take()).await.ok()?;
        ids.extend(joined.into_iter().map(String::from));
        let Some(next) = next else { break };
        from = Some(next);
    }
    Some(ids)
}

/// `RoomListEngine.roomsInCommon`. Not live, or an invalid user id: `[]`.
pub fn rooms_in_common(engine: Arc<Engine>, account_id: String, user_id: String) -> EngineStream {
    account_stream(
        engine,
        account_id,
        Vec::<String>::new(),
        move |_, client| {
            let user = UserId::parse(&user_id).ok();
            let changes = user
                .as_deref()
                .map(|user| membership_changes(&client, user));
            async_stream::stream! {
                let Some((user, changes)) = user.zip(changes) else {
                    yield Vec::new();
                    return;
                };
                let (local_client, fetch_client) = (client.clone(), client);
                let (local_user, fetch_user) = (user.clone(), user);
                let local = move || {
                    let (client, user) = (local_client.clone(), local_user.clone());
                    async move {
                        let mut rooms = Vec::new();
                        for room in client.joined_rooms() {
                            let member = room.get_member_no_sync(&user).await.ok().flatten();
                            let known = member.map(|member| *member.membership() == MembershipState::Join);
                            rooms.push((room.room_id().to_string(), known));
                        }
                        rooms
                    }
                };
                let fetch = move || {
                    let (client, user) = (fetch_client.clone(), fetch_user.clone());
                    async move { mutual_rooms(&client, &user).await }
                };
                let mut rooms = pin!(rooms_in_common_of(changes, local, fetch));
                while let Some(rooms) = rooms.next().await {
                    yield rooms;
                }
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::BTreeMap, future::pending, future::ready};

    use futures_util::FutureExt;
    use matrix_sdk_base::RoomInfoNotableUpdateReasons;
    use tokio::{select, sync::mpsc, time::Instant};

    use super::*;

    fn versions(versions: &[&str], features: &[&str]) -> SupportedVersions {
        let versions: Vec<String> = versions.iter().map(|v| (*v).to_owned()).collect();
        let features: BTreeMap<String, bool> =
            features.iter().map(|f| ((*f).to_owned(), true)).collect();
        SupportedVersions::from_parts(&versions, &features)
    }

    fn strings(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn blocking_support_reads_v1_18_the_stable_flag_or_the_unstable_flag() {
        fn support(v: &[&str], f: &[&str]) -> Support {
            blocking_support(&versions(v, f))
        }
        let (stable, neither) = (
            Support {
                stable: true,
                unstable: false,
            },
            Support {
                stable: false,
                unstable: false,
            },
        );
        assert_eq!(support(&["v1.18"], &[]), stable);
        assert_eq!(support(&[], &["org.matrix.msc4380.stable"]), stable);
        let only_unstable = Support {
            stable: false,
            unstable: true,
        };
        assert_eq!(support(&[], &["org.matrix.msc4380"]), only_unstable);
        assert_eq!(support(&["v1.12"], &[]), neither);
    }

    #[test]
    fn blocking_reads_the_honoured_slots() {
        let block = json!({"default_action": "block"});
        let (stable, both) = (
            Support {
                stable: true,
                unstable: false,
            },
            Support {
                stable: true,
                unstable: true,
            },
        );
        let state = |supported, blocked| InviteBlockingDto { supported, blocked };
        assert_eq!(
            blocking(None, Some(&block), Some(&block)),
            state(false, false)
        );
        assert_eq!(
            blocking(Some(&stable), Some(&block), None),
            state(true, true)
        );
        assert_eq!(
            blocking(Some(&stable), None, Some(&block)),
            state(true, false)
        );
        assert_eq!(blocking(Some(&both), None, Some(&block)), state(true, true));
    }

    #[test]
    fn writes_follow_the_js_plan() {
        let (stable, unstable) = (
            Support {
                stable: true,
                unstable: false,
            },
            Support {
                stable: false,
                unstable: true,
            },
        );
        let block = json!({"default_action": "block"});
        assert_eq!(writes(true, &stable, false), [(STABLE_TYPE, block.clone())]);
        assert_eq!(writes(true, &unstable, false), [(UNSTABLE_TYPE, block)]);
        assert_eq!(writes(false, &stable, false), [(STABLE_TYPE, json!({}))]);
        assert_eq!(
            writes(false, &stable, true),
            [(STABLE_TYPE, json!({})), (UNSTABLE_TYPE, json!({}))]
        );
        assert_eq!(
            writes(false, &unstable, false),
            [(UNSTABLE_TYPE, json!({}))]
        );
    }

    #[test]
    fn mutual_rooms_support_prefers_the_stable_endpoint() {
        fn support(v: &[&str], f: &[&str]) -> MutualRooms {
            mutual_rooms_support(&versions(v, f))
        }
        let unstable = "uk.half-shot.msc2666.query_mutual_rooms";
        assert_eq!(support(&["v1.19"], &[unstable]), MutualRooms::Stable);
        assert_eq!(
            support(&[], &[&format!("{unstable}.stable")]),
            MutualRooms::Stable
        );
        assert_eq!(support(&["v1.18"], &[unstable]), MutualRooms::Unstable);
        assert_eq!(support(&["v1.18"], &[]), MutualRooms::Unsupported);
    }

    #[test]
    fn in_common_trusts_known_members_and_the_server_for_unknown_ones() {
        let rooms = [
            ("!a".to_owned(), None),
            ("!b".to_owned(), Some(true)),
            ("!c".to_owned(), Some(false)),
        ];
        assert_eq!(
            in_common(&rooms, Some(&strings(&["!a", "!c"]))),
            ["!a", "!b"]
        );
        assert_eq!(in_common(&rooms, None), ["!b"]);
    }

    fn local_view() -> Vec<(String, Option<bool>)> {
        vec![("!a".to_owned(), None), ("!b".to_owned(), Some(true))]
    }

    #[tokio::test(start_paused = true)]
    async fn rooms_in_common_waits_for_the_answer() {
        let start = Instant::now();
        let fetch = || async {
            tokio::time::sleep(Duration::from_secs(2)).await;
            Some(strings(&["!a"]))
        };
        let mut items = pin!(rooms_in_common_of(
            stream::pending(),
            || ready(local_view()),
            fetch
        ));
        let early = tokio::time::timeout(Duration::from_millis(1999), items.next()).await;
        assert!(early.is_err(), "nothing before the answer");
        assert_eq!(
            items.next().await,
            Some(vec!["!a".to_owned(), "!b".to_owned()])
        );
        assert_eq!(start.elapsed(), Duration::from_secs(2));
    }

    #[tokio::test(start_paused = true)]
    async fn rooms_in_common_gives_up_on_the_server_after_ten_seconds() {
        let start = Instant::now();
        let fetch = || pending::<Option<BTreeSet<String>>>();
        let mut items = pin!(rooms_in_common_of(
            stream::pending(),
            || ready(local_view()),
            fetch
        ));
        assert_eq!(items.next().await, Some(vec!["!b".to_owned()]));
        assert_eq!(start.elapsed(), ANSWER_LIMIT);
    }

    #[tokio::test(start_paused = true)]
    async fn rooms_in_common_refetches_one_second_after_the_last_change() {
        let start = Instant::now();
        let fetched = RefCell::new(Vec::new());
        let fetch = || {
            let first = fetched.borrow().is_empty();
            fetched.borrow_mut().push(start.elapsed());
            async move {
                if first {
                    return Some(strings(&["!a"]));
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
                Some(strings(&[]))
            }
        };
        let view = RefCell::new(local_view());
        let (change, mut changes) = mpsc::unbounded_channel();
        let changes = stream::poll_fn(move |cx| changes.poll_recv(cx));
        let mut items = pin!(rooms_in_common_of(
            changes,
            || ready(view.borrow().clone()),
            fetch
        ));
        let seen = RefCell::new(Vec::new());
        let drive = async {
            while let Some(rooms) = items.next().await {
                seen.borrow_mut().push((start.elapsed(), rooms));
            }
        };
        let script = async {
            view.borrow_mut()[1].1 = Some(false);
            change.send(()).unwrap();
            tokio::time::sleep(Duration::from_millis(500)).await;
            change.send(()).unwrap();
            tokio::time::sleep(Duration::from_secs(3)).await;
        };
        select! { biased; () = drive => {}, () = script => {} }
        assert_eq!(
            *fetched.borrow(),
            [Duration::ZERO, Duration::from_millis(1500)]
        );
        let rooms = |ids: &[&str]| ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            *seen.borrow(),
            [
                (Duration::ZERO, rooms(&["!a", "!b"])),
                // Re-read at once, with the old answer still vouching for `!a`.
                (Duration::ZERO, rooms(&["!a"])),
                (Duration::from_millis(2500), rooms(&[])),
            ]
        );
    }

    fn touched(room: &str) -> RoomInfoNotableUpdate {
        RoomInfoNotableUpdate {
            room_id: room.try_into().unwrap(),
            reasons: RoomInfoNotableUpdateReasons::NONE,
        }
    }

    #[tokio::test]
    async fn joined_changes_yield_once_per_join_or_leave() {
        let joined: RefCell<BTreeSet<OwnedRoomId>> = RefCell::new([touched("!a:x").room_id].into());
        let (tx, rx) = broadcast::channel(8);
        let mut changes = pin!(joined_changes(
            rx,
            |id| joined.borrow().contains(id),
            || joined.borrow().clone()
        ));
        tx.send(touched("!a:x")).unwrap();
        assert!(changes.next().now_or_never().is_none(), "still joined");
        joined.borrow_mut().insert(touched("!b:x").room_id);
        tx.send(touched("!b:x")).unwrap();
        assert_eq!(changes.next().await, Some(()), "a join");
        joined.borrow_mut().remove(&touched("!a:x").room_id);
        tx.send(touched("!a:x")).unwrap();
        assert_eq!(changes.next().await, Some(()), "a leave");
        tx.send(touched("!c:x")).unwrap();
        assert!(changes.next().now_or_never().is_none(), "never joined");
    }
}
