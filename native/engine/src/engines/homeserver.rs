//! `HomeserverEngine` (`libs/data-access/homeserver/src/lib/homeserver-engine.ts`), field by field
//! as its js-sdk adapter and `probe-homeserver.ts` derive each value.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use futures_util::{future::join, stream};
use matrix_sdk::reqwest::Url;
use serde::Serialize;
use serde_json::{Value, json};
use ts_rs::TS;

use crate::{
    accounts::{AccountRuntime, Engine},
    dispatch::{Stream, stream},
    engines::session::logout::raw_get,
};

const DTO: &str = "data-access/homeserver/src/lib/rust-dto/";
/// Per request, as `TIMEOUT_MS` in `probe-homeserver.ts`.
const TIMEOUT: Duration = Duration::from_secs(8);
const FEDERATION_VERSION_PATH: &str = "/_matrix/federation/v1/version";

/// `HomeserverProbe`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct HomeserverProbeDto {
    server_name: String,
    base_url: String,
    software: Option<ServerSoftwareDto>,
    spec_versions: Option<Vec<String>>,
    unstable_features: Option<Vec<String>>,
    capabilities: Option<HomeserverCapabilitiesDto>,
}

/// `ServerSoftware`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct ServerSoftwareDto {
    name: String,
    version: String,
    source: SoftwareSourceDto,
    host: String,
}

/// `SoftwareSource`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = DTO)]
pub enum SoftwareSourceDto {
    BaseUrl,
    Delegated,
}

/// `HomeserverCapabilities`.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = DTO)]
pub struct HomeserverCapabilitiesDto {
    default_room_version: Option<String>,
    room_versions: Option<BTreeMap<String, RoomVersionStabilityDto>>,
    can_change_password: Option<bool>,
}

/// `RoomVersionStability`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = DTO)]
pub enum RoomVersionStabilityDto {
    Stable,
    Unstable,
}

/// Emits the account's `HomeserverProbeDto` once, or `null` without one. Never fails: a remote
/// field that got no usable answer is `null`.
pub fn probe(engine: Arc<Engine>, account_id: String) -> Stream {
    stream(stream::once(async move {
        let probe = match engine.account(&account_id) {
            Some(rt) => Some(probe_client(&engine, rt, &account_id).await),
            None => None,
        };
        Ok(json!(probe))
    }))
}

/// Holds `rt` only for the requests that carry its token: the software probe asks other hosts,
/// for up to three requests of 8 s, and a teardown need not wait for it.
async fn probe_client(
    engine: &Arc<Engine>,
    rt: Arc<AccountRuntime>,
    account_id: &str,
) -> HomeserverProbeDto {
    let client = &rt.client;
    let base_url = client
        .homeserver()
        .as_str()
        .trim_end_matches('/')
        .to_owned();
    let server_name = match client.user_id() {
        Some(user_id) => user_id.server_name().to_string(),
        None => account_id
            .split_once(':')
            .map_or(account_id, |(_, server)| server)
            .to_owned(),
    };
    let base = base_url.as_str();
    let authed = async move {
        let rt = rt;
        join(
            fetch_spec_versions(engine, &rt, base),
            fetch_capabilities(engine, &rt, base),
        )
        .await
    };
    let software = probe_server_software(engine, base, &server_name);
    let (software, (versions, capabilities)) = join(software, authed).await;
    let (spec_versions, unstable_features) = versions.unzip();
    HomeserverProbeDto {
        server_name,
        base_url,
        software,
        spec_versions,
        unstable_features,
        capabilities,
    }
}

/// `probeServerSoftware`: the base URL's origin first, then the federation host its server
/// name's `.well-known/matrix/server` delegates to.
async fn probe_server_software(
    engine: &Engine,
    base_url: &str,
    server_name: &str,
) -> Option<ServerSoftwareDto> {
    let tried = safe_url(base_url).map(|url| url.origin().ascii_serialization());
    if let Some(direct) =
        fetch_federation_version(engine, base_url, SoftwareSourceDto::BaseUrl).await
    {
        return Some(direct);
    }
    let origin = federation_origin(server_name)?;
    let well_known = safe_url(&format!("{origin}/.well-known/matrix/server"))?;
    let body = get_json(engine, well_known).await?;
    let federation = federation_origin(&read_string(&body, "m.server")?)?;
    if tried.as_ref() == Some(&federation) {
        return None;
    }
    fetch_federation_version(engine, &federation, SoftwareSourceDto::Delegated).await
}

async fn fetch_federation_version(
    engine: &Engine,
    origin: &str,
    source: SoftwareSourceDto,
) -> Option<ServerSoftwareDto> {
    // Resolved, not concatenated: the federation API is served at the root.
    let url = Url::parse(origin)
        .and_then(|base| base.join(FEDERATION_VERSION_PATH))
        .ok()
        .filter(is_https)?;
    let host = url.origin().ascii_serialization();
    to_software(&get_json(engine, url).await?, source, host)
}

/// `fetchSpecVersions`: a raw request, since the SDK caches `server_versions()`.
async fn fetch_spec_versions(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    base_url: &str,
) -> Option<(Vec<String>, Vec<String>)> {
    let url = client_api_url(base_url, "/_matrix/client/versions")?;
    let body = get_account_json(engine, rt, url).await?;
    let versions = read_string_array(&body, "versions")?;
    Some((versions, enabled_flags(&body)))
}

/// `fetchCapabilities`: raw, since the typed response reads an absent capability as its default.
async fn fetch_capabilities(
    engine: &Arc<Engine>,
    rt: &AccountRuntime,
    base_url: &str,
) -> Option<HomeserverCapabilitiesDto> {
    let url = client_api_url(base_url, "/_matrix/client/v3/capabilities")?;
    to_capabilities(&get_account_json(engine, rt, url).await?)
}

/// `getJson`: the JSON body of a 2xx answer, `None` on any failure, a redirect included.
async fn get_json(engine: &Engine, url: Url) -> Option<Value> {
    let (status, body) = engine.raw_get(url, None, TIMEOUT).await.ok()?;
    if !status.is_success() {
        return None;
    }
    serde_json::from_slice(&body).ok()
}

/// [`get_json`] with the account's token, which goes only to its own base URL.
async fn get_account_json(engine: &Arc<Engine>, rt: &AccountRuntime, url: Url) -> Option<Value> {
    let body = raw_get(engine, rt, url, TIMEOUT).await.ok()?;
    serde_json::from_slice(&body).ok()
}

/// `clientApiUrl`: concatenated, so a base URL's path is kept.
fn client_api_url(base_url: &str, path: &str) -> Option<Url> {
    safe_url(&format!("{}{path}", base_url.trim_end_matches('/')))
}

/// `safeUrl`: `https://` URLs only.
fn safe_url(input: &str) -> Option<Url> {
    Url::parse(input).ok().filter(is_https)
}

fn is_https(url: &Url) -> bool {
    url.scheme() == "https"
}

/// `federationOrigin`: the origin of a bare `host` or `host:port`, which `m.server` must be.
fn federation_origin(m_server: &str) -> Option<String> {
    let url = safe_url(&format!("https://{m_server}"))?;
    let bare = url.path() == "/"
        && url.query().is_none_or(str::is_empty)
        && url.fragment().is_none_or(str::is_empty)
        && url.username().is_empty()
        && url.password().is_none();
    bare.then(|| url.origin().ascii_serialization())
}

/// `toSoftware`: both the name and the version, or nothing.
fn to_software(body: &Value, source: SoftwareSourceDto, host: String) -> Option<ServerSoftwareDto> {
    let server = record(body, "server")?;
    Some(ServerSoftwareDto {
        name: read_string(server, "name")?,
        version: read_string(server, "version")?,
        source,
        host,
    })
}

/// `toCapabilities`: `None` for anything the server did not state.
fn to_capabilities(body: &Value) -> Option<HomeserverCapabilitiesDto> {
    let capabilities = record(body, "capabilities")?;
    let room_versions = record(capabilities, "m.room_versions");
    let info = HomeserverCapabilitiesDto {
        default_room_version: room_versions.and_then(|versions| read_string(versions, "default")),
        room_versions: room_versions.and_then(read_room_versions),
        can_change_password: record(capabilities, "m.change_password")
            .and_then(|change| change.get("enabled")?.as_bool()),
    };
    let stated = info.default_room_version.is_some()
        || info.room_versions.is_some()
        || info.can_change_password.is_some();
    stated.then_some(info)
}

/// `readRoomVersions`: only the versions labelled `stable` or `unstable`.
fn read_room_versions(room_versions: &Value) -> Option<BTreeMap<String, RoomVersionStabilityDto>> {
    let available = record(room_versions, "available")?.as_object()?;
    let known: BTreeMap<_, _> = available
        .iter()
        .filter_map(|(version, stability)| {
            let stability = match stability.as_str()? {
                "stable" => RoomVersionStabilityDto::Stable,
                "unstable" => RoomVersionStabilityDto::Unstable,
                _ => return None,
            };
            Some((version.clone(), stability))
        })
        .collect();
    (!known.is_empty()).then_some(known)
}

/// `readEnabledFlags`: the flags set to `true`, sorted.
fn enabled_flags(body: &Value) -> Vec<String> {
    let Some(flags) = record(body, "unstable_features").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut enabled: Vec<String> = flags
        .iter()
        .filter(|(_, on)| **on == Value::Bool(true))
        .map(|(flag, _)| flag.clone())
        .collect();
    enabled.sort();
    enabled
}

fn record<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|nested| nested.is_object())
}

/// `readString`: trimmed, and `None` when empty.
fn read_string(value: &Value, key: &str) -> Option<String> {
    let trimmed = value.get(key)?.as_str()?.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `readStringArray`: the strings, and `None` when there are none.
fn read_string_array(value: &Value, key: &str) -> Option<Vec<String>> {
    let strings: Vec<String> = value
        .get(key)?
        .as_array()?
        .iter()
        .filter_map(|item| item.as_str().map(Into::into))
        .collect();
    (!strings.is_empty()).then_some(strings)
}

#[cfg(test)]
mod tests {
    use futures_util::{FutureExt, StreamExt};
    use matrix_sdk::{sleep::sleep, timeout::timeout};
    use tempfile::TempDir;

    use super::*;
    use crate::{
        config::EngineConfig,
        dispatch::dispatch,
        testing::{builder_on, engine_in, live, requests, scripted, session},
    };

    const OFFLINE: &str = "http://127.0.0.1:1";

    #[tokio::test]
    async fn a_redirect_is_no_answer_and_is_not_followed() {
        const REDIRECT: &str = "GET /redirect";
        let target = ("GET /target", 200, json!({}));
        let (base, seen) = scripted(vec![(REDIRECT, 302, json!("/target")), target]);
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let url = Url::parse(&format!("{base}/redirect")).unwrap();
        assert_eq!(get_json(&engine, url).await, None);
        assert_eq!(requests(&seen), [(REDIRECT.to_owned(), None)]);
    }

    /// The software probe asks other hosts and never needs the account, so a remove during it
    /// waits for none of it.
    #[tokio::test]
    async fn a_probe_lets_go_of_the_account_before_the_software_probe() {
        // An https host that accepts and never answers, which the account's server name names.
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let user_id = format!("@a:{}", silent.local_addr().unwrap());
        let root = TempDir::new().unwrap();
        let engine = engine_in(&root);
        let client = builder_on(OFFLINE).build().await.unwrap();
        let held = Arc::downgrade(&live(&engine, &session(&user_id, OFFLINE), client).await);
        let mut probing = probe(Arc::clone(&engine), user_id.clone());
        // Past the first poll the engine holds the runtime, and the authed half until its
        // refused connects fail.
        let authed_ended = timeout(
            async {
                loop {
                    let polled = probing.next().now_or_never();
                    assert!(polled.is_none(), "the software probe waits");
                    if held.strong_count() == 1 {
                        break;
                    }
                    sleep(Duration::from_millis(10)).await;
                }
            },
            Duration::from_secs(2),
        );
        assert!(authed_ended.await.is_ok(), "the authed half never ended");
        let removed = timeout(engine.remove(&user_id), Duration::from_secs(2)).await;
        assert!(removed.is_ok(), "the remove waited for the software probe");
    }

    #[tokio::test]
    async fn probe_emits_null_for_an_account_with_no_session() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let values: Vec<_> = dispatch(&engine, "homeserver.probe", vec![json!("@a:b")])
            .unwrap()
            .collect()
            .await;
        assert_eq!(values, vec![Ok(json!(null))]);
    }

    #[test]
    fn capabilities_keep_null_for_what_the_server_did_not_state() {
        let body = json!({"capabilities": {"m.room_versions": {
            "default": " 10\n",
            "available": {"10": "stable", "org.example": "unstable", "x": "beta", "y": 1},
        }}});
        assert_eq!(
            to_capabilities(&body),
            Some(HomeserverCapabilitiesDto {
                default_room_version: Some("10".into()),
                room_versions: Some(BTreeMap::from([
                    ("10".into(), RoomVersionStabilityDto::Stable),
                    ("org.example".into(), RoomVersionStabilityDto::Unstable),
                ])),
                can_change_password: None,
            })
        );
        let password = json!({"capabilities": {"m.change_password": {"enabled": false}}});
        assert_eq!(
            to_capabilities(&password).unwrap().can_change_password,
            Some(false)
        );
        assert_eq!(
            to_capabilities(&json!({"capabilities": {"m.other": {}}})),
            None
        );
        assert_eq!(to_capabilities(&json!({})), None);
    }

    #[test]
    fn spec_versions_keep_strings_and_flags_only_the_enabled_ones() {
        let body = json!({
            "versions": ["v1.1", 2, "r0.6.1"],
            "unstable_features": {"b": true, "a": true, "c": false, "d": "true"},
        });
        assert_eq!(
            read_string_array(&body, "versions"),
            Some(vec!["v1.1".into(), "r0.6.1".into()])
        );
        assert_eq!(enabled_flags(&body), vec!["a", "b"]);
        assert_eq!(
            read_string_array(&json!({"versions": [1]}), "versions"),
            None
        );
        assert!(enabled_flags(&json!({})).is_empty());
    }

    #[test]
    fn software_needs_a_name_and_a_version() {
        let software = |body| to_software(&body, SoftwareSourceDto::BaseUrl, "https://h".into());
        assert_eq!(
            software(json!({"server": {"name": "Synapse", "version": "1.161.0\n"}})),
            Some(ServerSoftwareDto {
                name: "Synapse".into(),
                version: "1.161.0".into(),
                source: SoftwareSourceDto::BaseUrl,
                host: "https://h".into(),
            })
        );
        assert_eq!(
            software(json!({"server": {"name": "Synapse", "version": " "}})),
            None
        );
        assert_eq!(software(json!({"server": "Synapse"})), None);
    }

    #[test]
    fn federation_origin_takes_only_a_bare_host() {
        assert_eq!(
            federation_origin("example.org").as_deref(),
            Some("https://example.org")
        );
        assert_eq!(
            federation_origin("example.org:443").as_deref(),
            Some("https://example.org")
        );
        assert_eq!(
            federation_origin("example.org:8448").as_deref(),
            Some("https://example.org:8448")
        );
        for rejected in [
            "http://evil.example",
            "good.example@evil.example",
            "example.org/path",
            "example.org?q",
            "",
        ] {
            assert_eq!(federation_origin(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn only_https_urls_are_requested() {
        assert!(
            client_api_url("https://example.org/matrix/", "/_matrix/client/versions").is_some_and(
                |url| url.as_str() == "https://example.org/matrix/_matrix/client/versions"
            )
        );
        assert_eq!(
            client_api_url("http://example.org", "/_matrix/client/versions"),
            None
        );
    }
}
