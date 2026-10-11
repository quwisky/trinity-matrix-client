# Refresh tokens in the native push store for OIDC accounts

Investigation for [#1163](https://github.com/quwisky/trinity-matrix-client/issues/1163),
2026-10-11. Status: **awaiting an owner decision**. Nothing here changes code; the decision
it asks for is listed under [Owner decision needed](#owner-decision-needed).

## Summary

Closed-app notifications ([#1155](https://github.com/quwisky/trinity-matrix-client/issues/1155),
PR #1157) read the message with a copy of the account's access token. For accounts signed in
through the Matrix OAuth 2.0 API (MSC3861, served by Matrix Authentication Service), that token
lives five minutes by default, and only the running app can refresh it. After the app has been
closed for longer than that, every read fails and the notification shows the room name with
"New message".

Giving the native renderer the refresh token as well fixes this, but makes two processes hold
one single-use credential. A careless second refresher does more than fail: in Trinity it can
end in a **hard sign-out that wipes the account's local crypto store**. The safe form of the
idea is the Element X model: one token authority, one lock that every refresher takes, and the
rotated pair written back before the lock is released. #1153 and #1154 need the same kind of
cross-process lock for the crypto store and the sync position.

**Recommendation:** answer the owner question "yes, under conditions" (listed below), and build
the refresh path on the lock that #1153/#1154 design rather than as a separate one. Until then,
keep generic text for OIDC accounts with expired tokens, make that fallback cheaper and clearer,
and measure real lifetimes (#1152 step 5) before committing to the larger work.

## Problem

### The exact failure path

1. **The app refreshes; the handoff copies only the access token.** For an OIDC session,
   [`MatrixClientService.tokenOptions`](../../libs/data-access/matrix-client/src/lib/matrix-client.service.ts)
   (line 796) gives matrix-js-sdk the refresh token, the OAuth client ID and an
   `onTokenRefresh` callback. The callback persists the rotated pair through
   [`SessionStorageService.updateTokens`](../../libs/platform-native/src/lib/session-storage.service.ts)
   (line 260; the refresh token goes to secure storage under `matrix.refreshToken:<userId>`) and
   then publishes `accessTokenRotations` with **the access token only**.
2. [`PushHandoffService`](../../libs/data-access/notifications/src/lib/push-handoff.service.ts)
   subscribes to those rotations (lines 70–72). Its `writeAccount` (lines 182–196) sends the
   user ID, homeserver URL, access token and sound choice through `PushHandoff.setAccount`. It
   also writes the token when an account binds. It never sees a refresh token or an expiry.
3. **The native stores hold that access token.** Android:
   [`PushHandoffStore.setAccount`](../../libs/native/capacitor-push/android/src/main/kotlin/dev/trinityproject/trinity/push/PushHandoffStore.kt)
   (AES-256-GCM under a non-exportable Keystore key, private preferences file
   `trinity_push_handoff`). iOS:
   [`PushHandoffStore.setAccount`](../../libs/native/capacitor-push/ios/TrinityPush/Sources/TrinityPush/PushHandoffStore.swift)
   (shared keychain group `…dev.trinityproject.trinity.shared`,
   `kSecAttrAccessibleAfterFirstUnlock`). `HandoffAccount` has no refresh token field on
   either platform, by design.
4. **A push arrives while the app is closed.** Android's `TrinityMessagingService` →
   `DevicePushHandler` → `BoundedPushResolver` →
   [`PushResolver.resolve`](../../libs/native/capacitor-push/android/src/main/kotlin/dev/trinityproject/trinity/push/PushResolver.kt)
   (lines 65–101) calls `GET /_matrix/client/v3/rooms/{roomId}/event/{eventId}` with
   `Authorization: Bearer <stored token>` in
   [`HttpMatrixApi.get`](../../libs/native/capacitor-push/android/src/main/kotlin/dev/trinityproject/trinity/push/HttpMatrixApi.kt)
   (lines 35–64). iOS does the same in
   [`PushContentResolver.resolve`](../../libs/native/capacitor-push/ios/TrinityPush/Sources/TrinityPush/PushContentResolver.swift)
   and [`MatrixPushAPI`](../../libs/native/capacitor-push/ios/TrinityPush/Sources/TrinityPush/MatrixPushAPI.swift)
   (line 72 accepts only HTTP 200).
5. **The token has expired.** Synapse, with authentication delegated to MAS, introspects the
   token, finds it inactive and answers `401 M_UNKNOWN_TOKEN` with `soft_logout: false`
   ([`synapse/api/auth/mas.py`](https://github.com/element-hq/synapse/blob/c0805eabb1bda3b1ffc370fec35a73d524674d60/synapse/api/auth/mas.py#L332-L333)).
   Any non-200 reads as `null`. The sender lookup is skipped (it needs the event's `sender`),
   and a room the store does not know also fails its `m.room.name` read.
6. **The renderer falls back.** `PushRenderRules.render(event = null, …)` returns
   `FALLBACK_BODY` ("New message",
   [`PushRenderRules.kt`](../../libs/native/capacitor-push/android/src/main/kotlin/dev/trinityproject/trinity/push/PushRenderRules.kt)
   line 49), titled with the stored room name or "Trinity". For an encrypted room the fallback
   also loses the sender and "Encrypted message", because both come from the event.

The window in which closed-app text still works is therefore at most one access-token lifetime
after the app's last refresh. MAS issues OAuth 2.0 access tokens with a default
`access_token_ttl` of 300 s, configured server-wide under `experimental`
([MAS configuration](https://element-hq.github.io/matrix-authentication-service/reference/configuration.html)).
matrix.org's actual value has not been measured (#1152 step 5).

Password and SSO logins are unaffected in practice: their access tokens carry no expiry
(`accessTokenExpiresAt` is absent, [`session.model.ts`](../../libs/util/matrix/src/lib/session.model.ts)),
so the stored copy stays valid until sign-out.

### Why the renderer may not simply refresh

Two facts make a second, uncoordinated refresher dangerous rather than merely wasteful.

**Refresh tokens are single-use, and losing the race signs the account out.** MAS rotates the
refresh token on every grant and revokes the access token issued with the consumed one
([`refresh_token_grant`](https://github.com/element-hq/matrix-authentication-service/blob/2277a37c5928eb08de4781b6e602a8a6c81bcca1/crates/handlers/src/oauth2/token.rs#L624-L803)).
It tolerates a reused refresh token only when the pair issued for it has not been used yet. It
treats that as a lost response, revokes the unused pair and issues a new one. Once Synapse has
introspected the new access token, MAS marks it used
([`introspection.rs`](https://github.com/element-hq/matrix-authentication-service/blob/2277a37c5928eb08de4781b6e602a8a6c81bcca1/crates/handlers/src/oauth2/introspection.rs#L359-L364)),
and a reuse of the old refresh token returns `400 invalid_grant`. The Matrix specification allows
stricter servers: the homeserver "SHOULD consider that the session is compromised if an old,
invalidated refresh token is used, and SHOULD revoke the session"
([refresh token grant](https://spec.matrix.org/v1.19/client-server-api/#refresh-token-grant)).
MAS does not do that today (its code marks the case `XXX … we *may* want to invalidate the
session`), but a design that relies on MAS tolerating concurrent refreshes, where a second
holder presents a refresh token the first has already used, breaks on a compliant server.
Retrying one's own refresh after a lost response is different: the spec guarantees it.

**In Trinity, a refused refresh becomes a hard sign-out.** On `M_UNKNOWN_TOKEN`, matrix-js-sdk
43 refreshes; a 400/401 refusal is a `TokenRefreshLogoutError`
(`node_modules/matrix-js-sdk/src/oauth/tokenRefresher.ts`, narrowed by Trinity's patch), and the
SDK emits `SessionLoggedOut` with the original 401 error. Because Synapse sends
`soft_logout: false`, [`MatrixClientService.handleServerLogout`](../../libs/data-access/matrix-client/src/lib/matrix-client.service.ts)
(line 990) takes the hard path: it wipes the account's stores, including the Rust crypto
store, and forgets the account. Keys missing from backup are lost.

There is a second trap that does not involve reusing the refresh token. MAS revokes the
previous access token on every refresh. If the renderer refreshes while the app still holds a
live client, for example suspended on iOS or backgrounded on Android, the app's old token stops
working. Synapse caches introspection results for 2 minutes and has no invalidation
([`mas.py`](https://github.com/element-hq/synapse/blob/c0805eabb1bda3b1ffc370fec35a73d524674d60/synapse/api/auth/mas.py#L127-L145)),
so a revoked token can keep working for up to 2 minutes. After that, the app's next request
gets `M_UNKNOWN_TOKEN` for a token it may believe is still valid. matrix-js-sdk then does not
try to refresh: when the known expiry is 60 s or more away it returns `Logout` immediately
(`_handleUnknownToken` in `node_modules/matrix-js-sdk/src/http-api/refresh.ts`).

That known expiry is `latestTokenRefreshExpiry`, which the SDK sets only after a refresh in the
current process; Trinity passes no initial expiry
([`session.model.ts`](../../libs/util/matrix/src/lib/session.model.ts) line 17). Right after a
restore, the SDK therefore does refresh, but with the refresh token it restored, which the
renderer has already consumed. That gets `invalid_grant`: the same hard sign-out by a different
route. Any design in which the renderer refreshes must therefore also change how the app reacts
to a 401 and where it reads its tokens on restore.

## Constraints

- **One authority per credential.** OAuth 2.0 requires refresh tokens to be confidential in
  transit and storage and shared only between the authorization server and the client
  ([RFC 6749 §10.4](https://www.rfc-editor.org/rfc/rfc6749#section-10.4)). For public clients,
  [RFC 9700 §4.14.2](https://www.rfc-editor.org/rfc/rfc9700#section-4.14.2) (BCP 240) says
  authorization servers MUST use sender-constrained or rotated refresh tokens. The OAuth 2.1
  draft carries the same rule in its normative refresh token grant section
  ([draft 16 §4.3.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-16#section-4.3.1);
  §10 repeats it informatively). Every OIDC homeserver Trinity
  meets should be assumed to rotate.
- **Retry of a lost response is safe; reuse after the new pair was used is not.** The Matrix
  spec requires the server to let a client retry a refresh whose response was lost, and asks
  clients to retry network and 5xx failures with the old token. Only a 4xx means "logged out".
- **No narrow token exists.** MSC2967 defines one API scope, `urn:matrix:client:api:*` (full
  client-server access), plus the device scope. Finer scopes are explicitly left to future MSCs
  ([MSC2967](https://github.com/matrix-org/matrix-spec-proposals/pull/2967)).
- **matrix-js-sdk has no pre-refresh hook.** `TokenRefresher` is constructed inside
  `TokenManager` and posts to the token endpoint through `globalThis.fetch`; `onTokenRefresh`
  runs only after a successful grant. Coordinating the app's refresh with another process
  needs a patch to `patches/matrix-js-sdk@43.0.0.patch`, which Trinity already maintains.
- **Renderer budgets.** One 5 s budget per push today; the iOS extension has roughly 24 MB and
  30 s, and Android message handling is short (#1154). A refresh adds one token-endpoint round
  trip and must fit the same budget.
- **Process model.** iOS: the app and the Notification Service Extension are separate processes
  that share only the keychain access group and the app-group container. Android:
  `TrinityMessagingService` declares no `android:process`, so it runs in the app's process
  ([service `android:process`](https://developer.android.com/guide/topics/manifest/service-element#proc));
  a JVM-level lock is enough there, but the JavaScript side must still take it.
- **iOS suspension and locks.** iOS terminates a suspended app that holds a file or SQLite lock
  in a shared container (`0xdead10cc`;
  [Apple forum](https://developer.apple.com/forums/thread/655225),
  [summary](https://mjtsai.com/blog/2025/05/15/sqlite-databases-in-app-group-containers-dont/)).
  A lock between the app and the extension must be a lease that expires, not a held `flock`.

## Options

### (a) Refresh tokens in the native store, with one refresher at a time

The handoff store gains the refresh token, the access-token expiry and the non-secret refresh
inputs (token endpoint, client ID, issuer), and the renderer refreshes an expired token itself.
There are three ways to arrange the ownership.

- **(a1) Two refreshers and no lock.** Rejected. Concurrent grants with one refresh token end in
  `invalid_grant` for one of them, and the early revocation of the app's access token turns the
  loser into a hard sign-out (see above).
- **(a2) The renderer refreshes only while the app is not running.** This does not work as stated,
  because neither platform can say reliably that the app is not running. An iOS app suspended
  with a live client counts as "not running" to the extension, yet on resume it uses a token
  the extension's refresh has just revoked. The rule also leaves the app with a stale pair after
  a closed-app refresh, so a write-back and a re-read are still needed. With those added, it
  becomes (a3).
- **(a3) A single token authority and a lock (the Element X model).** On iOS and Android the
  native store becomes the only authority for an OIDC account's token pair. Any process that
  wants to refresh takes the account's lock, re-reads the pair, refreshes only if the pair it
  read is still the expired one, writes the rotated pair back, and then releases the lock.
  Element X iOS does this with matrix-rust-sdk: both the app and the extension build their
  client with `crossProcessLockConfig(.multiProcess(holderName: bundleIdentifier))` and a
  session delegate backed by a shared keychain group
  ([`ClientFactory.swift`](https://github.com/element-hq/element-x-ios/blob/14e33866ced2456f99a0039087363357d946c551/ElementX/Sources/Services/Client/ClientFactory.swift#L118-L120),
  [`KeychainController.swift`](https://github.com/element-hq/element-x-ios/blob/14e33866ced2456f99a0039087363357d946c551/ElementX/Sources/Services/Keychain/KeychainController.swift#L39-L41)).
  The SDK takes an intra-process mutex, then a leased cross-process lock in its crypto store
  (up to 60 s), and compares a stored hash of the session tokens to detect a refresh done by
  the other process
  ([`cross_process.rs`](https://github.com/matrix-org/matrix-rust-sdk/blob/b3c07ea6ba6e8e46e30811c0500b04505c4be9f9/crates/matrix-sdk/src/authentication/oauth/cross_process.rs)).

A protocol for (a3) in Trinity would need these parts:

1. **Store record per account:** access token, refresh token, access-token expiry, a
   generation counter, an optional in-flight marker (the refresh token presented and when),
   and the token endpoint, client ID and issuer. Secrets stay in the keychain or the
   Keystore-sealed preferences, never in the app-group files.
2. **The app refreshes through native code.** A matrix-js-sdk patch replaces
   `TokenRefresher.getNewTokens` with an injected coordinator on iOS and Android: "refresh
   if the pair is still `<presented access token>`, otherwise return the current pair". Web
   and Electron keep the SDK's own refresher.
3. **The app re-reads before it signs out.** On `M_UNKNOWN_TOKEN` the patched SDK asks the
   coordinator for the current pair before applying its "not yet expired, therefore logout"
   rule. On restore and on resume the app reads the pair from the native store, not from its
   own secure-storage copy.
4. **The renderer refreshes only when the token has expired or is about to,** and only when it
   gets the lock within a short wait (well under its 5 s budget). It never waits for the app.
   When it cannot get the lock it falls back as it does today.
5. **Fencing.** A holder writes the rotated pair only if the generation it read is still
   current; after losing the lease it throws its result away and re-reads. An expired lease
   with an in-flight marker means "retry the same refresh token". The spec guarantees that
   retry, and MAS implements it by revoking the unused pair. Optimistic concurrency without a
   lock is not enough: the server-side effect of the losing request cannot be undone.
6. **A refusal from the renderer never signs anything out.** On `invalid_grant` the renderer
   marks the entry stale and falls back. Only the app, after re-reading, decides about
   sign-out.
7. **Sign-out.** The entry is removed first, as today. A tombstone or generation bump stops an
   in-flight refresh from writing the account back. Then the app revokes the tokens at the
   provider.

The lock is where Android and iOS differ. On Android a `Mutex` in the plugin, taken by both the
service and the JavaScript bridge call, is enough. On iOS the lock is cross-process and must be
a lease (see Constraints); the generation check could use a keychain `SecItemUpdate` whose query
matches the expected generation attribute, or the leased lock in the native crypto store that
#1153 introduces. Both need a spike.

- **Privacy and security:** adds a long-lived, bearer-equivalent credential to an
  extension-readable store; see [Threat model](#threat-model). Nothing new leaves the device.
- **Robustness:** good once the protocol is right; poor if any part is skipped, and the failure
  is a destructive sign-out. Needs deterministic race tests on both platforms and a device check.
- **Effort:** high. Native OAuth refresh in Kotlin and Swift, the lock and fencing, the SDK patch
  for the coordinator and the 401 re-read, moving the token authority on mobile, and tests.
- **Non-MAS homeservers:** relies only on spec behaviour (rotation, retry after a lost response),
  so it is portable if the lock is never bypassed. It must not rely on MAS tolerating
  concurrent refreshes by two holders; the retry in step 5 is the spec's lost-response retry by
  the single holder of the lock, not a second refresher.
- **#1153/#1154:** a direct fit. #1154 already needs a valid token in the extension, for a
  to-device sync that brings missing room keys, as well as a cross-process lock and a shared
  sync position. Element X uses one lock for all three. Building (a3) separately first risks two
  lock designs.

### (b) A server-side fetcher

A companion service, or the push gateway, holds each account's tokens, fetches the event and
pushes rendered text.

- **Privacy and security:** the operator then holds a live credential for every user and sees
  every unencrypted message. That reverses the current boundary, where the gateway sees
  identifiers and counts only ([push reference](../maintenance/push-notifications.md)).
- **Robustness:** the server becomes a second refresher on the same single-use token, so the
  rotation race moves across the network. It would have to be the only refresher, and then the
  app could not refresh at all.
- **Effort:** high, plus an operated service. **Non-MAS:** works. **#1153/#1154:** no help;
  the server has no room keys, and should not.

Not recommended.

#### (b2) Full-content pushes instead of `event_id_only`

The homeserver can send the event content itself (sender, `sender_display_name`, `room_name`,
`content`) when the pusher omits `format: event_id_only`
([pusher `format`](https://spec.matrix.org/v1.19/client-server-api/#post_matrixclientv3pushersset),
[push gateway API](https://spec.matrix.org/v1.19/push-gateway-api/)). The renderer then needs
no token for unencrypted rooms, and has the sender and ciphertext for encrypted ones.

- **Privacy and security:** message text for unencrypted rooms, sender and room names pass
  through the Trinity gateway and through Firebase, which relays iOS pushes as well. Encrypted
  rooms carry only ciphertext. MSC3013 (homeserver-encrypted push) was closed as rejected in
  2026 ([MSC3013](https://github.com/matrix-org/matrix-spec-proposals/pull/3013)); MSC4174
  web push is still in review and does not apply to FCM or APNs
  ([MSC4174](https://github.com/matrix-org/matrix-spec-proposals/pull/4174)).
- **Robustness:** no token dependency for text that fits the payload; FCM and APNs payloads are
  limited to about 4 KB, so large events still need a fetch.
- **Effort:** low to medium (pusher format, render from payload, gateway forwarding).
  **Non-MAS:** universal. **#1153/#1154:** would let #1154 decrypt from the push when the
  room key is already present, without a fetch; missing keys still need a token.

A real alternative, but it trades a local credential risk for a remote privacy cost, and the
change in privacy stance is the owner's call. Not recommended by default.

### (c) Longer-lived or narrowly scoped tokens

- **Longer lifetimes** are server configuration (`experimental.access_token_ttl` in MAS, one
  value for every client). Trinity cannot request them, and matrix.org is unlikely to raise them
  for one client.
- **Scoped tokens** do not exist: MSC2967 has only full client-server access, and MAS adds
  only admin scopes (`urn:synapse:admin:*`, `urn:mas:admin`). A future "read events" scope would
  still be a short-lived token with its own refresh token, and so its own rotation chain.
- **MAS personal access tokens** (MAS 1.5+) are issued through the MAS Admin API by an
  administrator ([v1.5.0 release notes](https://github.com/element-hq/matrix-authentication-service/releases/tag/v1.5.0)),
  not by a client grant.
- **Compatibility:** none of these exists outside MAS.

Not available today. An MSC for a notification scope would only reduce the blast radius; it would
not remove the refresh problem.

### (d) Accept generic text for OIDC accounts (status quo, made clearer)

Keep the renderers token-only. Cheap improvements:

- Hand off the access-token expiry, which is not secret. The renderer can then skip a fetch that
  is bound to fail, saving its 5 s budget and battery.
- Choose the fallback by cause. An expired token could read "Open Trinity to read this message"
  rather than "New message"; the wording needs a product decision.
- Say in the user docs that closed-app previews on OIDC homeservers last only a few minutes after
  Trinity was last open.

Assessment:

- **Privacy and security:** unchanged. **Robustness:** never signs anyone out.
  **Effort:** low. **Non-MAS:** universal. **#1153/#1154:** no conflict; #1154 lists "a token
  expired since the last app run" among its fallbacks already.

### (e) Other options

- **(e1) Refresh before going to the background.** Refresh when the app is paused, so the stored
  token lasts a full lifetime from that moment. It buys at most one lifetime (five minutes on
  MAS defaults), and matrix-js-sdk has no public OAuth refresh call (`client.refreshToken()` exists but uses the
  legacy MSC2918 `/refresh` endpoint), so it needs the same SDK patch point. Cheap, and worth having, but small.
- **(e2) OS-scheduled refresh while closed.** Android's periodic WorkManager work runs at most
  every 15 minutes
  ([`PeriodicWorkRequest`](https://developer.android.com/reference/androidx/work/PeriodicWorkRequest)),
  and iOS decides on its own when a `BGAppRefreshTask` runs
  ([`BGAppRefreshTaskRequest`](https://developer.apple.com/documentation/backgroundtasks/bgapprefreshtaskrequest)).
  Both are slower than a 5-minute lifetime, and each is another refresher that needs the (a3)
  lock anyway. Not recommended alone.
- **(e3) A separate session for the renderer.** A second OAuth session gives the renderer its
  own rotation chain, so there is no race. The cost is a second browser consent per account (a
  device-code grant), an extra device in the user's session list and in MAS session limits, and
  no crypto identity, so it is useless for #1154. Not recommended.
- **(e4) Sender-constrained refresh tokens (DPoP, [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)).**
  A refresh token bound to a Keystore or Secure Enclave key is worthless if exfiltrated. MAS
  does not support DPoP yet
  ([element-hq/matrix-authentication-service#24](https://github.com/element-hq/matrix-authentication-service/issues/24)).
  Worth adopting later as hardening for (a3); not a solution now.

### Trade-offs

| Option                        | Privacy and security                                    | Robustness                                   | Effort      | Non-MAS homeservers        | #1153/#1154 fit                   |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------------- | ----------- | -------------------------- | --------------------------------- |
| (a1) two refreshers           | refresh token at rest in shared store                   | destructive sign-outs                        | medium      | worse on strict servers    | none                              |
| (a2) refresh only when closed | as (a3)                                                 | "closed" is not detectable; becomes (a3)     | high        | as (a3)                    | as (a3)                           |
| (a3) one authority + lock     | refresh token at rest in shared store, on-device only   | good if the protocol holds; needs race tests | high        | spec-only, portable        | same lock and token #1154 needs   |
| (b) server-side fetcher       | operator holds every user's credential and plaintext    | still races the app                          | high + ops  | works                      | none; server has no keys          |
| (b2) full-content push        | plaintext of unencrypted rooms via gateway and Firebase | good within 4 KB                             | low–medium  | universal                  | push carries ciphertext for #1154 |
| (c) longer/scoped tokens      | n/a                                                     | not available                                | n/a         | no                         | none                              |
| (d) generic text, clearer     | unchanged                                               | cannot sign out                              | low         | universal                  | already #1154's fallback          |
| (e1) refresh on background    | unchanged                                               | one more lifetime only                       | low         | universal                  | none                              |
| (e2) OS periodic refresh      | as (a3)                                                 | slower than token lifetime                   | medium      | universal                  | needs the (a3) lock               |
| (e3) separate session         | second credential, extra device                         | no race                                      | medium + UX | if device grant offered    | useless for decryption            |
| (e4) DPoP                     | best: token bound to device key                         | as (a3)                                      | high        | needs DPoP-capable servers | hardening for (a3)                |

## Threat model

**Asset.** An OIDC refresh token can mint full-scope access tokens for its device until the
session is revoked or expires for inactivity (MAS `experimental.inactive_session_expiration`,
off by default). It is bearer-equivalent: no client secret binds it.

**Today's baseline.** The handoff store already holds a full-scope bearer token. For password
and SSO accounts that token never expires. For OIDC accounts it lives about five minutes. The
app's own copy of every token sits in the app's private keychain group with
`whenUnlockedThisDeviceOnly` ([`secure-storage.service.ts`](../../libs/platform-native/src/lib/secure-storage.service.ts)),
which the extension cannot read. A refresh token in the handoff store raises an OIDC account to
roughly what a password account already exposes there, with two differences. It can mint new
tokens, and theft is detectable, because rotation makes the thief and the app collide.

**Where it would sit and who can read it.**

- **iOS keychain, shared access group.** Readable by the app and the extension (same team, same
  entitlement). The extension needs `AfterFirstUnlock`, a weaker class than the app copy's
  `WhenUnlocked`. An after-first-unlock forensic extraction of a seized phone can read it; a
  locked-before-first-unlock phone cannot. The current handoff items use
  `kSecAttrAccessibleAfterFirstUnlock`, which Apple documents as migrating "to a new device when
  using encrypted backups". `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` does not
  migrate ([Apple](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly)).
  A refresh token must use the `ThisDeviceOnly` class, and the existing access-token items
  should move to it as well.
- **iOS app-group container.** Readable by every target in the group and included in device
  backups subject to file protection. It must never hold the refresh token; lock leases and
  generation counters with no secrets may live there.
- **Android.** AES-256-GCM under a non-exportable Android Keystore key, in app-private
  credential-encrypted storage, available after first unlock. Backup and device transfer are
  excluded (`android:allowBackup="false"`, `data_extraction_rules.xml`, `backup_rules.xml`). A
  rooted device or code running as the app's UID can use the key without exporting it.
- **The bridge.** If the app writes the refresh token through the plugin, the Capacitor bridge
  logs could carry it. `capacitor.config.ts` sets `loggingBehavior: 'none'` unless
  `TRINITY_CAPACITOR_LOGS=1`; that must stay. With (a3) the token crosses the bridge once at
  sign-in, or never, if native code performs the code exchange later.

**Out of scope.** A compromised app process or a jailbroken or rooted device can read either
copy; this change does not alter that.

**Detection and response.** On a rotating server, a stolen refresh token used by an attacker
makes the legitimate holder's next refresh fail. That sign-out is the intended outcome of
rotation, but today Trinity takes the hard path for it (`soft_logout: false`), which wipes the
account's crypto store and loses keys missing from backup. (a3)'s re-read should therefore turn
a refused refresh into a soft logout that keeps the stores for re-authentication. The user then
signs in again, and, on a strict server, the session is revoked.

## Recommendation

1. **Answer the owner question "yes, under conditions"** (below). Element X stores the full
   session in a keychain group its extension can read, and the threat added over today's handoff
   store is modest, provided the storage class is `ThisDeviceOnly` and nothing else changes.
2. **Do not build a refresh lock on its own.** Design one lock with the #1153 spike: native token
   authority, crypto store and sync position, as #1154 needs. Implement (a3) on top of it. If the
   owner wants previews for OIDC accounts sooner, Android can go first: its renderer shares the
   app process, so an in-process mutex is enough, and that keeps iOS for the shared lock.
3. **Now, at low cost:** (d), meaning the expiry handoff, a cause-specific fallback and user
   docs; (e1), refreshing on pause, if the SDK patch point is small; and moving the handoff
   keychain items to `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
4. **Measure first** (#1152 step 5): matrix.org's and other target servers' access-token
   lifetimes, and how long closed-app previews last on a real phone with an OIDC account.
5. **Keep `event_id_only`** unless the owner prefers (b2)'s privacy trade.

## Owner decision needed

The open question from #1163: **may OIDC refresh tokens go in the native push handoff store?**
Proposed answer: yes, if every condition below holds. If any does not, the answer is no, and (d)
stands.

1. **Store refresh tokens in the native handoff store under these conditions?**
   1. One refresher at a time per account, enforced by a lock that the app and the renderer both
      take before presenting a refresh token. No uncoordinated or optimistic second refresher.
   2. The native store is the only authority for an OIDC account's token pair on iOS and
      Android. The app reads it on restore and resume, and re-reads it on every
      `M_UNKNOWN_TOKEN` before any sign-out decision (matrix-js-sdk patch).
   3. The rotated pair is written back before the lock is released, fenced by a generation check;
      a holder that lost its lease discards its result.
   4. The renderer refreshes only an expired or nearly expired token, waits for the lock only
      briefly, never signs anything out, and falls back on any failure.
   5. Storage: iOS shared keychain group with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`,
      never the app-group files; Android Keystore AES-GCM with backup and device transfer
      excluded; no logging of tokens anywhere, and Capacitor bridge logging stays off.
   6. Sign-out removes the entry first and cannot be undone by an in-flight refresh; revocation
      at the provider follows.
   7. The design relies only on spec guarantees (rotation, retry after a lost response), never on
      MAS tolerating concurrent refreshes of one refresh token by two holders. It is proven by deterministic race tests (JUnit, XCTest)
      and an on-device check with an OIDC account.
2. **Sequencing:** build (a3) on the #1153/#1154 lock (recommended), or ship an Android-only
   in-process version earlier?
3. **Interim:** approve (d) and (e1) now, including the user-facing fallback wording for an
   expired token?
4. **Existing items:** move the current handoff keychain items to
   `AfterFirstUnlockThisDeviceOnly` now, independently of this decision?
5. **Push format:** keep `event_id_only` (recommended), or allow full-content pushes (b2) and
   accept that the gateway and Firebase see unencrypted text?

## Open questions

- What access-token lifetime do matrix.org and the other target homeservers issue, and how long
  do closed-app previews last on a real phone? (#1152 step 5)
- Does the native crypto layer chosen in #1153 (`matrix-sdk-crypto-ffi` and the Android
  artifact) expose its leased cross-process store lock, or does Trinity need its own lease in
  the app group?
- Is a keychain `SecItemUpdate` filtered on a generation attribute an atomic compare-and-swap
  across the app and the extension? It would make the iOS fencing cheap.
- How small can the matrix-js-sdk patch be: a coordinator for `getNewTokens`, plus a re-read
  before the "unexpired token, therefore logout" rule in `_handleUnknownToken`?
- Should native code perform the authorization-code exchange at sign-in, so the refresh token
  never crosses the bridge at all?
- With inactivity expiry enabled on a server, a renderer refresh counts as session activity in
  MAS. Is keeping a closed app's session alive through notifications acceptable?

## Sources

- Trinity: [#1163](https://github.com/quwisky/trinity-matrix-client/issues/1163),
  [#1153](https://github.com/quwisky/trinity-matrix-client/issues/1153),
  [#1154](https://github.com/quwisky/trinity-matrix-client/issues/1154),
  [#1152](https://github.com/quwisky/trinity-matrix-client/issues/1152), PR
  [#1157](https://github.com/quwisky/trinity-matrix-client/pull/1157), and the
  [push reference](../maintenance/push-notifications.md).
- Matrix specification v1.19:
  [refresh token grant](https://spec.matrix.org/v1.19/client-server-api/#refresh-token-grant),
  [pushers](https://spec.matrix.org/v1.19/client-server-api/#post_matrixclientv3pushersset),
  [push gateway API](https://spec.matrix.org/v1.19/push-gateway-api/).
- MSCs: [MSC3861](https://github.com/matrix-org/matrix-spec-proposals/pull/3861) (next-generation
  auth), [MSC2965](https://github.com/matrix-org/matrix-spec-proposals/pull/2965) (auth metadata
  discovery), [MSC2967](https://github.com/matrix-org/matrix-spec-proposals/pull/2967) (API
  scopes), [MSC2918](https://github.com/matrix-org/matrix-spec-proposals/pull/2918) (refresh
  tokens), [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108) (QR sign-in,
  open; relevant only to how a second device obtains a session),
  [MSC3013](https://github.com/matrix-org/matrix-spec-proposals/pull/3013) (encrypted push,
  rejected), [MSC4174](https://github.com/matrix-org/matrix-spec-proposals/pull/4174) (web push).
- OAuth: [RFC 6749 §6 and §10.4](https://www.rfc-editor.org/rfc/rfc6749#section-10.4),
  [RFC 9700 §4.14](https://www.rfc-editor.org/rfc/rfc9700#section-4.14) (BCP 240),
  [OAuth 2.1 draft 16 §4.3.1, §4.3.3 and §10](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-16#section-4.3.1),
  [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449) (DPoP).
- MAS: [configuration reference](https://element-hq.github.io/matrix-authentication-service/reference/configuration.html),
  [refresh token grant](https://github.com/element-hq/matrix-authentication-service/blob/2277a37c5928eb08de4781b6e602a8a6c81bcca1/crates/handlers/src/oauth2/token.rs#L624-L803),
  [introspection marks tokens used](https://github.com/element-hq/matrix-authentication-service/blob/2277a37c5928eb08de4781b6e602a8a6c81bcca1/crates/handlers/src/oauth2/introspection.rs#L359-L364),
  [DPoP issue #24](https://github.com/element-hq/matrix-authentication-service/issues/24),
  [v1.5.0 personal sessions](https://github.com/element-hq/matrix-authentication-service/releases/tag/v1.5.0).
- Synapse: [MAS delegated auth, inactive token](https://github.com/element-hq/synapse/blob/c0805eabb1bda3b1ffc370fec35a73d524674d60/synapse/api/auth/mas.py#L332-L333).
- Element X and matrix-rust-sdk:
  [`ClientFactory.swift`](https://github.com/element-hq/element-x-ios/blob/14e33866ced2456f99a0039087363357d946c551/ElementX/Sources/Services/Client/ClientFactory.swift#L118-L120),
  [`KeychainController.swift`](https://github.com/element-hq/element-x-ios/blob/14e33866ced2456f99a0039087363357d946c551/ElementX/Sources/Services/Keychain/KeychainController.swift),
  [`cross_process.rs`](https://github.com/matrix-org/matrix-rust-sdk/blob/b3c07ea6ba6e8e46e30811c0500b04505c4be9f9/crates/matrix-sdk/src/authentication/oauth/cross_process.rs).
- Apple: [`kSecAttrAccessibleAfterFirstUnlock`](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlock),
  [`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly),
  [`BGAppRefreshTaskRequest`](https://developer.apple.com/documentation/backgroundtasks/bgapprefreshtaskrequest),
  [`0xdead10cc` forum thread](https://developer.apple.com/forums/thread/655225).
- Android: [service `android:process`](https://developer.android.com/guide/topics/manifest/service-element#proc),
  [`PeriodicWorkRequest`](https://developer.android.com/reference/androidx/work/PeriodicWorkRequest),
  [Android Keystore](https://developer.android.com/privacy-and-security/keystore).
- matrix-js-sdk 43.0.0 as installed: `src/http-api/refresh.ts`, `src/oauth/tokenRefresher.ts`,
  `src/oauth/fetch.ts`, with `patches/matrix-js-sdk@43.0.0.patch`.
