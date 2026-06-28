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

- **`PushService`** (`@trinity/core`, `push.service.ts`): requests OS push permission,
  registers for a device token via `@capacitor/push-notifications`, and registers a
  matching Matrix pusher (`client.setPusher`, `app_id = <base>.<platform>`, `kind:'http'`,
  `data:{ url, format:'event_id_only' }`). Deletes the pusher + detaches listeners on
  logout (`removePusher`). A notification tap opens the app.
- **Config token `PUSH_CONFIG`**: the app provides it from `environment.push`
  (`main.ts`). **`null` disables push** — the service is then a clean no-op.
- **Native-only + guarded**: registration runs only on `getPlatform() ∈ {ios, android}`
  with the plugin available. It is deliberately **not** gated on `isNativePlatform()`,
  which is `true` under Electron (where there is no push plugin). Web and desktop no-op.
- **Lifecycle**: `register()` is called from the rooms shell (`rooms.page`), which
  mounts after both a fresh login and a restored session; it's idempotent per session.
  `unregister()` runs on logout (before the token is invalidated) and on re-login into
  a different account (so the new account gets its own pusher).

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

## Known limitations / follow-ups

- **Web Push** is not implemented (would need a VAPID/Web-Push pushgen + the service
  worker); web is a no-op today.
- **Desktop (Electron)** is skipped; a future enhancement could surface local
  `Notification`s from live sync instead of an HTTP pusher.
- **Notification tap** opens `/rooms`; room-targeted navigation is a follow-up (rooms
  aren't deep-linkable by route yet).
- **Foreground** pushes aren't surfaced separately — the live sync already updates the UI.
- **Token rotation** leaves the previous pusher on the homeserver until logout.
- The full token → `setPusher` → Sygnal → delivery loop needs **on-device verification**.
