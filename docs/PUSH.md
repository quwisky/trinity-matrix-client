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
`event_id_only` push format, so the gateway sends only `room_id` + `event_id` (no
message content) and the client fetches the event after sync.

## Client implementation (done)

- **`PushService`** (`@trinity/data-access-notifications`, `push.service.ts`): requests OS push permission,
  registers for a device token via `@capacitor/push-notifications`, and registers a
  matching Matrix pusher **on every signed-in account** (`client.setPusher`,
  `app_id = <base>.<platform>`, `kind:'http'`). All accounts share the one device token
  as the `pushkey`; each pusher tags its `data` with the owning account:
  `data:{ url, format:'event_id_only', trinity_user_id: <userId> }`. Deletes the
  pusher(s) + detaches listeners on logout (`removePusher`). A notification tap switches
  to the tagged account (`trinity_user_id`) and opens the room (`room_id`) before
  showing it.
- **Config token `PUSH_CONFIG`**: the app provides it from `environment.push`
  (`main.ts`). **`null` disables push** — the service is then a clean no-op.
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
  is configured, mobile push still delivers, but a tap can't switch accounts — it opens
  whichever account is active. This is the remaining piece of Milestone 8 (`docs/MULTI-ACCOUNT.md`).
  - **Privacy note (gateway trust).** Because `trinity_user_id` is the account's Matrix
    id and every account's pusher shares one device `pushkey`, the gateway operator can
    map the device token to a specific MXID and link all of a device's accounts together.
    The MXID is public and no message content is exposed (`event_id_only`), so this is
    expected for a **self-hosted** gateway; for a shared/third-party gateway it is a
    metadata-privacy tradeoff. If that matters, swap the raw MXID for a per-account opaque
    routing id resolved back to the account client-side on tap.

## Enabling it (external setup — required)

Push delivers nothing until a gateway is deployed and credentials are provisioned.
None of this can be tested on the iOS Simulator or on web/Electron.

1. **Deploy a Sygnal push gateway** and note its notify endpoint, e.g.
   `https://push.example/_matrix/push/v1/notify`.
2. **Set `environment.push`** (and `environment.prod.ts`):
   ```ts
   push: { gatewayUrl: 'https://push.example/_matrix/push/v1/notify', appId: 'eu.qwky.trinity' },
   ```
   `PushService` appends `.ios` / `.android` to `appId`; these per-platform ids must
   match the app keys configured in Sygnal.
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
- **Token rotation** leaves the previous pusher on the homeserver until logout.
- The full token → `setPusher` → Sygnal → delivery loop needs **on-device verification**.
