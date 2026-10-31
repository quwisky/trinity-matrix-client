//! Spaces: a space's child links, its hierarchy, and linking a child to its parent. The order
//! rules are `libs/data-access/room-library/src/lib/space-child-order.ts`, the rest
//! `js-sdk/space-links.ts`.

use std::{cmp::Ordering, collections::HashSet, future::ready, pin::pin, sync::Arc};

use futures_util::{
    StreamExt,
    stream::{PollNext, select_with_strategy},
};
use matrix_sdk::{
    Client, Error,
    ruma::{
        OwnedRoomId, RoomId,
        api::client::{
            space::SpaceHierarchyRoomsChunk, space::get_hierarchy, state::send_state_event,
        },
        events::{AnyStateEventContent, StateEventType},
        room::RoomType,
        serde::Raw,
        uint,
    },
};
use matrix_sdk_base::deserialized_responses::RawAnySyncOrStrippedState;
use serde_json::{Value, json, value::to_raw_value};

use super::{
    HierarchyEntryDto, HierarchyOptionsDto, SpaceChildLinkDto, SpaceChildLinkInputDto,
    rows::saturated,
};
use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream, reply},
    engines::{
        member::{account_stream, on_account, sent_once},
        settle::{room_changes, settle},
    },
    failure::request_failed,
};

/// The spec's limit on an `order` key.
const MAX_ORDER_LENGTH: usize = 50;

/// js `linkOf`: a malformed `via`, `suggested` or `order` reads as its default.
pub(crate) fn link_of(child_id: &str, content: &Value) -> SpaceChildLinkDto {
    let via = content.get("via").and_then(Value::as_array);
    SpaceChildLinkDto {
        child_id: child_id.to_owned(),
        via: (via.into_iter().flatten())
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        suggested: content.get("suggested") == Some(&Value::Bool(true)),
        order: (content.get("order").and_then(Value::as_str))
            .unwrap_or_default()
            .to_owned(),
    }
}

/// At most 50 characters, each in `\x20`-`\x7E`; the spec reads any other key as no order.
pub(crate) fn is_valid_order(order: &str) -> bool {
    order.len() <= MAX_ORDER_LENGTH && order.bytes().all(|b| (0x20..=0x7E).contains(&b))
}

/// By code point, with an empty key (unordered) last.
pub(crate) fn compare_order(a: &str, b: &str) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => a.cmp(b),
    }
}

/// Drops an empty child id or `via` (the spec's tombstone), blanks an invalid order, and sorts by
/// order then child id (js `readChildLinks`).
pub(crate) fn live_links(links: Vec<SpaceChildLinkDto>) -> Vec<SpaceChildLinkDto> {
    let mut live: Vec<_> = links
        .into_iter()
        .filter(|link| !link.child_id.is_empty() && !link.via.is_empty())
        .map(|mut link| {
            if !is_valid_order(&link.order) {
                link.order.clear();
            }
            link
        })
        .collect();
    live.sort_by(|a, b| {
        compare_order(&a.order, &b.order).then_with(|| a.child_id.cmp(&b.child_id))
    });
    live
}

/// The `m.space.child` content of a link, or the empty content that removes it (js `childContent`).
pub(crate) fn child_content(link: Option<&SpaceChildLinkInputDto>) -> Value {
    let Some(link) = link else {
        return json!({});
    };
    let mut content = json!({"via": link.via});
    if link.suggested {
        content["suggested"] = json!(true);
    }
    if !link.order.is_empty() {
        content["order"] = json!(link.order);
    }
    content
}

fn non_empty(text: Option<&str>) -> Option<String> {
    text.filter(|text| !text.is_empty()).map(str::to_owned)
}

/// `get_hierarchy::v1` answered with each chunk kept raw, so one malformed child does not fail the
/// page. Hand-written because ruma's `#[request]` needs a `client` feature in this crate.
mod lenient_hierarchy {
    use matrix_sdk::ruma::{
        api::{
            IncomingResponse, Metadata, OutgoingRequest,
            client::space::{SpaceHierarchyRoomsChunk, get_hierarchy::v1},
            error::{DeserializationError, IntoHttpError},
            path_builder::PathBuilder,
        },
        exports::http,
        serde::Raw,
    };
    use serde::Deserialize;

    #[derive(Clone, Debug)]
    pub(super) struct Request(pub(super) v1::Request);

    impl Metadata for Request {
        const METHOD: http::Method = v1::Request::METHOD;
        const RATE_LIMITED: bool = v1::Request::RATE_LIMITED;
        type Authentication = <v1::Request as Metadata>::Authentication;
        type PathBuilder = <v1::Request as Metadata>::PathBuilder;
        const PATH_BUILDER: Self::PathBuilder = v1::Request::PATH_BUILDER;
    }

    impl OutgoingRequest for Request {
        type Body = <v1::Request as OutgoingRequest>::Body;
        type EndpointError = <v1::Request as OutgoingRequest>::EndpointError;
        type IncomingResponse = Response;

        fn try_into_http_request_inner(
            self,
            base_url: &str,
            path_builder_input: <Self::PathBuilder as PathBuilder>::Input<'_>,
        ) -> Result<http::Request<Self::Body>, IntoHttpError> {
            self.0
                .try_into_http_request_inner(base_url, path_builder_input)
        }
    }

    #[derive(Debug, Default, Deserialize)]
    pub(super) struct Response {
        pub(super) next_batch: Option<String>,
        pub(super) rooms: Vec<Raw<SpaceHierarchyRoomsChunk>>,
    }

    impl IncomingResponse for Response {
        type EndpointError = <v1::Request as OutgoingRequest>::EndpointError;

        fn try_from_http_response_inner(
            response: http::Response<&[u8]>,
        ) -> Result<Self, DeserializationError> {
            Ok(serde_json::from_slice(response.body())?)
        }
    }
}

/// A chunk, or, when ruma rejects it, the chunk without its `canonical_alias` (a malformed alias
/// such as `""` reads as none, as in js). A chunk that fails even so is skipped.
fn decode_chunk(raw: &Raw<SpaceHierarchyRoomsChunk>) -> Option<SpaceHierarchyRoomsChunk> {
    let chunk = raw.deserialize().ok().or_else(|| {
        let mut fields: Value = raw.deserialize_as_unchecked().ok()?;
        fields.as_object_mut()?.remove("canonical_alias");
        serde_json::from_value(fields).ok()
    });
    if chunk.is_none() {
        tracing::warn!("skipping a malformed space hierarchy room");
    }
    chunk
}

pub(crate) fn entry_of(chunk: &SpaceHierarchyRoomsChunk) -> HierarchyEntryDto {
    let summary = &chunk.summary;
    let children = chunk.children_state.iter().filter_map(|event| {
        let key = event.get_field::<String>("state_key").ok().flatten()?;
        let content = event.get_field::<Value>("content").ok().flatten();
        (!key.is_empty()).then(|| link_of(&key, &content.unwrap_or(Value::Null)))
    });
    HierarchyEntryDto {
        room_id: summary.room_id.to_string(),
        name: non_empty(summary.name.as_deref()),
        canonical_alias: summary.canonical_alias.as_ref().map(ToString::to_string),
        topic: non_empty(summary.topic.as_deref()),
        avatar_mxc: summary.avatar_url.as_ref().map(ToString::to_string),
        joined_member_count: saturated(summary.num_joined_members),
        join_rule: Some(summary.join_rule.as_str().to_owned()),
        is_space: summary.room_type == Some(RoomType::Space),
        children_state: children.collect(),
    }
}

/// The hierarchy across `next_batch` pages, until a page has none or `max_pages` are fetched. A
/// repeated token would loop for ever, so it fails.
async fn hierarchy_pages<F, Fut>(
    max_pages: Option<u32>,
    mut fetch: F,
) -> Result<Vec<HierarchyEntryDto>, Error>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: Future<Output = Result<lenient_hierarchy::Response, Error>>,
{
    let (mut entries, mut seen, mut from) = (Vec::new(), HashSet::new(), None);
    for _ in (0..).take_while(|page| max_pages.is_none_or(|max| *page < max)) {
        let response = fetch(from.take()).await?;
        entries.extend(
            response
                .rooms
                .iter()
                .filter_map(decode_chunk)
                .map(|c| entry_of(&c)),
        );
        let Some(token) = response.next_batch.filter(|token| !token.is_empty()) else {
            break;
        };
        if !seen.insert(token.clone()) {
            return Err(Error::UnknownError(
                "the space hierarchy repeated a page token".into(),
            ));
        }
        from = Some(token);
    }
    Ok(entries)
}

/// The raw fields of a stored state event.
fn fields_of(event: &RawAnySyncOrStrippedState) -> Option<Value> {
    serde_json::to_value(event).ok()
}

/// The space's links, or `None` when the state store cannot be read. An unknown space has none.
async fn read_links(client: &Client, space: &RoomId) -> Option<Vec<SpaceChildLinkDto>> {
    let Some(room) = client.get_room(space) else {
        return Some(Vec::new());
    };
    let events = match room.get_state_events(StateEventType::SpaceChild).await {
        Ok(events) => events,
        Err(err) => {
            tracing::warn!("reading the child links of {space} failed: {err}");
            return None;
        }
    };
    // The raw content, because typed content rejects the `{}` tombstone.
    let links = events.iter().filter_map(fields_of).filter_map(|mut event| {
        let key = event.get("state_key")?.as_str()?.to_owned();
        let content = event.get_mut("content").map(Value::take);
        Some(link_of(&key, &content.unwrap_or(Value::Null)))
    });
    Some(live_links(links.collect()))
}

/// `RoomListEngine.spaceChildLinks`: the current links, then each change that differs. An unknown
/// space, and a not-live account, read `[]`.
pub fn space_child_links(engine: Arc<Engine>, account_id: String, space_id: String) -> Stream {
    account_stream(
        engine,
        account_id,
        Vec::<SpaceChildLinkDto>::new(),
        move |rt, client| {
            let space = RoomId::parse(&space_id).ok();
            let changes = space.as_deref().map(|id| room_changes(&client, id));
            let nudges = rt.nudged();
            async_stream::stream! {
                let Some((space, changes)) = space.zip(changes) else {
                    yield Vec::new();
                    return;
                };
                // A nudge about another room is still taken, which meets its command's barrier.
                let named = space.clone();
                let nudges = nudges.filter_map(move |room| {
                    ready(room.is_none_or(|id| id == named).then_some(()))
                });
                let mut triggers = pin!(select_with_strategy(nudges, changes, |(): &mut ()| {
                    PollNext::Left
                }));
                let mut last = None;
                loop {
                    if let Some(links) = read_links(&client, &space).await
                        && last.as_ref() != Some(&links)
                    {
                        last = Some(links.clone());
                        yield links;
                    }
                    if triggers.next().await.is_none() {
                        return;
                    }
                }
            }
        },
    )
}

/// `RoomListEngine.spaceHierarchy`: the space and its direct children, `limit` 100.
pub fn space_hierarchy(
    engine: Arc<Engine>,
    account_id: String,
    space_id: String,
    options: HierarchyOptionsDto,
) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let space = RoomId::parse(&space_id)?;
            let (engine, rt) = (&engine, &rt);
            hierarchy_pages(options.max_pages, |from| {
                let mut request = get_hierarchy::v1::Request::new(space.clone());
                request.from = from;
                request.limit = Some(uint!(100));
                request.max_depth = Some(uint!(1));
                let request = lenient_hierarchy::Request(request);
                let sent = rt.client.send(request).with_request_config(sent_once());
                engine.ruled(rt, sent)
            })
            .await
        },
    ))
}

/// A raw state event with `content`, because the typed content types would reject what js writes.
async fn send_state(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    room: OwnedRoomId,
    event_type: StateEventType,
    state_key: &str,
    content: &Value,
) -> Result<send_state_event::v3::Response, Error> {
    let body: Raw<AnyStateEventContent> = Raw::from_json(to_raw_value(content)?);
    let request =
        send_state_event::v3::Request::new_raw(room, event_type, state_key.to_owned(), body);
    let sent = rt.client.send(request).with_request_config(sent_once());
    engine.ruled(rt, sent).await
}

/// Sends the `m.space.child` event, then waits until the space's state holds it.
pub(crate) async fn write_child(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    space: &RoomId,
    child: &str,
    content: &Value,
) -> Result<(), Error> {
    let kind = StateEventType::SpaceChild;
    let sent = send_state(engine, rt, space.to_owned(), kind.clone(), child, content).await?;
    let changes = room_changes(&rt.client, space);
    settle(rt.retired(), changes, || async {
        let Some(room) = rt.client.get_room(space) else {
            return false;
        };
        let stored = room.get_state_event(kind.clone(), child).await;
        let stored = stored.ok().flatten().as_ref().and_then(fields_of);
        let id = stored
            .as_ref()
            .and_then(|event| event.get("event_id")?.as_str());
        id == Some(sent.event_id.as_str())
    })
    .await;
    Ok(())
}

/// `RoomListEngine.setSpaceChild`: `None` unlinks. Replies once the space's state and every open
/// `spaceChildLinks` show it.
pub fn set_space_child(
    engine: Arc<Engine>,
    account_id: String,
    space_id: String,
    child_id: String,
    link: Option<SpaceChildLinkInputDto>,
) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let space = RoomId::parse(&space_id)?;
            let content = child_content(link.as_ref());
            write_child(&engine, &rt, &space, &child_id, &content).await?;
            rt.nudge(Some(&space)).delivered().await;
            Ok(())
        },
    ))
}

/// `RoomListEngine.setSpaceParent`: a canonical `m.space.parent` in the child, keyed by the space.
pub fn set_space_parent(
    engine: Arc<Engine>,
    account_id: String,
    child_id: String,
    space_id: String,
    via: Vec<String>,
) -> Stream {
    reply(on_account(
        engine,
        account_id,
        request_failed,
        move |engine, rt| async move {
            let child = RoomId::parse(&child_id)?;
            let content = json!({"via": via, "canonical": true});
            let kind = StateEventType::SpaceParent;
            send_state(&engine, &rt, child, kind, &space_id, &content).await?;
            Ok(())
        },
    ))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::failure::FailureKind;

    fn link(child: &str, via: &[&str], order: &str) -> SpaceChildLinkDto {
        SpaceChildLinkDto {
            child_id: child.into(),
            via: via.iter().map(|s| (*s).to_owned()).collect(),
            suggested: false,
            order: order.into(),
        }
    }

    #[test]
    fn link_of_reads_via_suggested_and_order_leniently() {
        let content = json!({"via": ["a", 3], "suggested": "yes", "order": 5});
        assert_eq!(link_of("!c:x", &content), link("!c:x", &["a"], ""));
        assert_eq!(link_of("!c:x", &Value::Null), link("!c:x", &[], ""));
    }

    #[test]
    fn order_rules_match_space_child_order_ts() {
        assert!(is_valid_order(&"x".repeat(50)));
        assert!(!is_valid_order(&"x".repeat(51)));
        assert!(!is_valid_order("\u{7f}"));
        assert!(is_valid_order(" "));
        assert_eq!(compare_order("", "a"), Ordering::Greater);
        assert_eq!(compare_order("B", "a"), Ordering::Less);
    }

    #[test]
    fn live_links_drop_tombstones_blank_bad_orders_and_sort_by_spec() {
        let long = "x".repeat(51);
        let live = live_links(vec![
            link("c1", &[], "a"),
            link("c2", &["s"], "b"),
            link("c3", &["s"], &long),
            link("c4", &["s"], "a"),
            link("", &["s"], ""),
        ]);
        assert_eq!(
            live,
            [
                link("c4", &["s"], "a"),
                link("c2", &["s"], "b"),
                link("c3", &["s"], ""),
            ]
        );
    }

    #[test]
    fn live_links_break_an_order_tie_by_child_id() {
        let live = live_links(vec![link("!b:x", &["s"], "m"), link("!a:x", &["s"], "m")]);
        assert_eq!(live, [link("!a:x", &["s"], "m"), link("!b:x", &["s"], "m")]);
    }

    #[test]
    fn child_content_omits_defaults_and_null_removes() {
        let input = |suggested, order: &str| SpaceChildLinkInputDto {
            via: vec!["s".into()],
            suggested,
            order: order.into(),
        };
        assert_eq!(child_content(None), json!({}));
        assert_eq!(
            child_content(Some(&input(false, ""))),
            json!({"via": ["s"]})
        );
        assert_eq!(
            child_content(Some(&input(true, "m"))),
            json!({"via": ["s"], "suggested": true, "order": "m"})
        );
    }

    fn chunk_json(value: Value) -> Value {
        let base = json!({
            "room_id": "!r:x",
            "num_joined_members": 3,
            "world_readable": false,
            "guest_can_join": false,
            "children_state": [],
        });
        let (Value::Object(mut chunk), Value::Object(extra)) = (base, value) else {
            unreachable!("both are objects");
        };
        chunk.extend(extra);
        Value::Object(chunk)
    }

    fn chunk(value: Value) -> SpaceHierarchyRoomsChunk {
        serde_json::from_value(chunk_json(value)).unwrap()
    }

    fn raw(value: Value) -> Raw<SpaceHierarchyRoomsChunk> {
        Raw::from_json(to_raw_value(&chunk_json(value)).unwrap())
    }

    #[test]
    fn hierarchy_entry_maps_empty_strings_to_null_and_a_missing_join_rule_to_public() {
        let empty = chunk(json!({
            "name": "",
            "topic": "",
            "room_type": "m.space",
            "children_state": [
                {"type": "m.space.child", "state_key": "", "content": {"via": ["s"]}},
                {"type": "m.space.child", "state_key": "!c:x", "content": {"via": [], "order": "z"}},
            ],
        }));
        let entry = entry_of(&empty);
        assert_eq!((entry.name, entry.topic), (None, None));
        assert_eq!(entry.join_rule.as_deref(), Some("public"));
        assert!(entry.is_space);
        assert_eq!(entry.joined_member_count, 3);
        assert_eq!(entry.children_state, [link("!c:x", &[], "z")]);

        let full = chunk(json!({"name": "N", "topic": "T", "join_rule": "invite"}));
        let entry = entry_of(&full);
        assert_eq!(entry.name.as_deref(), Some("N"));
        assert_eq!(entry.topic.as_deref(), Some("T"));
        assert_eq!(entry.join_rule.as_deref(), Some("invite"));
        assert!(!entry.is_space);
    }

    fn page(next: Option<&str>, room: &str) -> lenient_hierarchy::Response {
        lenient_hierarchy::Response {
            next_batch: next.map(str::to_owned),
            rooms: vec![raw(json!({"room_id": room}))],
        }
    }

    /// Fetches `pages` in order and records the token each fetch was given.
    async fn fetched(
        max_pages: Option<u32>,
        pages: Vec<lenient_hierarchy::Response>,
    ) -> (Result<Vec<HierarchyEntryDto>, Error>, Vec<Option<String>>) {
        let (tokens, pages) = (RefCell::new(Vec::new()), RefCell::new(pages.into_iter()));
        let result = hierarchy_pages(max_pages, |from| {
            tokens.borrow_mut().push(from);
            let next = pages.borrow_mut().next().expect("a page was scripted");
            ready(Ok(next))
        })
        .await;
        (result, tokens.into_inner())
    }

    #[tokio::test]
    async fn hierarchy_follows_pages_until_no_token() {
        let pages = vec![
            page(Some("t1"), "!a:x"),
            page(Some("t2"), "!b:x"),
            page(None, "!c:x"),
        ];
        let (result, tokens) = fetched(None, pages).await;
        let ids: Vec<_> = result.unwrap().into_iter().map(|e| e.room_id).collect();
        assert_eq!(ids, ["!a:x", "!b:x", "!c:x"]);
        assert_eq!(tokens, [None, Some("t1".into()), Some("t2".into())]);
    }

    #[tokio::test]
    async fn hierarchy_stops_at_max_pages() {
        let pages = vec![page(Some("t1"), "!a:x")];
        let (result, tokens) = fetched(Some(1), pages).await;
        assert_eq!(result.unwrap().len(), 1);
        assert_eq!(tokens, [None]);
    }

    #[tokio::test]
    async fn hierarchy_fails_on_a_repeated_token() {
        let pages = vec![page(Some("t1"), "!a:x"), page(Some("t1"), "!b:x")];
        let (result, tokens) = fetched(None, pages).await;
        let err = result.unwrap_err();
        assert!(matches!(err, Error::UnknownError(_)));
        assert_eq!(request_failed(&err).kind, FailureKind::Unexpected);
        assert_eq!(tokens.len(), 2);
    }

    #[tokio::test]
    async fn hierarchy_reads_a_malformed_alias_as_none_and_skips_a_broken_room() {
        let page = lenient_hierarchy::Response {
            next_batch: None,
            rooms: vec![
                raw(json!({"room_id": "!a:x", "canonical_alias": ""})),
                raw(json!({"room_id": 5})),
                raw(json!({"room_id": "!b:x", "canonical_alias": "#b:x"})),
            ],
        };
        let (result, _) = fetched(None, vec![page]).await;
        let entries: Vec<_> = (result.unwrap().into_iter())
            .map(|e| (e.room_id, e.canonical_alias))
            .collect();
        assert_eq!(
            entries,
            [
                ("!a:x".to_owned(), None),
                ("!b:x".to_owned(), Some("#b:x".to_owned()))
            ]
        );
    }
}
