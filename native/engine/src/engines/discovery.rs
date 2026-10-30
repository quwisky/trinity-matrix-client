//! `DiscoveryEngine` (`libs/data-access/discovery/src/lib/discovery-engine.ts`), member by member
//! as its js-sdk adapter (`js-sdk-discovery-engine.ts`, `room-link-preview.ts`) derives each value.

use std::{net::Ipv6Addr, sync::Arc, time::Duration};

use futures_util::stream;
use matrix_sdk::{
    Client, ClientBuildError, Error, HttpError, Room, RoomState, RumaApiError, SendOutsideWasm,
    config::RequestConfig,
    reqwest::Url,
    ruma::{
        OwnedRoomOrAliasId, OwnedServerName, RoomAliasId, RoomId, RoomOrAliasId, ServerName,
        api::{
            client::directory::get_public_rooms_filtered,
            error::{ErrorKind, FromHttpResponseError},
        },
        directory::{PublicRoomsChunk, RoomTypeFilter},
        room::RoomType,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream, stream},
    engines::{member::bounded, session::logout::raw_get},
    failure::{
        Diagnostic, DiscoveryFailureReason, EngineFailure, EngineResult, FailureCode, FailureKind,
        not_signed_in, request_failed,
    },
};

const DTO: &str = "data-access/discovery/src/lib/rust-dto/";
/// js-sdk's `SUPPORTED_MATRIX_VERSIONS`, one of which `AutoDiscovery` requires.
const SUPPORTED_MATRIX_VERSIONS: [&str; 13] = [
    "v1.1", "v1.2", "v1.3", "v1.4", "v1.5", "v1.6", "v1.7", "v1.8", "v1.9", "v1.10", "v1.11",
    "v1.12", "v1.13",
];
/// `MAX_VIA_SERVERS` in `matrix-to.ts`.
const MAX_VIA_SERVERS: usize = 3;
/// Per room summary request, about the js adapter's longest request (19.5 s).
const SUMMARY_TIMEOUT: Duration = Duration::from_secs(20);

/// `PublicRoomsQuery`, which a caller may send with `null` for an absent field.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct PublicRoomsQueryDto {
    #[ts(optional = nullable)]
    term: Option<String>,
    #[ts(optional = nullable)]
    since: Option<String>,
    #[ts(optional = nullable)]
    spaces: Option<bool>,
    limit: u32,
}

/// `PublicRoomsPage`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct PublicRoomsPageDto {
    rooms: Vec<PublicRoomSummaryDto>,
    next_batch: Option<String>,
    #[ts(type = "number | null")]
    total: Option<u64>,
}

/// `PublicRoomSummary`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct PublicRoomSummaryDto {
    room_id: String,
    name: String,
    topic: Option<String>,
    alias: Option<String>,
    avatar_mxc: Option<String>,
    #[ts(type = "number")]
    member_count: u64,
    is_space: bool,
}

/// `UserDirectoryPage`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct UserDirectoryPageDto {
    users: Vec<DiscoveredUserDto>,
    limited: bool,
}

/// `DiscoveredUser`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct DiscoveredUserDto {
    user_id: String,
    display_name: String,
    avatar_mxc: Option<String>,
}

/// `RoomLinkPreviewData`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct RoomLinkPreviewDataDto {
    room_id: String,
    canonical_address: Option<String>,
    name: String,
    topic: Option<String>,
    avatar_mxc: Option<String>,
    #[ts(type = "number | null")]
    member_count: Option<u64>,
    encrypted: Option<bool>,
    join_rule: RoomLinkJoinRuleDto,
    membership: RoomLinkMembershipDto,
    is_space: bool,
    via: Vec<String>,
    restricted_eligible: bool,
}

/// `RoomLinkJoinRule`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = DTO)]
pub enum RoomLinkJoinRuleDto {
    Public,
    Knock,
    KnockRestricted,
    Restricted,
    Invite,
    Private,
    Unknown,
}

/// `RoomLinkMembership`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum RoomLinkMembershipDto {
    Join,
    Invite,
    Knock,
    Ban,
    Leave,
    Unknown,
}

/// Emits `{ domain, baseUrl }`, or `discovery-failed` with the reason `AutoDiscovery` gives.
pub fn discover(engine: Arc<Engine>, domain: String) -> Stream {
    stream(stream::once(async move {
        let result = match discover_base_url(&engine, &domain).await {
            Ok(base_url) => EngineResult::Ok(json!({ "domain": domain, "baseUrl": base_url })),
            Err(reason) => EngineResult::Err(EngineFailure {
                kind: FailureKind::Unexpected,
                diagnostic: Diagnostic::new(FailureKind::Unexpected),
                code: FailureCode::DiscoveryFailed { domain, reason },
            }),
        };
        Ok(json!(result))
    }))
}

pub fn search_public_rooms(
    engine: Arc<Engine>,
    account_id: String,
    query: PublicRoomsQueryDto,
) -> Stream {
    request(engine, account_id, move |engine, rt| async move {
        let mut request = get_public_rooms_filtered::v3::Request::new();
        request.limit = Some(query.limit.into());
        request.since = query.since.filter(|since| !since.is_empty());
        request.filter.generic_search_term = query
            .term
            .map(|term| term.trim().to_owned())
            .filter(|term| !term.is_empty());
        if query.spaces == Some(true) {
            request.filter.room_types = vec![RoomTypeFilter::Space];
        }
        let rooms = rt.client.public_rooms_filtered(request);
        let response = engine.ruled(&rt, bounded(rooms)).await?;
        Ok(PublicRoomsPageDto {
            rooms: response
                .chunk
                .into_iter()
                .map(public_room_summary)
                .collect(),
            next_batch: response.next_batch,
            total: response.total_room_count_estimate.map(Into::into),
        })
    })
}

pub fn join_room(
    engine: Arc<Engine>,
    account_id: String,
    room_id_or_alias: String,
    via: Vec<String>,
) -> Stream {
    request(engine, account_id, move |engine, rt| async move {
        let target = <&RoomOrAliasId>::try_from(room_id_or_alias.as_str())?;
        let via = server_names(&via);
        let join = rt.client.join_room_by_id_or_alias(target, &via);
        let room = engine.ruled(&rt, bounded(join)).await?;
        Ok(json!({ "roomId": room.room_id() }))
    })
}

/// Uses the account's own copy of a room it is in, invited to, knocking on or banned from, and
/// the room summary otherwise.
pub fn preview_room(
    engine: Arc<Engine>,
    account_id: String,
    room_id_or_alias: String,
    via: Vec<String>,
) -> Stream {
    request(engine, account_id, move |engine, rt| async move {
        preview_room_link(&engine, &rt, &room_id_or_alias, via).await
    })
}

pub fn knock_room(
    engine: Arc<Engine>,
    account_id: String,
    room_id_or_alias: String,
    via: Vec<String>,
    reason: Option<String>,
) -> Stream {
    request(engine, account_id, move |engine, rt| async move {
        let target = OwnedRoomOrAliasId::try_from(room_id_or_alias)?;
        let knock = rt.client.knock(target, reason, server_names(&via));
        let room = engine.ruled(&rt, bounded(knock)).await?;
        Ok(json!({ "roomId": room.room_id() }))
    })
}

pub fn search_user_directory(
    engine: Arc<Engine>,
    account_id: String,
    term: String,
    limit: u64,
) -> Stream {
    request(engine, account_id, move |engine, rt| async move {
        let search = rt.client.search_users(&term, limit);
        let response = engine.ruled(&rt, bounded(search)).await?;
        let users = response
            .results
            .into_iter()
            .map(|user| DiscoveredUserDto {
                display_name: user
                    .display_name
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| user.user_id.to_string()),
                user_id: user.user_id.into(),
                avatar_mxc: user.avatar_url.map(Into::into),
            })
            .collect();
        Ok(UserDirectoryPageDto {
            users,
            limited: response.limited,
        })
    })
}

/// The adapter's `request`: the account is looked up when the stream is polled, and a failed
/// request is a `request-failed` value. Each request in `run` meets the token-death rule once: a
/// typed call through [`Engine::ruled`], cut off by `bounded`, and a raw one through `raw_get`.
fn request<T: Serialize, Fut>(
    engine: Arc<Engine>,
    account_id: String,
    run: impl FnOnce(Arc<Engine>, Arc<AccountRuntime>) -> Fut + SendOutsideWasm + 'static,
) -> Stream
where
    Fut: Future<Output = Result<T, Error>> + SendOutsideWasm,
{
    stream(stream::once(async move {
        let result = match engine.account(&account_id) {
            None => EngineResult::Err(not_signed_in()),
            Some(rt) => match run(engine, rt).await {
                Ok(value) => EngineResult::Ok(value),
                Err(error) => EngineResult::Err(request_failed(&error)),
            },
        };
        Ok(json!(result))
    }))
}

/// `AutoDiscovery.findClientConfig`'s `m.homeserver`: a missing well-known prompts for the
/// domain itself; a found one must name an http(s) homeserver with a supported version.
async fn discover_base_url(
    engine: &Engine,
    domain: &str,
) -> Result<String, Option<DiscoveryFailureReason>> {
    let server =
        <&ServerName>::try_from(domain).map_err(|_| Some(DiscoveryFailureReason::Invalid))?;
    let client = match engine.client_builder().server_name(server).build().await {
        Ok(client) => client,
        Err(error) if well_known_missing(&error) => return Ok(format!("https://{domain}")),
        Err(error) => return Err(discovery_reason(&error)),
    };
    let base_url = sanitize_base_url(&client.homeserver())
        .ok_or(Some(DiscoveryFailureReason::InvalidHsBaseUrl))?;
    let versions = client
        .fetch_server_versions(Some(RequestConfig::short_retry()))
        .await
        .map_err(|_| Some(DiscoveryFailureReason::InvalidHomeserver))?;
    if !versions
        .versions
        .iter()
        .any(|version| SUPPORTED_MATRIX_VERSIONS.contains(&version.as_str()))
    {
        return Err(Some(
            DiscoveryFailureReason::UnsupportedHomeserverSpecVersion,
        ));
    }
    Ok(base_url)
}

/// A 404 for the well-known, which `AutoDiscovery` ignores rather than fails.
fn well_known_missing(error: &ClientBuildError) -> bool {
    matches!(
        error,
        ClientBuildError::AutoDiscovery(error) if matches!(
            error.as_ref(),
            FromHttpResponseError::Server(RumaApiError::MatrixError(error))
                if error.status_code == 404
        )
    )
}

/// The `AutoDiscoveryError` the js adapter would report: any failed well-known request or
/// unusable body is `invalid`, and a `base_url` that is not a URL is `invalid-hs-base-url`.
fn discovery_reason(error: &ClientBuildError) -> Option<DiscoveryFailureReason> {
    match error {
        ClientBuildError::AutoDiscovery(_) | ClientBuildError::Http(_) => {
            Some(DiscoveryFailureReason::Invalid)
        }
        ClientBuildError::Url(_) => Some(DiscoveryFailureReason::InvalidHsBaseUrl),
        _ => None,
    }
}

/// `sanitizeWellKnownUrl`, then the adapter's trailing-slash trim: an http(s) origin and path.
fn sanitize_base_url(url: &Url) -> Option<String> {
    let host = url.host_str().filter(|host| !host.is_empty())?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    let base_url = format!("{}://{host}{port}{}", url.scheme(), url.path());
    Some(base_url.trim_end_matches('/').to_owned())
}

fn public_room_summary(chunk: PublicRoomsChunk) -> PublicRoomSummaryDto {
    let alias = chunk.canonical_alias.map(String::from);
    let room_id = chunk.room_id.to_string();
    PublicRoomSummaryDto {
        name: chunk
            .name
            .filter(|name| !name.is_empty())
            .or_else(|| alias.clone())
            .unwrap_or_else(|| room_id.clone()),
        topic: chunk.topic.filter(|topic| !topic.is_empty()),
        alias,
        avatar_mxc: chunk.avatar_url.map(Into::into),
        member_count: chunk.num_joined_members.into(),
        is_space: chunk.room_type == Some(RoomType::Space),
        room_id,
    }
}

/// The servers the SDK can route through: it takes only well-formed server names.
fn server_names(via: &[String]) -> Vec<OwnedServerName> {
    via.iter()
        .filter_map(|server| OwnedServerName::try_from(server.as_str()).ok())
        .collect()
}

/// `previewRoomLink`.
async fn preview_room_link(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    requested: &str,
    via: Vec<String>,
) -> Result<RoomLinkPreviewDataDto, Error> {
    let client = &rt.client;
    let local = local_room(client, requested);
    let local_membership = local
        .as_ref()
        .map_or(RoomLinkMembershipDto::Unknown, |room| {
            membership_of_state(room.state())
        });
    if let Some(room) = &local
        && !matches!(
            local_membership,
            RoomLinkMembershipDto::Leave | RoomLinkMembershipDto::Unknown
        )
    {
        let encrypted = if local_membership == RoomLinkMembershipDto::Join {
            // `isRoomEncrypted` fails safe to encrypted.
            bounded(room.latest_encryption_state())
                .await
                .map_or(true, |state| state.is_encrypted())
        } else {
            room.encryption_state().is_encrypted()
        };
        return Ok(from_local(room, local_membership, encrypted, via).await);
    }

    let mut room_id = requested.to_owned();
    let mut servers = normalize_via_servers(via.iter().map(String::as_str));
    if requested.starts_with('#') {
        let alias = <&RoomAliasId>::try_from(requested)?;
        let resolve = client.resolve_room_alias(alias);
        let directory = engine.ruled(rt, bounded(resolve)).await?;
        room_id = directory.room_id.to_string();
        let resolved = directory.servers.iter().map(|server| server.as_str());
        servers = normalize_via_servers(servers.iter().map(String::as_str).chain(resolved));
    }
    let summary = room_summary(engine, rt, &room_id, &servers).await?;
    Ok(from_remote(
        client,
        &summary,
        requested,
        servers,
        local.as_ref(),
        local_membership,
    ))
}

/// `localRoom`: by id, or by a canonical or alternative alias.
fn local_room(client: &Client, requested: &str) -> Option<Room> {
    if requested.starts_with('!') {
        return client.get_room(<&RoomId>::try_from(requested).ok()?);
    }
    client.rooms().into_iter().find(|room| {
        room.canonical_alias()
            .is_some_and(|alias| alias.as_str() == requested)
            || room
                .alt_aliases()
                .iter()
                .any(|alias| alias.as_str() == requested)
    })
}

/// `fromLocal`.
async fn from_local(
    room: &Room,
    membership: RoomLinkMembershipDto,
    encrypted: bool,
    via: Vec<String>,
) -> RoomLinkPreviewDataDto {
    let room_id = room.room_id().to_string();
    let canonical = room.canonical_alias().map(String::from);
    let name = room
        .display_name()
        .await
        .ok()
        .map(|name| name.to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| canonical.clone())
        .unwrap_or_else(|| room_id.clone());
    RoomLinkPreviewDataDto {
        canonical_address: canonical,
        name,
        topic: room.topic().filter(|topic| !topic.is_empty()),
        avatar_mxc: room.avatar_url().map(Into::into),
        member_count: Some(room.joined_members_count()),
        encrypted: Some(encrypted),
        join_rule: join_rule_of(room.join_rule().as_ref().map(|rule| rule.as_str())),
        membership,
        is_space: room.is_space(),
        via,
        restricted_eligible: false,
        room_id,
    }
}

/// `fromRemote`: every summary field read as leniently as the js adapter reads it.
fn from_remote(
    client: &Client,
    raw: &Value,
    requested: &str,
    via: Vec<String>,
    local: Option<&Room>,
    local_membership: RoomLinkMembershipDto,
) -> RoomLinkPreviewDataDto {
    let string = |key: &str| raw.get(key).and_then(Value::as_str).map(str::to_owned);
    let canonical = string("canonical_alias").or_else(|| {
        local
            .and_then(|room| room.canonical_alias())
            .map(String::from)
    });
    let room_id = string("room_id").unwrap_or_else(|| requested.to_owned());
    // `??`: a `null` falls through to the prefixed field as an absent one does.
    let encryption = raw
        .get("encryption")
        .filter(|value| !value.is_null())
        .or_else(|| raw.get("im.nheko.summary.encryption"));
    let restricted_eligible = raw
        .get("allowed_room_ids")
        .and_then(Value::as_array)
        .is_some_and(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .filter(|id| id.starts_with('!'))
                .any(|id| joined(client, id))
        });
    RoomLinkPreviewDataDto {
        name: string("name")
            .filter(|name| !name.is_empty())
            .or_else(|| canonical.clone().filter(|alias| !alias.is_empty()))
            .unwrap_or_else(|| room_id.clone()),
        canonical_address: canonical,
        topic: string("topic"),
        avatar_mxc: string("avatar_url"),
        member_count: raw.get("num_joined_members").and_then(Value::as_u64),
        encrypted: if encryption.is_some_and(Value::is_string) {
            Some(true)
        } else {
            local.map(|room| room.encryption_state().is_encrypted())
        },
        // Per the stable endpoint, an omitted join_rule means public.
        join_rule: match raw.get("join_rule") {
            None => RoomLinkJoinRuleDto::Public,
            Some(rule) => join_rule_of(rule.as_str()),
        },
        membership: if local_membership == RoomLinkMembershipDto::Unknown {
            membership_of(raw.get("membership").and_then(Value::as_str))
        } else {
            local_membership
        },
        is_space: raw.get("room_type").and_then(Value::as_str) == Some("m.space"),
        via,
        restricted_eligible,
        room_id,
    }
}

fn joined(client: &Client, room_id: &str) -> bool {
    <&RoomId>::try_from(room_id)
        .ok()
        .and_then(|room_id| client.get_room(room_id))
        .is_some_and(|room| room.state() == RoomState::Joined)
}

/// `roomSummary`: the stable endpoint, then MSC3266's for a server that does not recognise it.
async fn room_summary(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    room_id: &str,
    via: &[String],
) -> Result<Value, Error> {
    match get_client_json(engine, rt, &["v1", "room_summary", room_id], via).await {
        Err(Error::Http(error))
            if error.client_api_error_kind() == Some(&ErrorKind::Unrecognized) =>
        {
            let unstable = ["unstable", "im.nheko.summary", "summary", room_id];
            get_client_json(engine, rt, &unstable, via).await
        }
        result => result,
    }
}

/// An authenticated client API GET, as `client.http.authedRequest` sends it: the JSON body of
/// a 2xx answer, or the error the SDK would have made of the answer.
async fn get_client_json(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    path: &[&str],
    via: &[String],
) -> Result<Value, Error> {
    let mut url = rt.client.homeserver();
    url.path_segments_mut()
        // Only a homeserver URL that cannot be a base has no path, and no request reaches it.
        .map_err(|()| Error::InsufficientData)?
        .pop_if_empty()
        .extend(["_matrix", "client"])
        .extend(path);
    if !via.is_empty() {
        url.query_pairs_mut()
            .extend_pairs(via.iter().map(|server| ("via", server)));
    }
    let body = raw_get(engine, rt, url, SUMMARY_TIMEOUT).await?;
    serde_json::from_slice(&body)
        .map_err(|error| HttpError::from(FromHttpResponseError::<RumaApiError>::from(error)).into())
}

/// `normalizeViaServers`: at most three distinct, valid routing servers.
fn normalize_via_servers<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut via: Vec<String> = Vec::new();
    for server in values {
        if is_valid_server_name(server) && !via.iter().any(|known| known == server) {
            via.push(server.to_owned());
            if via.len() == MAX_VIA_SERVERS {
                break;
            }
        }
    }
    via
}

/// `isValidServerName`: DNS labels, or a bracketed IPv6 address, with an optional port of 1 to
/// 65535 without leading zeros.
fn is_valid_server_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 255 || value.trim() != value {
        return false;
    }
    let (host, port) = match value.rsplit_once(':') {
        Some((host, port)) if !port.contains(']') => (host, Some(port)),
        _ => (value, None),
    };
    let port_ok = port.is_none_or(|port| {
        !port.starts_with('0')
            && port.len() <= 5
            && port.bytes().all(|byte| byte.is_ascii_digit())
            && port.parse::<u32>().is_ok_and(|port| port <= 65535)
    });
    if !port_ok {
        return false;
    }
    if let Some(address) = host.strip_prefix('[') {
        return address
            .strip_suffix(']')
            .is_some_and(|address| address.parse::<Ipv6Addr>().is_ok());
    }
    host.split('.').all(|label| {
        let bytes = label.as_bytes();
        (1..=63).contains(&bytes.len())
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

fn membership_of_state(state: RoomState) -> RoomLinkMembershipDto {
    match state {
        RoomState::Joined => RoomLinkMembershipDto::Join,
        RoomState::Invited => RoomLinkMembershipDto::Invite,
        RoomState::Knocked => RoomLinkMembershipDto::Knock,
        RoomState::Banned => RoomLinkMembershipDto::Ban,
        RoomState::Left => RoomLinkMembershipDto::Leave,
    }
}

/// `membershipOf`.
fn membership_of(value: Option<&str>) -> RoomLinkMembershipDto {
    match value {
        Some("join") => RoomLinkMembershipDto::Join,
        Some("invite") => RoomLinkMembershipDto::Invite,
        Some("knock") => RoomLinkMembershipDto::Knock,
        Some("ban") => RoomLinkMembershipDto::Ban,
        Some("leave") => RoomLinkMembershipDto::Leave,
        _ => RoomLinkMembershipDto::Unknown,
    }
}

/// `joinRuleOf`.
fn join_rule_of(value: Option<&str>) -> RoomLinkJoinRuleDto {
    match value {
        Some("public") => RoomLinkJoinRuleDto::Public,
        Some("knock") => RoomLinkJoinRuleDto::Knock,
        Some("knock_restricted") => RoomLinkJoinRuleDto::KnockRestricted,
        Some("restricted") => RoomLinkJoinRuleDto::Restricted,
        Some("invite") => RoomLinkJoinRuleDto::Invite,
        Some("private") => RoomLinkJoinRuleDto::Private,
        _ => RoomLinkJoinRuleDto::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use futures_util::StreamExt;
    use matrix_sdk::ruma::{api::EndpointError, exports::http};

    use super::*;
    use crate::{config::EngineConfig, dispatch::dispatch};

    fn chunk(name: Option<&str>, alias: Option<&str>) -> PublicRoomsChunk {
        serde_json::from_value(json!({
            "room_id": "!r:hs",
            "name": name,
            "canonical_alias": alias,
            "num_joined_members": 3,
            "world_readable": false,
            "guest_can_join": false,
        }))
        .unwrap()
    }

    #[test]
    fn public_room_summary_name_falls_back_to_alias_then_id() {
        assert_eq!(
            public_room_summary(chunk(Some("Room"), Some("#a:hs"))).name,
            "Room"
        );
        assert_eq!(
            public_room_summary(chunk(Some(""), Some("#a:hs"))).name,
            "#a:hs"
        );
        assert_eq!(public_room_summary(chunk(None, None)).name, "!r:hs");
    }

    #[test]
    fn query_decodes_without_optional_fields() {
        for query in [
            json!({"limit": 5}),
            json!({"limit": 5, "term": null, "since": null, "spaces": null}),
        ] {
            let query: PublicRoomsQueryDto = serde_json::from_value(query).unwrap();
            assert_eq!(
                (query.term, query.since, query.spaces, query.limit),
                (None, None, None, 5)
            );
        }
    }

    fn status(code: u16) -> ClientBuildError {
        let response = http::Response::builder()
            .status(code)
            .body(&b"{}"[..])
            .unwrap();
        ClientBuildError::AutoDiscovery(Box::new(FromHttpResponseError::Server(
            RumaApiError::from_http_response(response),
        )))
    }

    #[test]
    fn discovery_reason_maps_build_errors() {
        let malformed = serde_json::from_str::<()>("x").unwrap_err();
        let undecodable = ClientBuildError::AutoDiscovery(Box::new(malformed.into()));
        let unparsable = ClientBuildError::Url(Url::parse("no base url").unwrap_err());
        let http = match status(500) {
            ClientBuildError::AutoDiscovery(error) => ClientBuildError::Http((*error).into()),
            _ => unreachable!(),
        };
        let cases = [
            (status(500), Some(DiscoveryFailureReason::Invalid)),
            (undecodable, Some(DiscoveryFailureReason::Invalid)),
            (http, Some(DiscoveryFailureReason::Invalid)),
            (unparsable, Some(DiscoveryFailureReason::InvalidHsBaseUrl)),
            (ClientBuildError::MissingHomeserver, None),
            (ClientBuildError::WellKnownLookupDisabled, None),
        ];
        for (error, reason) in cases {
            assert_eq!(discovery_reason(&error), reason, "{error:?}");
        }
        assert!(well_known_missing(&status(404)));
        assert!(!well_known_missing(&status(500)));
    }

    #[tokio::test]
    async fn account_members_fail_not_signed_in_without_a_session() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let nobody = json!("@nobody:invalid");
        let calls = [
            (
                "discovery.searchPublicRooms",
                vec![nobody.clone(), json!({"limit": 30})],
            ),
            (
                "discovery.joinRoom",
                vec![nobody.clone(), json!("#a:invalid"), json!([])],
            ),
            (
                "discovery.previewRoom",
                vec![nobody.clone(), json!("#a:invalid"), json!([])],
            ),
            (
                "discovery.knockRoom",
                vec![nobody.clone(), json!("#a:invalid"), json!([]), json!(null)],
            ),
            (
                "discovery.searchUserDirectory",
                vec![nobody.clone(), json!("a"), json!(30)],
            ),
        ];
        let expected = json!({"ok": false, "failure": not_signed_in()});
        for (method, args) in calls {
            let values: Vec<_> = dispatch(&engine, method, args).unwrap().collect().await;
            assert_eq!(values, vec![Ok(expected.clone())], "{method}");
        }
    }

    #[test]
    fn server_names_are_validated_deduplicated_and_capped() {
        for valid in [
            "hs",
            "example.org:1",
            "example.org:65535",
            "[::1]:8448",
            "1.2.3.4:80",
        ] {
            assert!(is_valid_server_name(valid), "{valid}");
        }
        for invalid in [
            "example.org:",
            "example.org:0",
            "example.org:08448",
            "example.org:65536",
            "example.org:123456",
            "[::1]:",
            "[::1]:0443",
            "[zz]",
            "-a.example",
            "a..example",
            "user@example.org",
            " example.org",
            "",
        ] {
            assert!(!is_valid_server_name(invalid), "{invalid}");
        }
        let via = normalize_via_servers([
            "one.example",
            "bad/path",
            "one.example",
            "two.example:8448",
            "[::1]:8448",
            "ignored.example",
        ]);
        assert_eq!(via, ["one.example", "two.example:8448", "[::1]:8448"]);
    }

    #[test]
    fn a_base_url_keeps_only_an_http_origin_and_path() {
        let sanitize = |url: &str| sanitize_base_url(&Url::parse(url).unwrap());
        assert_eq!(
            sanitize("https://user@hs.example:8448/matrix/?q#f").as_deref(),
            Some("https://hs.example:8448/matrix")
        );
        assert_eq!(
            sanitize("https://hs.example:443/").as_deref(),
            Some("https://hs.example")
        );
        assert_eq!(sanitize("ftp://hs.example"), None);
    }

    #[tokio::test]
    async fn a_remote_preview_reads_the_summary_leniently() {
        let client = Client::builder()
            .homeserver_url("http://127.0.0.1:1")
            .build()
            .await
            .unwrap();
        let preview = |raw: Value| {
            from_remote(
                &client,
                &raw,
                "#a:hs",
                vec!["hs".into()],
                None,
                RoomLinkMembershipDto::Unknown,
            )
        };
        let bare = preview(json!({"room_id": "!r:hs", "name": "", "num_joined_members": 2}));
        assert_eq!(
            bare,
            RoomLinkPreviewDataDto {
                room_id: "!r:hs".into(),
                canonical_address: None,
                name: "!r:hs".into(),
                topic: None,
                avatar_mxc: None,
                member_count: Some(2),
                encrypted: None,
                join_rule: RoomLinkJoinRuleDto::Public,
                membership: RoomLinkMembershipDto::Unknown,
                is_space: false,
                via: vec!["hs".into()],
                restricted_eligible: false,
            }
        );
        let full = preview(json!({
            "canonical_alias": "#a:hs",
            "topic": "",
            "join_rule": "knock_restricted",
            "allowed_room_ids": ["!other:hs"],
            "membership": "leave",
            "room_type": "m.space",
            "encryption": null,
            "im.nheko.summary.encryption": "m.megolm.v1.aes-sha2",
            "num_joined_members": "2",
        }));
        assert_eq!(
            (
                full.room_id.as_str(),
                full.name.as_str(),
                full.topic.as_deref()
            ),
            ("#a:hs", "#a:hs", Some(""))
        );
        assert_eq!(full.encrypted, Some(true));
        assert_eq!(full.member_count, None);
        assert_eq!(full.join_rule, RoomLinkJoinRuleDto::KnockRestricted);
        assert_eq!(full.membership, RoomLinkMembershipDto::Leave);
        assert!(full.is_space && !full.restricted_eligible);
        assert_eq!(
            preview(json!({"join_rule": null})).join_rule,
            RoomLinkJoinRuleDto::Unknown
        );
    }
}
