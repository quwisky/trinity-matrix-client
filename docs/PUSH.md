# Push notifications

How Trinity wires Matrix push, what's implemented, and what external setup is needed
to actually deliver notifications. Architecture context: [ARCHITECTURE.md](ARCHITECTURE.md).

## How it works

```
homeserver ──(push rules match)──► push gateway (Sygnal) ──► FCM / APNs ──► device
     ▲                                                                        │
     └────────────── client.setPusher (pushkey = device token) ◄─────────────┘
```

The client registers a **pusher** with the homeserver pointing at a **push gateway**
([Sygnal](https://github.com/matrix-org/sygnal)). The gateway holds the FCM (Android)
and APNs (iOS) credentials and forwards matched events to the device using the device
token the client registered as the pusher's `pushkey`. Trinity uses the
`event_id_only` push format, so the gateway sees only identifiers — `room_id`,
`event_id`, unread `counts` and a `prio` flag — never message content, sender or type;
the client fetches the event after sync.

## Client implementation (done)

- **`PushService`** (`@trinity/data-access-notifications`, `push.service.ts`): requests OS push permission,
  registers for a device token via `@capacitor/push-notifications`, and registers a
  matching Matrix pusher **on every signed-in account** (`client.setPusher`,
  `app_id = <base>.<platform>`, `kind:'http'`, `append:true`). All accounts share the one
  device token as the `pushkey`; each pusher tags its `data` with the owning account:
  `data:{ url, format:'event_id_only', trinity_user_id: <userId> }`. Deletes the
  pusher(s) + detaches listeners on logout (`removePusher`). A notification tap switches
  to the tagged account (`trinity_user_id`) and opens the room (`room_id`) before
  showing it.
  - **`append` must be `true`.** It governs pushers belonging to _other users_ for the
    same `(app_id, pushkey)` — and since every account here shares one device token,
    `append:false` makes each account in the loop delete the previous one's pusher
    whenever two accounts live on the same homeserver, leaving only the last registered
    able to receive push. It does not duplicate this user's own pusher: the homeserver
    replaces that unconditionally on the `(app_id, pushkey)` key, so a repeat
    `register()` stays at one pusher per account. Both halves verified against Synapse.
- **Config resolution**: `PushService` reads the gateway from `PushGatewayService`, whose
  `effective()` resolves `user override ?? PUSH_CONFIG ?? null`. `PUSH_CONFIG` is the
  build-time default (`environment.push`, provided in `main.ts`); the override is the
  per-device value a user sets in Settings (below). **`null` from both disables push** —
  the service is then a clean no-op. Because a stock build ships `environment.push` as
  `null`, the settings override is the path that takes push from dead to live without a
  rebuild.
- **Native-only + guarded**: registration runs only on `getPlatform() ∈ {ios, android}`
  with the plugin available. It is deliberately **not** gated on `isNativePlatform()`,
  which is `false` under Electron (where there is no push plugin). Web and desktop no-op.
- **Lifecycle**: `register()` is called from the rooms shell (`rooms.page`), which
  mounts after a fresh login and a restored session; once the device token is known a
  repeat call re-applies pushers for **all** accounts, so an account added later gets
  its pusher too (the add-account flow also calls it). `unregister(userId)` removes just
  that account's pusher on per-account sign-out; `unregister()` (no id) removes every
  account's pusher and detaches listeners on full logout.
- **Multiple accounts need a gateway change (external dependency).** Every account's
  pusher shares one FCM/APNs token, so the gateway receives pushes for several accounts
  keyed by the same `pushkey`. **Sygnal must forward the pusher's `data.trinity_user_id`
  into the delivered push payload's `data`** so the device can attribute the notification
  to the right account (the tap-to-switch above reads `data.trinity_user_id`). Until that
  is configured, each account's pusher is still registered, but a tap can't attribute the
  notification — it opens whichever account is active. This is the remaining piece of
  Milestone 8 (`docs/MULTI-ACCOUNT.md`).
  - **Privacy note (gateway trust).** The strongest correlator the operator receives is
    the device `pushkey` — a globally-unique per-install token every account's pusher
    shares — so it can link all of a device's accounts as one person regardless of any
    id. On top of that, `trinity_user_id` hands it each account's MXID directly, and the
    per-notification payload carries `room_id`, `event_id`, `prio` and unread `counts`,
    which fingerprint activity (how many rooms, which are busy, waking hours, DM vs
    group) even though message content stays off the gateway (`event_id_only`). This is
    expected for a **self-hosted** gateway; for a shared/third-party one it is a
    metadata-privacy tradeoff, which the settings trust dialog (below) spells out before
    the user commits. If it matters, swap the raw MXID for a per-account opaque routing
    id resolved back to the account client-side on tap — the `pushkey` linkage remains,
    as it is unavoidable while all accounts share one device token.

## Setting a gateway from the app

**Settings → Notifications → Push gateway (this device)** lets a user point mobile push
at a gateway they run or trust, instead of baking one into the build. Owned by
`PushGatewayService`; the block is `PushGatewayBlockComponent`.

- **Device-local**, in Capacitor `Preferences` (key `trinity.push.gateway`) — deliberately
  not Matrix account data. `app_id` is per-platform and the `pushkey` is this install's
  device token, so a gateway config cannot travel to another device or platform; syncing
  it would sync a value that is meaningless there. Not secure storage either — the URL is
  published to the homeserver as `pusher.data.url` and readable back via `GET /pushers`,
  so it is not a secret and the UI must not imply it is.
- **URL validation** (`normalizeGatewayUrl`, pure + unit-tested against what Synapse
  actually accepts): a bare origin or a stray trailing slash is normalised to
  `…/_matrix/push/v1/notify` (the path is an **exact** match server-side — a sub-path
  prefix or trailing slash is a 400), embedded credentials are rejected, and `http://` is
  permitted but flagged (Synapse allows it and a LAN gateway is the audience). None of
  this is a security control — the **homeserver**, not the client, makes the outbound
  request, and any user can POST to `/pushers/set` directly — it catches typos.
- **App ID** is an advanced field (`PushConfig.appId`), defaulting to `DEFAULT_APP_ID`
  (`eu.qwky.trinity`). A gateway keyed under another id needs it set. Changing it is the
  one case that strands a pusher: identity is `(user_id, app_id, pushkey)`, so a changed
  app id creates a second pusher and the old keeps delivering. `PushGatewayService`
  records the last-written id (`appliedAppId`, persisted so it survives a kill mid-change)
  and `setPushers()` removes the stale pusher **before** setting the new one.
- **Trust dialog** (`PushGatewayTrustDialogComponent`) on saving a custom URL: names the
  gateway host and lists what its operator can and cannot see (see the privacy note
  above), because moving the gateway choice to the user moves that trust decision too.
- **Status line** reads `PushService.registration` (`idle | applied | error`). After a
  successful round `setPushers()` reads the pushers back (`getPushers()`) to confirm the
  homeserver kept them — the only delivery-adjacent check the client can make. It reports
  **registration, never delivery**: the gateway → FCM/APNs → device leg is invisible from
  the client, so a green state says "the pushers were accepted", not "a notification will
  arrive".

The gateway still has to exist and hold APNs/FCM credentials — the section below is how to
stand one up; this is just where a user points at it.

## Enabling it (external setup — required)

Push delivers nothing until a gateway is deployed and credentials are provisioned.
None of this can be tested on the iOS Simulator or on web/Electron.

1. **Deploy a Sygnal push gateway** and note its notify endpoint, e.g.
   `https://push.example/_matrix/push/v1/notify`.
2. **Point the app at it**, either as a build default in `environment.push` (and
   `environment.prod.ts`) or per-device in Settings → Notifications (above):
   ```ts
   push: { gatewayUrl: 'https://push.example/_matrix/push/v1/notify' },
   ```
   `PushService` appends `.ios` / `.android` to the base app id; these per-platform ids
   must match the app keys configured in Sygnal. `appId` is **optional** and defaults to
   `eu.qwky.trinity` (`DEFAULT_APP_ID`), which is the app's own bundle id and what the
   Sygnal setup in steps 3-4 registers — so only set it for a gateway that registered
   this app under some other key. Keep the default in step with `capacitor.config.ts`,
   `android/app/build.gradle` and the Xcode `PRODUCT_BUNDLE_IDENTIFIER` if the bundle id
   ever changes.
3. **Android (FCM)**:
   - Create a Firebase project; add an Android app with package **`eu.qwky.trinity`**.
   - Download `google-services.json` → `android/app/google-services.json`.
     (Gradle is already wired: the google-services classpath + conditional apply are
     present; `POST_NOTIFICATIONS` is declared in the manifest.)
   - Configure Sygnal's FCM app key as `eu.qwky.trinity.android`.
4. **iOS (APNs)** — needs an Apple Developer account and a **real device**:
   - Create an APNs **auth key (.p8)**; give the Key ID + Team ID + `.p8` to Sygnal's
     `apns` config (app key `eu.qwky.trinity.ios`). Enable Push Notifications on the App ID.
   - In Xcode (App target → Signing & Capabilities) add **Push Notifications** and
     **Background Modes → Remote notifications**. `AppDelegate.swift` already forwards
     the APNs registration callbacks the plugin needs.
5. **Sync + rebuild the native apps** (mandatory after the dependency/config changes):
   ```bash
   pnpm build && pnpm exec cap sync   # registers the plugin; updates iOS SPM
   ```
   Then a full native rebuild + reinstall on device (not just `cap copy`).

## Local notifications (desktop + web)

`NotificationService` (`@trinity/data-access-notifications`) surfaces incoming messages as OS notifications
driven by the **live sync stream** — on desktop (Electron) via the main process over the `trinityDesktop` bridge, on web/PWA via the Web `Notification` API — no push gateway
involved. It runs on **desktop (Electron) and web/PWA** (`!isNativePlatform()`); on
mobile, push (above) owns delivery, so it's a no-op there. It fires only for **live**
timeline events from someone other than you, unless the user is looking at that room (the window is focused and that room is open), and only
when the account's push rules say to notify (`getPushActionsForEvent().notify` — honors
mutes / mentions-only). A tap focuses the window and opens the app. Connected from the
rooms shell; the listener dies with the client on logout. This is the desktop story — it
needs no gateway because a desktop/web client stays connected to `/sync`.

**Background delivery (Electron):** the desktop shell keeps notifying while
backgrounded. Closing the window **hides it to the system tray** (the process,
renderer, and `/sync` stay alive) rather than quitting, and the window is created with
`backgroundThrottling: false` so Chromium doesn't throttle the `/sync` long-poll when
the window is minimized/hidden. A real quit is available from the tray menu / app menu.
On web/PWA, notifications fire while the tab is open but unfocused (no background
process when the tab is closed).

> **macOS:** OS notifications only appear when the app is **signed (Developer ID) and
> notarized** — an unsigned/ad-hoc build is silent. See
> [DEVELOPMENT.md → macOS signing & notarization](DEVELOPMENT.md#macos-signing--notarization)
> for the signed build script and credentials.

## Mobile push without your own gateway

A Matrix client always needs an HTTP push **gateway** between the homeserver and APNs/FCM
(the homeserver can't talk to APNs/FCM directly), and matrix.org's public Sygnal only
serves Element's app ids — not a custom app. Options to avoid running your own gateway:

- **Android — UnifiedPush.** The user installs a distributor (ntfy, NextPush, …) that
  holds the connection; the app registers a pusher pointing at the **distributor's**
  gateway, not yours. No server to operate. Needs a native UnifiedPush connector (no
  off-the-shelf Capacitor plugin) + a distributor picker; the `setPusher` shape is the
  same as FCM, so it's an additive change to `PushService`.
- **Android — foreground service.** Keep `/sync` alive in a foreground service and raise
  local notifications; zero push infra, at the cost of a persistent notification + battery.
- **iOS — not possible.** APNs is mandatory for background delivery and requires a gateway
  holding your APNs key; there's no UnifiedPush/background-socket escape for a custom app.

## Known limitations / follow-ups

- **Web Push** is not implemented (would need a VAPID/Web-Push pushgen + the service
  worker); for web, the local notifications above cover the foreground/tab case.
- **Per-account push attribution** needs the Sygnal change described above (forward
  `data.trinity_user_id`). Without it, a tapped mobile push can't switch accounts. The
  client side (one tagged pusher per account, tap-to-switch) is in place.
- **Notification tap** routes to `/rooms?room=<room_id>`; the client uses the room
  query param to open the room where the route supports it.
- **Foreground** pushes aren't surfaced separately — the live sync already updates the UI.
- **Token rotation** leaves the previous pusher on the homeserver until logout. (An
  app-id _change_ is cleaned up — `setPushers()` removes the stale pusher — but a rotated
  device token is a new `pushkey`, a different orphan class this does not sweep.)
- **User-set gateway** ships (Settings → Notifications, above): validated URL + optional
  app id, a trust dialog, and a `getPushers()` readback. What it cannot verify is
  delivery — see the next point.
- The full token → `setPusher` → Sygnal → delivery loop needs **on-device verification**:
  a real device, a deployed gateway, and APNs/FCM credentials. It cannot be exercised in
  CI, on the iOS Simulator, or on web/Electron, so it ships unverified end to end. The
  client-side pieces (registration, the readback, the app-id swap) are verified against a
  disposable Synapse; everything past the homeserver's outbound POST is not.
