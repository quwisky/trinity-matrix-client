# Push notifications

Trinity has three separate notification systems that people routinely confuse with each
other: the **push rules** that decide whether an event is worth notifying about, the
**local notifications** that a permanently-connected client raises itself, and the
**mobile push** path that wakes a phone that is not connected at all. Only the last one
needs an operator to deploy anything.

## The three layers

| Layer               | Owns                                                            | Runs on                       |
| ------------------- | --------------------------------------------------------------- | ----------------------------- |
| Push rules          | Whether an event should notify at all, per account and per room | Every platform, server-side   |
| Local notifications | Turning a live sync event into an OS toast                      | Desktop and web, never mobile |
| Mobile push         | Waking the app when it is not running                           | iOS and Android only          |

Push rules are Matrix account data, so they are shared by every client the user signs in
with. The other two layers are delivery mechanisms and are per-install.

### Push rules

Three services in `@trinity/data-access/notifications` write push rules, and they are
deliberately separate because they address different rule buckets.

`RoomNotificationsService` maps a per-room mode onto rules. `all` is the absence of any
room rule. `mentions` is a room-kind `dont_notify` rule, which leaves the override
highlight rules free to fire. `mute` is an **override** `dont_notify` rule, because
overrides are evaluated ahead of the highlight rules and a room-kind rule would not
silence a mention. After a write it refreshes the client's cached ruleset, so the UI
shows the new level without waiting for the `m.push_rules` sync echo. It also listens for
that account-data event on every live account and writes a revision signal, which is required
to repaint the zoneless room list when another client changes a rule. Writes are compensating
transactions: a partial endpoint failure restores the previous mode on every account in a
merged room row, then refreshes each cached ruleset before reporting the error.

`PushRulesService` exposes nine labelled account-level toggles backed by predefined
rules: the master kill switch (marked `invert`, because the rule being _enabled_ means
"do not notify"), invites, user mention, `@room`, call invitations, direct chats,
encrypted direct chats, room messages and encrypted room messages. Each toggle carries an
`aliases` list, because MSC3952 intentional mentions replaced
`.m.rule.contains_display_name` with `.m.rule.is_user_mention` and a homeserver may
expose either or, as current Synapse does, both.

`KeywordRulesService` manages `content`-kind rules and has three constraints worth
knowing about:

- Server-defined rules are filtered out of the list. The spec reserves a leading dot for
  them, and one of them, `.m.rule.contains_user_name`, lives in the same `content` bucket
  as user keywords. Listing it would show someone their own username as a keyword they
  could delete.
- Writes are keyed by `ruleId`, not by `pattern`. Element happens to make them identical,
  but the spec permits any id, and addressing a rule by its pattern 404s whenever they
  differ.
- Glob metacharacters `*` and `?` are **rejected**, not escaped. A stray `*` would
  silently become "notify on every message in every room", stored on the account and
  therefore active on every device and in every other client, with nothing to say where
  it came from.

## Local notifications on desktop and web

`NotificationService` turns the live sync stream into OS notifications. It runs on
desktop and web only; on native mobile it returns early, because push owns delivery
there.

It listens per account, not just for the active one, and reconciles those listeners
against the live account set, so an account that finishes its background warm start later
still gets bound. A notification fires only when all of the following hold:

- the event is live, not backfill (`data.liveEvent === true`),
- the sender is not you,
- the user is not already looking at that room, which means the window is focused **and**
  this is the active account **and** that room is open,
- the account's own push rules say to notify (`getPushActionsForEvent().notify`),
- and the event has not already notified on that account.

!!! note "Encrypted rooms notify one emit later"

    The `RoomEvent.Timeline` emit for an encrypted room carries ciphertext. Scoring push
    rules against it would miss mentions, and the preview would be generic. Those events
    are parked in a pending set and re-evaluated on `MatrixEventEvent.Decrypted` with
    `getPushActionsForEvent(event, true)` so the rules run against cleartext. A decryption
    failure keeps the event pending for a later retry rather than dropping it, and both
    the pending set and the already-notified set are capped at 500 entries so a long
    session cannot grow them without bound.

The collapse `tag` is `` `${userId} ${roomId}` ``, so a newer message replaces the previous
toast from the same room on the same account, while the same room on a second account
stays a separate toast.

There are two delivery backends. On the Electron desktop shell the preload
`trinityDesktop` bridge is present, and notifications are handed to the **main process**;
renderer Web notifications from Electron are unreliably surfaced and attributed by the OS,
notably on macOS. Clicks come back over `onNotificationClick` carrying the room id and the
account id. On web, the Web `Notification` API is used — through the service worker
registration when a service worker controls the page, because mobile browsers throw on
`new Notification()`, and through the constructor otherwise.

A click focuses the window, switches to the owning account if it is not already active,
and navigates to `/rooms/<segment>`, where the segment is the room id encoded with
`encodeRoomSegment` (base64url — the raw id ends in a dotted server name, which both SPA
fallbacks refuse to answer with `index.html`).

Nothing consumes and strips a parameter any more: the open room IS the URL.
`RoomShellStore.activeRoomId` derives from `ActivatedRoute.paramMap`, so a tap arriving
while `/rooms` is already the active route still lands — the component is not re-created,
but `paramMap` is a stream and fires anyway. Back closing the room is now the intended
behaviour rather than something to prevent.

!!! warning "macOS silently drops notifications from unsigned builds"

    Electron posts through macOS `UNUserNotification`, which requires a stable code
    signature. An unsigned or ad-hoc-signed build fails with `UNErrorDomain error 1`
    instead of displaying anything. The shell logs that explicitly on the notification's
    `failed` event so it is diagnosable. To test it directly, launch the packaged binary
    with `TRINITY_NOTIFY_TEST=1` set and it posts one notification a few seconds after
    startup. See [the desktop platform page](../platforms/desktop.md) for signing.

The Electron shell also keeps notifying while it is in the background. Closing the window
hides it to the system tray rather than quitting, so the process, the renderer and the
`/sync` long-poll all stay alive, and the window is created with
`backgroundThrottling: false` so Chromium does not throttle that long-poll when the window
is hidden or minimized. A real quit is available from the tray menu and the app menu. On
web there is no equivalent: notifications fire while the tab is open but unfocused, and
stop when it is closed.

## The app badge

`AppBadgeService` mirrors the app-wide unread total, summed across every signed-in
account, onto exactly one badge sink chosen by feature detection:

| Platform              | Sink                                                             |
| --------------------- | ---------------------------------------------------------------- |
| Electron desktop      | `trinityDesktop.setBadgeCount` over the preload bridge           |
| iOS and Android       | `@capawesome/capacitor-badge` through `MobileBadgeService`       |
| Web and installed PWA | The W3C Badging API, `navigator.setAppBadge` and `clearAppBadge` |

Where none is available — a plain browser tab that is not an installed PWA — it is a
no-op. The count is clamped to 9999.

On the desktop side the main process picks the per-OS affordance. macOS and Linux Unity
get a numeric badge from `app.setBadgeCount`. Windows has no numeric taskbar badge at
all, so the shell draws a red overlay icon on the taskbar button and carries the number
in the overlay's accessibility description, collapsing anything past 99 to `99+`. The
count arriving over IPC is untrusted and is validated and clamped before it reaches any
native call.

Every badge call is fire-and-forget. The badge is decorative, so a missing plugin, an
unsupported OS or a denied permission is swallowed rather than surfaced.

## Mobile push

```text
homeserver ──(push rules match)──► push gateway ──► FCM or APNs ──► device
    ▲                                                                 │
    └──────────── client.setPusher, pushkey = device token ◄───────────┘
```

The homeserver cannot talk to FCM or APNs directly, so a Matrix client always needs an
HTTP **push gateway** in between — [Sygnal](https://github.com/matrix-org/sygnal) is the
reference implementation. The gateway holds the platform credentials. The client's job is
to obtain a device token and register a **pusher** with each homeserver pointing at that
gateway.

`PushService` does that. It is gated on `Capacitor.getPlatform()` being `ios` or
`android`, on the push plugin being available, and on a gateway being configured. It is
deliberately **not** gated on `isNativePlatform()`, which is also false in the Electron
shell where there is no push plugin at all.

Trinity uses the `event_id_only` push format, so the gateway sees only identifiers —
`room_id`, `event_id`, unread counts and a priority flag — never message content, sender
or type. The client fetches the event itself after sync.

### One device token, one pusher per account

Every signed-in account gets its own pusher, and they all share the single device token as
their `pushkey`. Two consequences follow from that.

**`append` must be `true`.** The flag governs pushers belonging to _other users_ for the
same `(app_id, pushkey)` pair. With `append: false`, each account in the registration loop
deletes the previous one's pusher whenever two accounts live on the same homeserver,
leaving only the last one able to receive push. It does not duplicate this user's own
pusher, because the homeserver replaces that unconditionally on the `(app_id, pushkey)`
key, so a repeat `register()` stays at one pusher per account. Both halves were verified
against Synapse.

**Each pusher tags itself with its owner.** The `data` object carries
`trinity_user_id: <userId>` alongside `url` and `format`:

```ts
const data = {
  url: config.gatewayUrl,
  format: 'event_id_only',
  trinity_user_id: account.userId,
};
```

A tapped notification reads that key, switches to the tagged account if it is signed in
and not already active, and then opens the room. **This only works if the gateway forwards
`data.trinity_user_id` from the pusher into the delivered push payload's `data`.** Sygnal
does not do that out of the box. Until it is configured, every account's pusher is still
registered and delivery still works, but a tap cannot attribute the notification and opens
whichever account happens to be active.

### Registration lifecycle

`register()` is idempotent and best-effort. The authenticated shell calls it on mount, so
a fresh login, a restored session and an added account all converge on the same path: once
the token is known, a repeat call re-applies pushers for every account. On Android it
first creates a notification channel, because Android O and later silently drop
notifications that have none.

`unregister(userId)` removes just that account's pusher on a per-account sign-out.
`unregister()` with no argument removes every account's pusher and detaches the plugin
listeners. Either must run **before** the access token is invalidated, or the gateway
keeps delivering.

### Changing the app id strands a pusher

A pusher's identity is the tuple `(user_id, app_id, pushkey)`. Changing the app id does
not update the existing pusher; it creates a second one, and the first keeps delivering to
the old gateway indefinitely. Confirmed against Synapse: `GET /pushers` returns two rows
after such a change.

`PushGatewayService` therefore keeps a ledger. `appId` is what the user wants;
`appliedAppId` is what actually reached the homeservers, persisted so it survives the app
being killed between the remove and the set. It lives in its own preferences key
(`trinity.push.applied-app-id`) rather than inside the user's gateway override. Holding it
in the override meant it was never written at all on a device still using the build-time
default — so the first time such a user set their own gateway, nothing knew which app id
was already live and the original pusher was stranded on the old gateway forever. When they differ, `setPushers()` removes the
stale pusher **before** setting the new one — interrupted after the remove, the account is
merely unregistered until the next `register()`; interrupted the other way round, the old
gateway would keep receiving forever. The ledger only advances once every account
succeeded.

This implies an ordering contract for the settings UI: tear the pushers down _before_
clearing the stored gateway, because clearing drops the ledger and with it the only record
of what to remove.

### What the client can and cannot verify

After a successful round, `setPushers()` reads the pushers back with `getPushers()` and
confirms the `(app_id, pushkey)` tuple is present. That catches a homeserver that accepts
the POST but does not persist it — a real risk on the non-Synapse homeservers this feature
invites people to point at. Matching is on the identity tuple rather than the URL, because
a homeserver that canonicalises the URL differently must not read as a failure, and only a
definitive absence downgrades the state.

The `registration` signal is a discriminated union of `idle`, `applied` and `error`, so
"succeeded and failed" is unrepresentable. `applied` means the pushers were accepted and
are queryable. It does **not** mean a notification will arrive: the gateway to FCM or APNs
to device leg is completely invisible from the client.

## Configuring a gateway from the app

**Settings, then Notifications, then Push gateway** lets a user point mobile push at a
gateway they run or trust rather than one baked into the build. A stock build ships
`environment.push` as `null`, so this is the path that takes push from dead to live
without a rebuild.

Resolution is `user override ?? PUSH_CONFIG ?? null`, and `null` from both leaves
`PushService` a clean no-op.

The override lives in Capacitor `Preferences` under `trinity.push.gateway`. It is
deliberately device-local rather than Matrix account data: `app_id` is per-platform and
the `pushkey` is this install's device token, so an iOS gateway config is meaningless to
the Android install on the same account. It is equally deliberately not secure storage —
the URL is published to the homeserver as `pusher.data.url` and any client can read it
back from `GET /pushers`, so the UI must not imply it is a secret.

### URL validation

`normalizeGatewayUrl` is pure, unit-tested, and its rules were probed against Synapse
rather than invented:

| Input                                         | Synapse             | Trinity                               |
| --------------------------------------------- | ------------------- | ------------------------------------- |
| `https://host/_matrix/push/v1/notify`         | accepted            | accepted                              |
| Bare origin, wrong path, or a sub-path prefix | 400 M_MISSING_PARAM | bare origin normalized, rest rejected |
| The correct path with a trailing slash        | 400 M_MISSING_PARAM | normalized                            |
| `http://`                                     | accepted            | accepted, flagged as insecure         |
| Embedded credentials                          | accepted            | rejected                              |

The notify path is an **exact** match server-side, so a gateway cannot be mounted under a
sub-path. A fragment is dropped, because a `#hash` is meaningless to a server-to-server
POST and would be sent verbatim; a query string is preserved, because Synapse accepts one
and multi-tenant gateways use it. Embedded credentials are rejected even though Synapse
allows them, since they would be persisted in plain text on the device and re-served by
`GET /pushers`.

None of this is a security control. The **homeserver**, not the client, makes the outbound
request, and any user can POST to `/pushers/set` directly. It catches typos.

### The trust dialog

Saving a custom URL raises a dialog naming the gateway host and stating what its operator
can see, because moving the gateway choice to the user moves the trust decision too.

The strongest correlator the operator receives is the `pushkey` itself: a globally unique
per-install token that every account's pusher shares, so the gateway can link all of a
device's accounts as one person regardless of any identifier. On top of that,
`trinity_user_id` hands it each account's MXID directly, and each notification carries
`room_id`, `event_id`, priority and unread counts, which fingerprint activity — how many
rooms, which are busy, waking hours, direct versus group — even though message content
never reaches it. That is expected for a self-hosted gateway and a metadata tradeoff for a
shared one.

## What an operator must set up

Push delivers nothing until a gateway exists and platform credentials are provisioned.
None of this can be exercised in CI, on the iOS Simulator, or on web and desktop.

1. **Deploy a push gateway** and note its notify endpoint, for example
   `https://push.example/_matrix/push/v1/notify`.

2. **Point the app at it**, either per-device in Settings or as a build default in
   `apps/trinity/src/environments/environment.ts` and `environment.prod.ts`:

   ```ts
   push: { gatewayUrl: 'https://push.example/_matrix/push/v1/notify' },
   ```

   `appId` is optional and defaults to `eu.qwky.trinity`, the app's own bundle id. Set it
   only for a gateway that registered this app under some other key. `PushService` appends
   `.ios` or `.android` to whichever base id applies, and those per-platform ids are what
   the gateway keys its credentials by.

3. **Android, FCM.** Create a Firebase project and add an Android app with package
   `eu.qwky.trinity`. Put `google-services.json` at `android/app/google-services.json` —
   Gradle already applies the google-services plugin conditionally on that file being
   present, and logs a warning when it is not. `POST_NOTIFICATIONS` is already declared in
   the manifest. Configure the gateway's FCM app key as `eu.qwky.trinity.android`.

4. **iOS, APNs.** Needs an Apple Developer account and a real device. Create an APNs auth
   key (`.p8`) and give the Key ID, Team ID and key file to the gateway's `apns` config
   under app key `eu.qwky.trinity.ios`. Enable Push Notifications on the App ID. In Xcode,
   on the App target's Signing and Capabilities, add **Push Notifications** and
   **Background Modes, Remote notifications**. `AppDelegate.swift` already forwards the
   APNs registration callbacks the plugin needs.

5. **Sync and rebuild the native projects.** The plugin registration and the iOS SPM
   manifest are generated:

   ```bash
   pnpm build && pnpm exec cap sync
   ```

   Then do a full native rebuild and reinstall on device, not just a `cap copy`.

If the bundle id ever changes, `DEFAULT_APP_ID`, `capacitor.config.ts`,
`android/app/build.gradle` and the Xcode `PRODUCT_BUNDLE_IDENTIFIER` must move together.
APNs binds its auth key to the bundle id and FCM binds to the sender project.

## Limits worth knowing

- **Web Push is not implemented.** It would need a VAPID or Web Push pushgen plus service
  worker handling. On web, the local notifications above cover the foreground tab.
- **Per-account attribution needs the gateway change** described above. The client half —
  one tagged pusher per account, tap to switch — is in place.
- **A rotated device token leaves the previous pusher behind.** An app-id change is swept;
  a new `pushkey` is a different orphan class that nothing currently removes until logout.
- **Foreground pushes are not surfaced separately**, because live sync has already updated
  the UI.
- **The full loop ships unverified end to end.** Registration, the readback and the app-id
  swap are all verified against a disposable Synapse. Everything past the homeserver's
  outbound POST needs a real device, a deployed gateway and real credentials.

## Alternatives to running a gateway

matrix.org's public Sygnal only serves Element's app ids, so it is not an option for a
custom app.

- **Android, UnifiedPush.** The user installs a distributor such as ntfy or NextPush that
  holds the connection, and the app registers a pusher pointing at the _distributor's_
  gateway. No server to operate. It would need a native UnifiedPush connector, since there
  is no off-the-shelf Capacitor plugin, plus a distributor picker. The `setPusher` shape is
  identical to FCM, so it is additive.
- **Android, foreground service.** Keep `/sync` alive in a foreground service and raise
  local notifications. Zero push infrastructure, at the cost of a persistent notification
  and battery.
- **iOS, not possible.** APNs is mandatory for background delivery and requires a gateway
  holding the APNs key.

## Related pages

- [Notification settings](../users/notifications.md) from a user's point of view
- [Mobile platforms](../platforms/mobile.md) for the Capacitor build and sync flow
- [Desktop](../platforms/desktop.md) for the tray, background sync and macOS signing
