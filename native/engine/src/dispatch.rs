//! Routes an `"engine.member"` call with positional args to the engine method that serves it.

use std::{any::type_name, fmt};

use futures_util::stream;
use matrix_sdk::{SendOutsideWasm, executor::spawn};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{
    engines::{contact_addresses, discovery, homeserver, identity, room_list, session},
    wire::{Fault, FaultCode},
};

/// An engine method's output: a `BoxStream`, but a `LocalBoxStream` on wasm, where the SDK's
/// futures and `Client` are not `Send`. [`stream`] is the one place that asks for `Send`, and only
/// outside wasm. The carrier runs it with `matrix_sdk::executor::spawn`, which also needs `Send`
/// only outside wasm, so nothing else ties an engine method to `Send`.
pub type Stream = matrix_sdk::stream::BoxStream<'static, Result<Value, Fault>>;

/// Boxes `s` as a [`Stream`].
pub fn stream(
    s: impl futures_util::Stream<Item = Result<Value, Fault>> + SendOutsideWasm + 'static,
) -> Stream {
    matrix_sdk::stream::StreamExt::boxed(s)
}

/// `value` as a stream item. A value that is no JSON, such as a map with non-string keys, is a
/// fault rather than a panic.
pub(crate) fn item(value: impl Serialize) -> Result<Value, Fault> {
    serde_json::to_value(value)
        .map_err(|_| Fault::new(FaultCode::SerializeFailed, "a value did not serialize"))
}

/// A command: emits `value` once, then completes; a close drops the work.
pub fn reply<T: Serialize>(value: impl Future<Output = T> + SendOutsideWasm + 'static) -> Stream {
    stream(stream::once(async move { item(value.await) }))
}

/// A command whose work outlives a close or an `attach`: `value` runs on its own task, spawned at
/// dispatch, and a close drops only the wait for it. A panic in it is a `panic` fault (kind
/// internal). A `value` that holds the account, as `detached(on_account(..))` does, still delays
/// the account's teardown after a close, so it must end within the teardown's `HOLDER_LIMIT`.
pub fn detached<T: Serialize + SendOutsideWasm + 'static>(
    value: impl Future<Output = T> + SendOutsideWasm + 'static,
) -> Stream {
    // A dropped `JoinHandle` lets its task run on, natively and on wasm.
    let task = spawn(value);
    stream(stream::once(async move {
        let value = (task.await)
            .map_err(|_| Fault::new(FaultCode::Panic, "a detached command panicked"))?;
        item(value)
    }))
}

/// Defines `dispatch` over `"engine.member" => function(arg: Type, ..)` entries. Each function
/// takes the engine, then the decoded positional args, and returns a [`Stream`].
macro_rules! methods {
    ($($name:literal => $($serve:ident)::+ ( $($arg:ident : $ty:ty),* $(,)? )),* $(,)?) => {
        pub(crate) fn dispatch(
            engine: &std::sync::Arc<$crate::accounts::Engine>,
            method: &str,
            args: Vec<serde_json::Value>,
        ) -> Result<$crate::dispatch::Stream, $crate::wire::Fault> {
            match method {
                $($name => {
                    let args = &mut $crate::dispatch::Args::new(method, args);
                    $(let $arg: $ty = args.decode()?;)*
                    args.finish()?;
                    Ok($($serve)::+(std::sync::Arc::clone(engine), $($arg),*))
                })*
                _ => {
                    let _ = (engine, args);
                    Err($crate::wire::Fault::new(
                        $crate::wire::FaultCode::UnknownMethod,
                        format!("no method {method}"),
                    ))
                }
            }
        }
    };
}

methods! {
    "contactAddresses.threePids" => contact_addresses::three_pids(account_id: String),
    "contactAddresses.requestAddEmailToken" => contact_addresses::request_add_email_token(
        account_id: String,
        request: contact_addresses::AddEmailTokenRequestDto,
    ),
    "contactAddresses.addThreePid" => contact_addresses::add_three_pid(
        account_id: String,
        request: contact_addresses::AddThreePidRequestDto,
        auth: Option<session::UiaAuthDto>,
    ),
    "contactAddresses.deleteThreePid" => contact_addresses::delete_three_pid(
        account_id: String,
        medium: String,
        address: String,
    ),
    "contactAddresses.identityServerSetting" => contact_addresses::identity_server_setting(
        account_id: String,
    ),
    "contactAddresses.setIdentityServer" => contact_addresses::set_identity_server(
        account_id: String,
        base_url: Option<String>,
    ),
    "contactAddresses.acceptedTerms" => contact_addresses::accepted_terms(account_id: String),
    "contactAddresses.setAcceptedTerms" => contact_addresses::set_accepted_terms(
        account_id: String,
        urls: Vec<String>,
    ),
    "contactAddresses.openIdToken" => contact_addresses::open_id_token(account_id: String),
    "contactAddresses.bindThreePid" => contact_addresses::bind_three_pid(
        account_id: String,
        request: contact_addresses::BindThreePidRequestDto,
    ),
    "contactAddresses.unbindThreePid" => contact_addresses::unbind_three_pid(
        account_id: String,
        request: contact_addresses::UnbindThreePidRequestDto,
    ),
    "discovery.discover" => discovery::discover(domain: String),
    "discovery.searchPublicRooms" => discovery::search_public_rooms(
        account_id: String,
        query: discovery::PublicRoomsQueryDto,
    ),
    "discovery.joinRoom" => discovery::join_room(
        account_id: String,
        room_id_or_alias: String,
        via: Vec<String>,
    ),
    "discovery.previewRoom" => discovery::preview_room(
        account_id: String,
        room_id_or_alias: String,
        via: Vec<String>,
    ),
    "discovery.knockRoom" => discovery::knock_room(
        account_id: String,
        room_id_or_alias: String,
        via: Vec<String>,
        reason: Option<String>,
    ),
    "discovery.searchUserDirectory" => discovery::search_user_directory(
        account_id: String,
        term: String,
        limit: u64,
    ),
    "homeserver.probe" => homeserver::probe(account_id: String),
    "identity.ownProfile" => identity::own_profile(account_id: String),
    "identity.profile" => identity::profile(account_id: String, user_id: String),
    "identity.setDisplayName" => identity::set_display_name(account_id: String, name: String),
    "identity.setAvatar" => identity::set_avatar(account_id: String, mxc: String),
    "identity.presence" => identity::presence(account_id: String),
    "identity.ownPresence" => identity::own_presence(account_id: String),
    "identity.setPresence" => identity::set_presence(
        account_id: String,
        presence: identity::PresenceStateDto,
        status_message: Option<String>,
    ),
    "identity.ignoredUsers" => identity::ignored_users(account_id: String),
    "identity.setIgnored" => identity::set_ignored(
        account_id: String,
        user_id: String,
        ignored: bool,
    ),
    "roomList.directMap" => room_list::typing::direct_map(account_id: String),
    "roomList.rooms" => room_list::rows::rooms(account_id: String),
    "roomList.typing" => room_list::typing::typing(account_id: String),
    "roomList.setTag" => room_list::commands::set_tag(
        account_id: String,
        room_id: String,
        tag: room_list::RoomTagDto,
        on: bool,
    ),
    "roomList.setMarkedUnread" => room_list::commands::set_marked_unread(
        account_id: String,
        room_id: String,
        unread: bool,
    ),
    "roomList.markRead" => room_list::commands::mark_read(
        account_id: String,
        room_id: String,
        receipts: room_list::ReceiptsDto,
    ),
    "roomList.leave" => room_list::commands::leave(account_id: String, room_id: String),
    "roomList.createRoom" => room_list::commands::create_room(
        account_id: String,
        request: room_list::CreateRoomRequestDto,
    ),
    "roomList.createDirectMessage" => room_list::commands::create_direct_message(
        account_id: String,
        user_id: String,
    ),
    "roomList.resolveAlias" => room_list::commands::resolve_alias(
        account_id: String,
        alias: String,
    ),
    "roomList.invite" => room_list::commands::invite(
        account_id: String,
        room_id: String,
        user_id: String,
    ),
    "roomList.join" => room_list::commands::join(
        account_id: String,
        room_id_or_alias: String,
        via: Vec<String>,
    ),
    "roomList.spaceChildLinks" => room_list::spaces::space_child_links(
        account_id: String,
        space_id: String,
    ),
    "roomList.spaceHierarchy" => room_list::spaces::space_hierarchy(
        account_id: String,
        space_id: String,
        options: room_list::HierarchyOptionsDto,
    ),
    "roomList.setSpaceChild" => room_list::spaces::set_space_child(
        account_id: String,
        space_id: String,
        child_id: String,
        link: Option<room_list::SpaceChildLinkInputDto>,
    ),
    "roomList.setSpaceParent" => room_list::spaces::set_space_parent(
        account_id: String,
        child_id: String,
        space_id: String,
        via: Vec<String>,
    ),
    "roomList.inviteBlocking" => room_list::invites::invite_blocking(account_id: String),
    "roomList.setInviteBlocking" => room_list::invites::set_invite_blocking(
        account_id: String,
        blocked: bool,
    ),
    "roomList.roomsInCommon" => room_list::invites::rooms_in_common(
        account_id: String,
        user_id: String,
    ),
    "session.session" => session::session(),
    "session.restorePersisted" => session::restore_persisted(
        session: session::MatrixSessionDto,
        activation: session::PersistedAccountActivationDto,
    ),
    "session.setActive" => session::set_active(account_id: String),
    "session.activateAccount" => session::activate_account(
        account_id: String,
        live_accounts: session::LiveAccountsDto,
    ),
    "session.requireReauthentication" => session::require_reauthentication(account_id: String),
    "session.rollbackAccountStart" => session::rollback_account_start(account_id: String),
    "session.remove" => session::remove(account_id: String),
    "session.stop" => session::stop(),
    "session.accessToken" => session::reads::access_token(account_id: String),
    "session.liveCredentials" => session::reads::live_credentials(account_id: String),
    "session.accountStatus" => session::reads::account_status(account_id: String),
    "session.refreshAccessToken" => session::reads::refresh_access_token(
        account_id: String,
        options: session::RefreshOptionsDto,
    ),
    "session.roomKeysBackedUp" => session::reads::room_keys_backed_up(account_id: String),
    "session.hasOutgoingWork" => session::reads::has_outgoing_work(),
    "session.pendingTextMessages" => session::reads::pending_text_messages(),
    "session.pauseSync" => session::reads::pause_sync(),
    "session.knownNames" => session::reads::known_names(account_id: String),
    "session.holdServerLogout" => session::logout::hold_server_logout(account_id: String),
    "session.releaseServerLogoutHold" => session::logout::release_server_logout_hold(
        hold_id: String,
        deleted: bool,
    ),
    "session.deactivateAccount" => session::logout::deactivate_account(
        account_id: String,
        erase: bool,
        auth: Option<session::UiaAuthDto>,
    ),
    "session.storageEffects" => session::logout::storage_effects(),
    "session.logoutRemote" => session::logout::logout_remote(account_id: String),
    "session.signOutAll" => session::logout::sign_out_all(),
    "session.logoutSession" => session::logout::logout_session(
        session: session::MatrixSessionDto,
    ),
}

/// Decodes positional args in order. Its `bad-args` faults name the position and the type
/// classes but never quote a value: args carry access tokens and passwords.
pub struct Args<'a> {
    method: &'a str,
    values: std::vec::IntoIter<Value>,
    position: usize,
}

impl<'a> Args<'a> {
    pub fn new(method: &'a str, args: Vec<Value>) -> Self {
        Self {
            method,
            values: args.into_iter(),
            position: 0,
        }
    }

    pub fn decode<T: DeserializeOwned>(&mut self) -> Result<T, Fault> {
        let position = self.position;
        self.position += 1;
        let value = self
            .values
            .next()
            .ok_or_else(|| self.bad(format!("arg {position}: missing")))?;
        let found = type_class(&value);
        serde_json::from_value(value).map_err(|_| {
            let expected = type_name::<T>();
            self.bad(format!(
                "arg {position}: expected {expected}, found {found}"
            ))
        })
    }

    /// Fails if args are left over.
    pub fn finish(&self) -> Result<(), Fault> {
        match self.values.len() {
            0 => Ok(()),
            extra => Err(self.bad(format!(
                "expected {} args, found {}",
                self.position,
                self.position + extra
            ))),
        }
    }

    fn bad(&self, detail: String) -> Fault {
        Fault::new(FaultCode::BadArgs, format!("{}: {detail}", self.method))
    }
}

// The method and the position only: the values are args.
impl fmt::Debug for Args<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Args")
            .field("method", &self.method)
            .field("position", &self.position)
            .finish_non_exhaustive()
    }
}

fn type_class(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use futures_util::{FutureExt, StreamExt, future::ready, stream};
    use matrix_sdk::timeout::timeout;
    use serde_json::json;
    use tokio::sync::oneshot;

    use super::*;
    use crate::{accounts::Engine, config::EngineConfig, wire::FaultKind};

    fn pair(_: Arc<Engine>, text: String, count: u32) -> Stream {
        stream(stream::once(ready(Ok(json!([text, count])))))
    }

    fn none(_: Arc<Engine>) -> Stream {
        stream(stream::once(ready(Ok(json!(null)))))
    }

    mod table {
        use super::{none, pair};

        methods! {
            "test.pair" => pair(text: String, count: u32),
            "test.none" => none(),
        }
    }

    fn code(result: Result<Stream, Fault>) -> FaultCode {
        let fault = result.err().expect("a fault");
        assert_eq!(fault.kind, FaultKind::Protocol);
        fault.code
    }

    #[test]
    fn methods_decode_positional_args_in_order() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let mut stream = table::dispatch(&engine, "test.pair", vec![json!("x"), json!(2)]).unwrap();
        let first = stream.next().now_or_never().flatten().unwrap().unwrap();
        assert_eq!(first, json!(["x", 2]));
    }

    #[test]
    fn methods_reject_a_wrong_count_or_type_as_bad_args() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        for args in [
            vec![json!("x")],
            vec![json!("x"), json!(2), json!(3)],
            vec![json!(2), json!("x")],
        ] {
            assert_eq!(
                code(table::dispatch(&engine, "test.pair", args)),
                FaultCode::BadArgs
            );
        }
    }

    #[test]
    fn zero_arg_method_accepts_empty_args() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        assert!(table::dispatch(&engine, "test.none", vec![]).is_ok());
        assert_eq!(
            code(table::dispatch(&engine, "test.none", vec![json!(1)])),
            FaultCode::BadArgs
        );
    }

    #[tokio::test]
    async fn a_detached_command_finishes_after_its_stream_is_dropped() {
        let (release_tx, release) = oneshot::channel::<()>();
        let (done, done_rx) = oneshot::channel();
        let mut s = detached(async move {
            release.await.ok();
            done.send(()).ok();
            1
        });
        assert!(s.next().now_or_never().is_none());
        drop(s);
        release_tx.send(()).unwrap();
        let finished = timeout(done_rx, Duration::from_secs(1)).await;
        assert!(
            matches!(finished, Ok(Ok(()))),
            "the work was dropped with its stream"
        );
    }

    #[tokio::test]
    async fn a_detached_command_runs_though_its_stream_is_never_polled() {
        let (done, done_rx) = oneshot::channel();
        let s = detached(async move { done.send(()).ok() });
        let finished = timeout(done_rx, Duration::from_secs(1)).await;
        assert!(matches!(finished, Ok(Ok(()))), "the work waited for a poll");
        drop(s);
    }

    #[tokio::test]
    async fn a_detached_command_replies_once() {
        let mut s = detached(ready(7));
        assert_eq!(s.next().await, Some(Ok(json!(7))));
        assert_eq!(s.next().await, None);
    }

    #[tokio::test]
    async fn a_detached_panic_is_a_panic_fault() {
        let mut s = detached::<u32>(async { panic!("payload-secret") });
        let fault = s.next().await.unwrap().unwrap_err();
        assert_eq!(
            (fault.kind, fault.code),
            (FaultKind::Internal, FaultCode::Panic)
        );
        assert!(
            !fault.diagnostic.contains("payload-secret"),
            "{}",
            fault.diagnostic
        );
    }

    #[tokio::test]
    async fn set_presence_decodes_its_three_arguments_and_rejects_an_unknown_state() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let call = |state: Value, status: Value| {
            let args = vec![json!("@x:y"), state, status];
            dispatch(&engine, "identity.setPresence", args)
        };
        let mut decoded = call(json!("unavailable"), json!("Lunch")).unwrap();
        let reply = decoded.next().await.unwrap().unwrap();
        assert_eq!(reply["failure"]["code"], json!("account-not-live"));
        assert!(call(json!("online"), json!(null)).is_ok());
        for (state, status) in [(json!("busy"), json!(null)), (json!("online"), json!(5))] {
            assert_eq!(code(call(state, status)), FaultCode::BadArgs);
        }
        let short = vec![json!("@x:y"), json!("online")];
        let short = dispatch(&engine, "identity.setPresence", short);
        assert_eq!(code(short), FaultCode::BadArgs);
    }

    #[tokio::test]
    async fn the_identity_streams_dispatch_and_open_with_their_empty_snapshot() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        let streams = [
            (
                "identity.ownProfile",
                json!({"displayName": null, "avatarMxc": null}),
            ),
            ("identity.presence", json!([])),
            ("identity.ignoredUsers", json!([])),
        ];
        for (method, empty) in streams {
            let mut opened = dispatch(&engine, method, vec![json!("@x:y")]).unwrap();
            assert_eq!(opened.next().await, Some(Ok(empty)), "{method}");
            assert_eq!(code(dispatch(&engine, method, vec![])), FaultCode::BadArgs);
        }
    }

    #[test]
    fn an_unknown_method_is_a_protocol_fault() {
        let engine = Engine::new(EngineConfig::default()).unwrap();
        assert_eq!(
            code(dispatch(&engine, "nope.nothing", vec![])),
            FaultCode::UnknownMethod
        );
        assert_eq!(
            code(table::dispatch(&engine, "nope.nothing", vec![])),
            FaultCode::UnknownMethod
        );
    }
}
