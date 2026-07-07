# Multi-account support — design & plan

Status: **planned** (design). Target model: **concurrent** — every signed-in account
syncs in the background (aggregate unread badge, per-account notifications, one pusher
per account). Switcher UI: the **user-panel dropdown** in the channel-sidebar footer.

This document is the design and the phased milestone plan. It is grounded in the
current single-account architecture; file references point at the code that changes.

---

## 1. Where we are today (single-account)

The whole stack assumes exactly one live session:

- **`MatrixClientService`** (`libs/data-access-matrix-client/src/lib/matrix-client.service.ts`)
  is a root singleton holding **one** `private client: MatrixClient | null`. `init(session)`
  tears down any prior client and publishes the new one; `instance`/`isInitialized` expose
  the single client. ~20 data-access services read `this.matrix.instance`.
- **Credentials** persist to **single slots**: `matrix.session` (Preferences, non-secret
  `{ baseUrl, userId, deviceId }`) + `matrix.accessToken` (SecureStorage). A second login
  clobbers the first (`SessionStorageService`).
- **`AuthService.persistAndStart`** models login as _replace_: it `releaseAll()`s
  avatars/media, `push.unregister()`s, `storage.save()` (overwrite), then `matrix.init()`.
  `logout()` is all-or-nothing (`matrix.reset()` + `storage.clear()`).
- **Viewing data-access** (rooms/timeline/threads/spaces/pinned/search/profile/media)
  projects the one client's `EventEmitter` streams into root-singleton signals, re-wiring on
  client change via the `if (connectedClient === client) return; disconnect(); …` guard.
- **Crypto** runs in each client's Rust `OlmMachine`; `SecretStorageKeyService` holds one 4S
  key; `CryptoService`/`VerificationService`/`DevicesService` are singletons bound to one
  active client.
- **Push/notifications/badge** assume one client: one pusher, unread summed over the one
  client's rooms, notifications untagged by account, taps route with no account context.

### Two foundations are already in place

- **Sync cache is per-user on disk**: `IndexedDBStore({ dbName: 'trinity-sync:${userId}' })`
  (`createSyncStore`). Multiple accounts' sync stores already coexist.
- **Secure storage is a generic `key → string` map** (web prefixes `secure.`, native/Electron
  pass the key to the keychain). Per-account token keys are free.
- **Viewing services already re-wire on client change** — pointing the app at a different
  active client re-projects their signals with no per-service redesign.

### The real blockers

1. **Crypto store collides.** `initRustCrypto()` is called with **no args**
   (`matrix-client.service.ts:130`) → the SDK uses a **fixed** prefix `matrix-js-sdk`, so all
   accounts share `matrix-js-sdk::matrix-sdk-crypto{,-meta}` (device keys, Megolm sessions,
   cross-signing, backup key). **Fix:** the SDK accepts
   `initRustCrypto({ cryptoDatabasePrefix })` — pass a per-account prefix. This is the master
   key: needed for concurrent crypto _and_ for switching without wiping.
2. **Single-slot credentials** → an account registry + per-account tokens + migration.
3. **One live client / replace-on-login / all-or-nothing logout** → add / switch / per-account
   sign-out.
4. **Per-account crypto identity**: 4S key holder must be per-account.
5. **Aggregation assumes one client**: unread badge, notifications, and pushers.

---

## 2. Target architecture (concurrent)

The decomposition that keeps this tractable: **only aggregation needs all N accounts at
once.** The viewing layer only ever renders the **active** account.

```
                         ┌─────────────────────────────────────────┐
                         │ MatrixClientService (account registry)   │
                         │  Map<userId, AccountClient> — ALL sync   │
   viewing layer  ◀──────│  .instance  = ACTIVE account's client    │
   (rooms/timeline/…)    │  .activeUserId() .accounts() signals     │
   reads .instance,      │  .all() → every AccountClient            │
   re-projects on        └───────────────┬─────────────────────────┘
   activeUserId change                    │ all clients
                                          ▼
                         ┌─────────────────────────────────────────┐
   aggregation layer ◀───│ iterate .all(): unread badge sum,        │
   (badge/notif/push)    │ notifications (tagged by account),       │
                         │ one pusher per account                    │
                         └─────────────────────────────────────────┘
```

### 2.1 `MatrixClientService` → multi-client registry

Replace the single `client` field with a registry. Each entry bundles the per-account
runtime:

```ts
interface AccountClient {
  readonly userId: string;
  readonly client: MatrixClient;
  readonly syncStore: IndexedDBStore | null;
  readonly syncState: Signal<SyncState | null>; // per-account
  readonly secretStorageKeys: SecretStorageKeyHolder; // per-account 4S key (see 2.4)
  readonly cryptoPrefix: string | undefined; // its crypto DB prefix (undefined = SDK default,
  // a migrated legacy account); kept so sign-out wipes the RIGHT store (see 2.3)
}
```

New/changed surface:

- `add(session)` — start a client **without** tearing down others (variant of today's
  `init` that skips `teardown()`), insert into the map, begin syncing.
- `setActive(userId)` — flip an `activeUserId` signal; `instance` now returns that client.
  No teardown; the account keeps syncing whether active or not.
- `remove(userId)` — stop that one client; on **sign-out** also wipe its stores
  (`clearStores({ cryptoDatabasePrefix })` with the account's _own_ prefix, so the correct
  crypto store is deleted — see 2.3); never touches the others.
- `instance` (unchanged signature) — returns the **active** account's client, so every
  existing `this.matrix.instance` reader keeps working, now scoped to the active account.
- `accounts(): Signal<AccountSummary[]>`, `activeUserId(): Signal<string | null>` — for the
  switcher UI.
- `all(): AccountClient[]` — for the aggregation layer.
- `restoreAll()` — app-start: init the persisted **active** account first (fast paint), warm
  the rest in the background.

Each client is created exactly as today (`createClient` + per-account sync store) but with:

- `initRustCrypto({ cryptoDatabasePrefix: entry.cryptoPrefix })` (2.3),
- `cryptoCallbacks` bound to that account's own `SecretStorageKeyHolder` (2.4).

### 2.2 Viewing layer — active-scoped, re-project on switch

Rooms/timeline/threads/spaces/pinned/search/profile/media/invites and the crypto-UI
services (crypto/verification/devices) stay single-client internally and keep reading
`this.matrix.instance` (= active). The only change: **re-project when the active account
changes.** They already re-wire via the `connectedClient` guard; add a trigger:

```ts
constructor() {
  // Re-bind to the active account's client whenever it changes.
  effect(() => { this.matrix.activeUserId(); this.connect(); });
}
```

Switching accounts then re-projects the room list, timeline, spaces, etc. onto the new
active client with no further per-service work. `RoomsPage`'s user signals
(`getUserId()`/`getUser()`) already recompute off `this.matrix.instance`; they re-read on
active change.

### 2.3 Crypto store isolation (the master change)

`initRustCrypto({ cryptoDatabasePrefix })` gives each account its own
`{prefix}::matrix-sdk-crypto{,-meta}` databases. The WASM module memoization
(`crypto-wasm-loader.ts`, `shareReplay(1)`) stays shared — it loads _code_, not account
data; every account's `OlmMachine` reuses it.

**Prefix is scoped by account _and device_: `trinity-crypto:${userId}:${deviceId}`.** A
`OlmMachine` is bound to a `(userId, deviceId)` pair and rejects a store whose stored account
doesn't match the one it's constructed for ("the account in the store doesn't match the
account in the constructor"). Because a fresh login always mints a **new** device id, a
prefix keyed by user id _alone_ would make the next login re-open the previous device's store
and hit that mismatch — so the device id is part of the prefix, and `SessionStorageService.upsert`
**recomputes** the prefix whenever an account's device id changes. A same-device re-login
(soft-logout re-auth, token rotation) keeps the existing prefix, so its store is reused with no
re-verification. The prefix is recorded per account in the registry; readers just pass through
`session.cryptoPrefix`, so the scheme is derived in exactly one place (`upsert`).

**Store lifecycle — no orphans:**

- **Sign-out** wipes the account's _own_ store: `clearStores({ cryptoDatabasePrefix })` (with the
  account's prefix). Calling `clearStores()` with no argument deletes the SDK **default**-prefix
  store, not the account's real one — which orphaned it and, pre-fix, broke the next login.
- **Device-change re-login without a sign-out** moves the account to a fresh device-scoped store
  and best-effort deletes the one the old device left behind (`upsert` → `reclaimCryptoStore`).
- **Cold start** sweeps any crypto store no signed-in account owns
  (`sweepOrphanedCryptoStores()`, fired from `restoreAll()`) to reclaim stores orphaned by
  earlier versions. It enumerates `indexedDB.databases()` and spares a keep-set of every live
  account's store (no-op where `databases()` is unavailable, e.g. Firefox).

The Rust crypto DB naming (`${prefix}::matrix-sdk-crypto{,-meta}`, default prefix `matrix-js-sdk`)
lives in one place: `@trinity/util-matrix` `rustCryptoStoreDbNames` / `isRustCryptoStoreDbName`.

**Migration (must not force re-verification of the existing account):** the current single
account's crypto lives under the default `matrix-js-sdk` prefix. Changing its prefix would
orphan its Olm store (forcing re-verify/recover). Mitigation: **record the crypto prefix per
account in the registry** and, for the migrated legacy account, keep the default prefix
(`cryptoDatabasePrefix` omitted) — until its device changes, at which point it too moves to a
fresh device-scoped store (unavoidable: the new device can't use the old device's keys). Only
_new_ accounts get `trinity-crypto:${userId}:${deviceId}`. (Optional at-rest encryption via
`initRustCrypto({ storageKey })` is a separate future hardening.)

### 2.4 Per-account 4S key holder

`SecretStorageKeyService` today is a process-global singleton holding one
`[keyId, privateKey]`. Extract a `SecretStorageKeyHolder` (the stateful pair + the two
callbacks) and give **one instance per `AccountClient`**, wired into that client's
`cryptoCallbacks`. Teardown clears only that account's holder. Two accounts unlocking 4S no
longer clobber each other.

### 2.5 Aggregation layer (needs all accounts)

- **Unread badge.** Today `RoomsService.totalUnread` sums the _active_ client's rooms and
  `AppBadgeService` mirrors it to the OS. New: an aggregator that sums unread across
  `matrix.all()` (reading each client's rooms' notification counts directly — no full
  projection needed). `AppBadgeService` reads the aggregate. Per-account counts also feed the
  switcher dropdown.
- **Notifications.** `NotificationService` attaches its `RoomEvent.Timeline` +
  `MatrixEventEvent.Decrypted` listeners to **every** client (a `Map<userId, connected>`),
  scores push rules per account, **tags** each notification with `userId` (and folds it into
  the dedupe `tag`, else the same `roomId` across accounts collapses), and a **tap →
  `setActive(userId)` then open the room**. Dedupe sets namespaced per account.
- **Push.** Register **one pusher per account** (pushers are per-account, server-side). All
  accounts share the one device FCM/APNs token, and today `append: false` + a platform-only
  `app_id` means the last `setPusher` wins. Resolve by encoding the target account into the
  pusher `data`/pushkey so the gateway (Sygnal) fans out to the right account, and iterate
  accounts in `register()`/`unregister()` (per-account `currentPushkey`/`registered`). **This
  likely needs a gateway-side change** — see `docs/PUSH.md`; flagged as an external
  dependency.

### 2.6 Credentials registry

`SessionStorageService` becomes a registry (keep `MatrixSession` as the per-account record):

```ts
const ACCOUNTS_KEY = 'matrix.accounts'; // non-secret registry
const TOKEN_KEY_PREFIX = 'matrix.accessToken:'; // one secure entry per account

interface StoredAccounts {
  activeUserId: string | null;
  accounts: Array<{ baseUrl: string; userId: string; deviceId: string; cryptoPrefix?: string }>;
}
```

- Token per account: `secure.set(TOKEN_KEY_PREFIX + userId, accessToken)` — free per-account
  isolation from the generic secure-storage map.
- API: `upsert(session)`, `list()`, `loadActive()` / `load(userId)`, `setActive(userId)`,
  `remove(userId)`, `clearAll()`.
- **Migration** (layers on the existing in-JSON token migration): if `ACCOUNTS_KEY` absent
  but the legacy `matrix.session` slot present, fold it into the registry as the active
  account (mark `cryptoPrefix` = default so its crypto store is untouched), move its token to
  `TOKEN_KEY_PREFIX + userId`, retire the old `matrix.session` / `matrix.accessToken` slots.
  One-time, transparent, no re-login.

### 2.7 Auth flows

- **Add account** — `AuthService.addAccount(...)` (password + SSO variants) → a `persistAndAdd`
  that upserts under the per-user key and calls the **non-tearing** `matrix.add(session)`. It
  must **not** globally `releaseAll()` / `push.unregister()` (those are the replace-semantics
  of `persistAndStart`); instead register a pusher for the new account only.
- **Switch account** — `switchAccount(userId)` → `matrix.setActive(userId)` +
  `storage.setActive(userId)`. Cheap: the target already syncs.
- **Sign out one account** — `logout(userId)`: server logout for _that_ client, `matrix.remove`
  (stop + wipe that account's stores), remove its registry entry + token, unregister its
  pusher. If it was active, switch to another; if it was the last, the current global
  reset + redirect-to-`/login` is correct.
- **SSO add** — the state-nonce round-trip must carry an "add" intent so the callback _adds_
  rather than _replaces_.

### 2.8 UI — user-panel dropdown

The switcher lives in the channel-sidebar footer's existing `#accountMenu`
(`channel-sidebar.component.html`), which already anchors on the active user and owns
"Log out". `ChannelSidebarComponent` stays presentational: new inputs `accounts:
AccountSummary[]` + `activeUserId`, new outputs `switchAccount(userId)` / `addAccount()`, and
"Log out" becomes per-account. `RoomsPage` owns the state, feeding
`matrix.accounts()`/`activeUserId()` (mirroring how it feeds `userProfile()` today) and
wiring the outputs to `AuthService`. `AccountSummary` extends the existing `UserProfile`
(`{ userId, displayName, avatarMxc, baseUrl }`) with an unread count.

Add-account routes to `/login` in an "add" mode (a query flag) so a successful login calls
`addAccount` instead of the replacing `loginWithPassword`.

---

## 3. Milestones

Each milestone ends green (`pnpm test` + `pnpm lint` + `pnpm build`) and is independently
reviewable. M1–M4 are the foundation; M5 makes switching usable; M6–M8 deliver the
concurrent payoff; M9 is the UI; M10 is hardening.

| #       | Milestone                       | Core changes                                                                                                                                    | Ships                          |
| ------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **M1**  | **Crypto store isolation**      | `initRustCrypto({ cryptoDatabasePrefix })`; per-account 4S `SecretStorageKeyHolder`; split "detach" vs "wipe" teardown; legacy-prefix migration | Foundation (no visible change) |
| **M2**  | **Account registry**            | `SessionStorageService` → registry + per-account tokens + migration; new API                                                                    | Foundation                     |
| **M3**  | **Multi-client registry**       | `MatrixClientService` → `Map<userId, AccountClient>`, `add`/`setActive`/`remove`/`all`/`accounts`/`activeUserId`; `restoreAll` warms all        | N clients can coexist          |
| **M4**  | **Auth add/switch/sign-out**    | `addAccount` (+SSO), `switchAccount`, `logout(userId)`; guard restores active + warms others                                                    | Add/switch/remove wired        |
| **M5**  | **Viewing re-projection**       | active-change effect in each viewing service; verify rooms/timeline/spaces/profile re-project on switch                                         | **Usable switching**           |
| **M6**  | **Aggregate unread badge**      | cross-account unread aggregator; `AppBadgeService` sums all; per-account counts for the switcher                                                | Badge counts every account     |
| **M7**  | **Cross-account notifications** | listeners on all clients; notifications tagged by account; tap → switch + open                                                                  | Background notifications       |
| **M8**  | **Per-account pushers**         | one pusher per account, account-discriminated; per-account register/unregister; gateway/`docs/PUSH.md` update                                   | Mobile push per account        |
| **M9**  | **Switcher UI**                 | user-panel dropdown: accounts list + unread + active check + Add account + per-account Sign out; `/login?add` mode                              | **Feature visible**            |
| **M10** | **Hardening**                   | per-account encryption setup/verify/recover; soft-logout of one account; storage-quota; PWA/Electron/native; e2e                                | Production-ready               |

**Status (branch `feat/multi-account`):** M1–M7, M9, and M10 are **done** and shipped; the
feature is user-visible and e2e-covered (`e2e/playwright/multi-account.spec.mts` drives
add → switch, per-account encryption status, and the switch-invariant aggregate badge). **M8**
is client-side complete (one account-tagged pusher per account, tap-to-switch); full mobile push
DELIVERY still needs the external **Sygnal** gateway change (forward `data.trinity_user_id`) — the
one remaining follow-up, tracked in `docs/PUSH.md`. M10 landed as sub-phases: per-account crypto
(verified), soft-logout (`MatrixClientService.softLoggedOut`), storage persistence
(`StoragePersistenceService`), the broader cross-account e2e, and a sign-out → re-login
crypto-store fix (device-scoped prefixes + orphan reclamation — see 2.3).

---

## 4. Risks & open questions

- **Crypto store lifecycle** (resolved). Prefixes are scoped by account **and device**
  (`trinity-crypto:${userId}:${deviceId}`); the legacy account keeps the default prefix until its
  device changes, so an upgraded user is not asked to re-verify. A userId-only prefix was found
  to break the sign-out → re-login flow — the new device re-opened the old device's orphaned
  store, so `initRustCrypto` threw "the account in the store doesn't match the account in the
  constructor" — now fixed by device scoping + a corrected `clearStores` prefix + reclaim/sweep
  of orphaned stores (2.3). Covered by unit tests and Synapse-backed e2e (`multi-account.spec`).
- **Push gateway fan-out.** Routing a notification to the right account across one device token
  likely needs Sygnal-side support for an account discriminator. External dependency — confirm
  before committing M8 (`docs/PUSH.md`).
- **Resource cost.** N concurrent clients = N sync loops + N `OlmMachine`s + N IndexedDB
  stores → memory, battery, and storage-quota pressure (especially mobile/PWA). Consider a
  soft cap on accounts and lazy-warming inactive accounts a beat after the active one.
- **Soft-logout of one account** (`M_UNKNOWN_TOKEN` / server-side device deletion) must mark
  that one account signed-out and prompt re-login for it **without** killing the others.
- **Encryption UI is active-scoped.** Bootstrap/verify/recover operate on the active account;
  switching must re-target them, and a freshly-added account may need its own crypto setup.
- **Homeserver diversity.** Accounts can live on different homeservers (different
  `.well-known`, authed-media support, versions). `media`/`avatars` already re-probe on
  session change (`releaseAll`) — verify per-account media/auth resolves correctly when
  clients coexist.
- **`isInitialized` semantics.** Many call sites guard on `matrix.isInitialized` (the active
  client). Confirm each still means "the active account is up" after the registry change.

---

## 5. Key files (change map)

- `libs/data-access-matrix-client/src/lib/matrix-client.service.ts` — registry, `add`/
  `setActive`/`remove`/`all`, per-account crypto prefix + sync store.
- `libs/data-access-matrix-client/src/lib/secret-storage-key.service.ts` — per-account holder.
- `libs/platform-native/src/lib/session-storage.service.ts` — registry + per-account tokens +
  migration (`secure-storage.service.ts` unchanged — generic key map).
- `libs/data-access-auth/src/lib/{auth.service.ts,auth.guard.ts}` — add/switch/per-account
  sign-out; restore active + warm others.
- `libs/feature-auth/**` — `/login?add` mode; SSO "add" intent.
- Viewing data-access (`data-access-{rooms,timeline,spaces,pinned,search,profile,invites,media}`)
  — active-change re-projection effect.
- `libs/data-access-notifications/src/lib/{push.service.ts,notification.service.ts,app-badge.service.ts}`
  - `libs/data-access-rooms/src/lib/rooms.service.ts` — aggregation.
- `libs/feature-rooms/src/lib/{rooms/rooms.page.*,channel-sidebar/channel-sidebar.component.*}`
  — switcher state + UI.
- `docs/PUSH.md` — per-account pusher/gateway notes.
