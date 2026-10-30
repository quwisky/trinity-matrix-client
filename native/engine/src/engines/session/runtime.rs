//! One live account: its client, its sync and the task that reports their status.

use std::sync::{Arc, Weak};

use futures_util::{Stream, StreamExt, stream};
use matrix_sdk::{
    Client,
    executor::{AbortOnDrop, spawn},
};
use matrix_sdk_ui::{
    room_list_service::{self, RoomList, RoomListLoadingState},
    sync_service::{self, SyncService},
};
use tokio::sync::watch;

use super::{MatrixSessionDto, SessionSyncStateDto, restore::refreshable};
use crate::accounts::Engine;

pub struct AccountRuntime {
    pub account_id: String,
    pub generation: u32,
    pub client: Client,
    pub(crate) sync_service: Arc<SyncService>,
    /// The session's `baseUrl` as given: `Client::homeserver()` adds a trailing slash.
    pub(crate) base_url: String,
    pub(crate) refreshable: bool,
    #[expect(dead_code, reason = "T5's tokens-rotated effect reads it")]
    pub(crate) lineage: Option<String>,
    /// The restored token with its expiry, which a token the SDK refreshed does not have (H8).
    pub(crate) expiry: Option<(String, f64)>,
    /// Dropped with the runtime, which tells a teardown that no engine command holds it.
    alive: watch::Sender<()>,
    /// Keeps the room list's loading task, which `roomsPrepared` follows.
    _all_rooms: RoomList,
    _status: AbortOnDrop<()>,
}

impl AccountRuntime {
    /// Builds the runtime of `s` and starts its status task, which writes into `engine`'s
    /// registry while `generation` is the account's.
    pub(crate) fn new(
        engine: &Arc<Engine>,
        s: &MatrixSessionDto,
        generation: u32,
        client: Client,
        sync_service: Arc<SyncService>,
        all_rooms: RoomList,
    ) -> Self {
        let sync = sync_service.state();
        let room_list = sync_service.room_list_service().state();
        let loading = all_rooms.loading_state();
        let current = [
            Event::Sync(sync.get()),
            Event::RoomList(room_list.get()),
            Event::Loading(loading.get()),
        ];
        let events = stream::iter(current).chain(stream::select(
            stream::select(sync.map(Event::Sync), room_list.map(Event::RoomList)),
            loading.map(Event::Loading),
        ));
        let status = Status::follow(
            Arc::downgrade(engine),
            s.user_id.clone(),
            generation,
            events,
        );
        let expiry = s.oidc.as_ref().and(s.access_token_expires_at);
        Self {
            account_id: s.user_id.clone(),
            generation,
            client,
            sync_service,
            base_url: s.base_url.clone(),
            refreshable: refreshable(s),
            lineage: s.lineage.clone(),
            expiry: expiry.map(|at| (s.access_token.clone(), at)),
            alive: watch::Sender::new(()),
            _all_rooms: all_rooms,
            _status: AbortOnDrop::new(spawn(status)),
        }
    }

    /// Ends, with an error, once the runtime is dropped.
    pub(crate) fn dropped(&self) -> watch::Receiver<()> {
        self.alive.subscribe()
    }
}

/// `SessionSyncState` for the sync service's state: `prepared` while only the cache has rooms.
pub(crate) fn sync_state_of(
    state: &sync_service::State,
    ever_started: bool,
    rooms_prepared: bool,
    server_synced: bool,
) -> SessionSyncStateDto {
    use sync_service::State;
    match state {
        State::Idle if ever_started => SessionSyncStateDto::Stopped,
        State::Idle => SessionSyncStateDto::Starting,
        State::Running if rooms_prepared && !server_synced => SessionSyncStateDto::Prepared,
        State::Running => SessionSyncStateDto::Syncing,
        State::Offline => SessionSyncStateDto::Reconnecting,
        State::Error(_) => SessionSyncStateDto::Error,
        State::Terminated => SessionSyncStateDto::Stopped,
    }
}

enum Event {
    Sync(sync_service::State),
    RoomList(room_list_service::State),
    Loading(RoomListLoadingState),
}

/// What the status task has seen; `server_synced` and `rooms_prepared` stick once true.
struct Status {
    sync: sync_service::State,
    ever_started: bool,
    server_synced: bool,
    rooms_prepared: bool,
}

impl Status {
    /// Writes the status after each event until the account has a newer generation.
    async fn follow(
        engine: Weak<Engine>,
        account_id: String,
        generation: u32,
        events: impl Stream<Item = Event>,
    ) {
        let mut status = Status {
            sync: sync_service::State::Idle,
            ever_started: false,
            server_synced: false,
            rooms_prepared: false,
        };
        let mut events = std::pin::pin!(events);
        while let Some(event) = events.next().await {
            status.apply(event);
            let Some(engine) = engine.upgrade() else {
                return;
            };
            let sync_state = sync_state_of(
                &status.sync,
                status.ever_started,
                status.rooms_prepared,
                status.server_synced,
            );
            let current = engine.update_status(&account_id, generation, |entry| {
                entry.sync_state = sync_state;
                entry.server_synced = status.server_synced;
                entry.rooms_prepared = status.rooms_prepared;
            });
            if !current {
                return;
            }
        }
    }

    fn apply(&mut self, event: Event) {
        match event {
            Event::Sync(state) => {
                self.ever_started |= !matches!(state, sync_service::State::Idle);
                self.sync = state;
            }
            Event::RoomList(state) => {
                self.server_synced |= matches!(
                    state,
                    room_list_service::State::SettingUp
                        | room_list_service::State::Recovering
                        | room_list_service::State::Running
                );
            }
            Event::Loading(state) => {
                self.rooms_prepared |= matches!(state, RoomListLoadingState::Loaded { .. });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use matrix_sdk_ui::sync_service::State;

    use super::*;
    use SessionSyncStateDto::*;

    #[test]
    fn sync_state_maps_each_service_state() {
        let error = || State::Error(Arc::new(sync_service::Error::Supervisor));
        let table = [
            (State::Idle, false, false, false, Starting),
            (State::Idle, true, true, true, Stopped),
            (State::Running, true, false, false, Syncing),
            (State::Running, true, true, false, Prepared),
            (State::Running, true, true, true, Syncing),
            (State::Running, true, false, true, Syncing),
            (State::Offline, true, true, false, Reconnecting),
            (error(), true, false, false, Error),
            (State::Terminated, true, true, true, Stopped),
        ];
        for (state, ever_started, rooms_prepared, server_synced, expected) in table {
            let label = format!("{state:?} {ever_started} {rooms_prepared} {server_synced}");
            assert_eq!(
                sync_state_of(&state, ever_started, rooms_prepared, server_synced),
                expected,
                "{label}"
            );
        }
    }
}
