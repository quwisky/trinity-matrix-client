# Push notifications

Use this private reference when changing, operating, or diagnosing Trinity's
notification pipeline. Public host prerequisites live in the developer site.

## Choose the layer that owns the task

| Need                                               | Owner and boundary                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Decide whether a Matrix event is eligible          | Server-side Matrix push rules, stored per account and shared with that account's other clients.                        |
| Present an alert while Trinity is connected        | The Notifications capability and the selected web, desktop, or native host presentation adapter.                       |
| Wake a suspended iOS or Android installation       | A Matrix pusher registered for the device token and the build's push gateway.                                          |
| Open an account, room, or event from an activation | Application Runtime submits a typed intent; Workspace owns the account transition, room readiness, and URL projection. |

Keep those paths separate. A successful pusher registration does not prove FCM or
APNs delivery, and a local alert does not require mobile-push infrastructure.

## Change Matrix push rules

Room modes map to Matrix rules in [`RoomNotificationsService`](../../libs/data-access/notifications/src/lib/room-notifications.service.ts).
`all` has no enabled room-specific mute rule; `mentions` leaves highlight rules
available; `mute` uses an override rule so it wins before highlights. Existing
standard rules are disabled rather than deleted, and legacy action shapes remain
readable for interoperability.

A rule write is a compensating transaction. It refreshes the server rules before
snapshotting affected rules, serializes writes that replace the shared rules
cache, verifies the requested postcondition, and restores exact prior bodies and
enabled states after a partial failure. Restoration does not overwrite a newer
remote edit; an unconfirmed restoration remains visible as an error. A merged
room row applies the operation to its contributing accounts and reports a mixed
result when their modes differ.

Account toggles map to predefined rule aliases, because homeservers can expose
both legacy and current intentional-mention rules. Keyword rules address their
rule ID, preserve server-defined rules, and reject `*` and `?`: those characters
would create a cross-client wildcard notification rule rather than a literal
keyword.

## Deliver and activate local notifications

Notifications are projected from each live account after its first successful
sync. The policy suppresses historical/backfilled events, self-sent events, an
already focused active room, events whose account rules do not notify, and
previously delivered events. Encrypted events wait for their decrypted form so
rule scoring and previews do not use ciphertext; pending and delivered state is
each capped at 500 entries.

Host presentation is a separate capability. Electron requests native display
through its main-process bridge, Capacitor uses the native presentation adapter,
and the web adapter uses the browser or controlling service worker. A host result
can be unavailable, denied, timed out, or failed without changing Matrix read
state or Workspace ownership.

Application Runtime therefore displays Room-rule and presentation health separately. A failed
Room-rule projection means its last known setting may be stale, not that alerts stopped. A denied
permission is disabled and an unsupported host is expected; a lost presentation/activation owner
is recoverable health. Failure to show one alert or open one activation is a contextual incident,
so it does not leave a permanent outage banner or expose its title, body or destination.

An accepted activation is an immutable account, room, and event destination.
[`runNotificationActivations`](../../libs/application/runtime/src/lib/composition/trinity-application-session.adapter.ts)
forwards it to Workspace. Workspace performs the account switch and room-ready
transition, repairs an unavailable room to a safe destination, and projects the
location. Do not derive activation authority from a Room component, route
parameter, or shell store.

### Reaction notifications while connected

`ReactionNotificationSettingsService` stores the opt-in as
`dev.trinityproject.trinity.reaction_notifications` account data (`{ enabled: boolean }`, default `false`).
Accounts that still hold the retired `eu.qwky.trinity.reaction_notifications` event are read from it, and `NotificationService` copies it to the new name once for every signed-in account.
It does not alter server push rules or pusher registration. Each account's notification lifetime
owns a `ReactionNotificationBatch` for live `m.reaction` annotation events. The original message
must belong to that account; own reactions, ignored senders, redactions, history and backfill are
excluded. The master disable and room mute are checked again before delivery; mentions-only room
mode still permits opted-in reaction alerts. Existing sound and visibility policy applies.

Batches are keyed by room and original message within the owning account. A two-second quiet
window has a ten-second maximum burst duration. Each batch counts distinct people and reaction
keys, with at most 100 pending batches, 100 reactions per batch and 500 deduplicated event IDs.
Missing targets are fetched through the exact owning client and decrypted before previewing;
lookup has a ten-second deadline and unavailable targets are suppressed. Detaching an account or
presentation owner releases timers and subscriptions so late lookup results cannot present.

The presentation tag distinguishes reactions from messages and includes the original target.
Activation carries that original message ID through the existing Workspace contract. This is
the running-app scope of [issue #486](https://github.com/quwisky/trinity-matrix-client/issues/486);
closed-app reaction push and gateway/iOS filtering remain deferred.

## Configure and register mobile push

Mobile push needs a gateway that can deliver to the platform service. Trinity
registers one pusher per signed-in account using the installation's device token
as the shared `pushkey`. It uses `event_id_only`, so the gateway receives event
and room identifiers, unread counts, priority, and pusher metadata rather than
message text. Each pusher also sends `trinity_render: "device"`: Android receives a
data-only message and iOS an alert with `mutable-content: 1`, both rendered on the
device (below).

### Provision the gateway and native build

1. The gateway is the [Trinity push gateway](https://github.com/quwisky/trinity-push-gateway),
   deployed and credentialed outside this repository; platform credentials belong on the
   gateway, not in Trinity's `PushConfig`.
2. The gateway is build configuration. Both
   [`environment.ts`](../../apps/trinity/src/environments/environment.ts) and
   [`environment.prod.ts`](../../apps/trinity/src/environments/environment.prod.ts) point
   at it:

   ```ts
   push: { gatewayUrl: 'https://push.trinityproject.dev/_matrix/push/v1/notify' },
   ```

   A fork sets its own URL there, or `null` to build without native push. There is no
   device override: the former Settings → Notifications → Push gateway setting is gone, a
   saved override from an earlier build is deleted at startup
   ([`retired-push-gateway.ts`](../../libs/data-access/notifications/src/lib/retired-push-gateway.ts)),
   and an imported settings file (export format version 4) that still carries `push.gateway`
   imports with that entry ignored and a warning.

   [`PushConfig`](../../libs/data-access/notifications/src/lib/push-config.ts)
   accepts `gatewayUrl` and an optional base `appId`. Omitting `appId` uses
   `dev.trinityproject.trinity`. `PushService` appends the platform suffix, so the gateway's
   entries are `dev.trinityproject.trinity.android` and `dev.trinityproject.trinity.ios`, or the
   equivalent suffixed names for a custom base ID. The gateway's app key is
   distinct from the native bundle/package ID, which has no platform suffix.

3. For Android, register package `dev.trinityproject.trinity` in the matching Firebase
   project and place its downloaded configuration at
   `android/app/google-services.json` (git-ignored), following [Firebase's Android setup](https://firebase.google.com/docs/android/setup).
   [`build.gradle`](../../android/app/build.gradle) applies Google Services only
   when this nonempty file exists. Without it the build still runs and push stays
   unsupported: Android registers only when Firebase is initialized
   (`PushHandoff.registrationAvailable()`), so a missing configuration never crashes the
   app. The manifest already declares `POST_NOTIFICATIONS` and the `messages` channel;
   runtime permission and a correctly configured gateway are still required for delivery.
4. For iOS, register both App IDs, `dev.trinityproject.trinity` and
   `dev.trinityproject.trinity.NotificationService`, with Push Notifications, App Groups
   (`group.dev.trinityproject.trinity`) and Keychain Sharing; the checked-in
   [`App.entitlements`](../../ios/App/App/App.entitlements) and
   [`NotificationService.entitlements`](../../ios/App/NotificationService/NotificationService.entitlements)
   request them. Add the iOS app to the Firebase project, upload the APNs `.p8` key there
   (the gateway sends through FCM, which relays to APNs), and place `GoogleService-Info.plist`
   at `ios/App/App/GoogleService-Info.plist` (git-ignored; a build phase copies it when
   present). [`AppDelegate.swift`](../../ios/App/App/AppDelegate.swift) then configures
   Firebase, hands the APNs token to Firebase Messaging and reports the FCM token as the
   pushkey; `FirebaseAppDelegateProxyEnabled` is `NO`, so the delegate does this itself.
   Without the plist the APNs token is reported, which the gateway cannot deliver to.
   The [TestFlight upload](ci-and-releases.md#testflight-upload) workflow writes the plist from
   the `GOOGLE_SERVICE_INFO_PLIST` secret of its `release-mobile` environment.
   Firebase is pinned to 12.17.0, the last version whose FCM-token API is not deprecated.
   Do not infer silent background handling from notification registration: the
   [Capacitor plugin does not implement iOS silent push](https://capacitorjs.com/docs/apis/push-notifications#silent-push-notifications--data-only-notifications).
   The out-of-repo setup is tracked in [#1152](https://github.com/quwisky/trinity-matrix-client/issues/1152).
5. Rebuild, sync and install the native host with `pnpm android:run`, or
   `pnpm ios:run` on macOS with Xcode and signing configured. These commands own
   the web build and Capacitor sync; see the public developer
   [Android](../../apps/docs-developers/src/content/docs/platforms/android.md) and
   [iOS](../../apps/docs-developers/src/content/docs/platforms/ios.md) guides.
   Verify delivery with an installed native build, a device token and the deployed
   gateway. Browser tests and successful registration do not exercise that path.

### Preserve account attribution

Each pusher includes `data.trinity_user_id` containing its owning Matrix user ID.
The gateway must forward that exact field into the delivered payload's `data`
alongside the destination identifiers. Trinity reads `trinity_user_id` when
admitting a notification activation; a gateway that drops it prevents reliable
account attribution. Check the gateway's forwarding behavior explicitly rather
than assuming arbitrary pusher metadata survives delivery.

### Registration lifetime

`NativePushLifetime` owns runtime health around `PushService` registration:

1. Its cold `run()` lifetime listens for native events only while Application
   Runtime subscribes to it. `NativePushRegistrationService.listen()` supplies
   the platform callbacks.
2. `register()` is best-effort and idempotent. When a token is already known, a
   repeat call reapplies pushers for every current account. An unavailable
   platform, plugin, or gateway remains a no-op; denied permission and native
   registration errors are reported in the registration state.
3. Each pusher uses `append: true`, so accounts on the same homeserver do not
   remove each other's pusher.
4. `unregister(userId)` removes that account's pushers. `unregister()` removes
   pushers for every account and clears local token/registration state; the
   listener ends with the runtime `run()` subscription, rather than during
   unregister. Remove pushers before invalidating credentials.
5. Listener preparation and recovery observation are bounded, but a healthy retained listener has
   no idle timeout. Targeted retry reuses retained ownership for registration failures and
   reattaches only the push listener when ownership was released. Diagnostics include stable
   registration codes, never tokens, Account IDs, gateway responses or notification payloads.

Treat the gateway as a metadata boundary. Its shared device token can correlate
the installation's account pushers, and the pusher owner tag can identify an
account when forwarded for activation. `event_id_only` excludes message text,
but it does not make room/event identifiers, unread counts, priority, or account
metadata private from the gateway operator.

## Render pushes on the device

The device turns `event_id_only` pushes into readable notifications; #1152 tracks the
out-of-repo setup and the device checks, and #1211 (part B) the checks for OAuth accounts.

**Where the code lives.** The native half is one local Capacitor plugin, the pnpm workspace
package `@trinity/capacitor-push` in [`libs/native/capacitor-push`](../../libs/native/capacitor-push/package.json):
the `PushHandoffBridge` TypeScript API, the Android module `:trinity-capacitor-push`
(`PushHandoffPlugin`, `TrinityMessagingService`, the renderer, its JVM tests and the debug probe
receiver) and the Swift package `TrinityCapacitorPush` (`PushHandoffPlugin`, depending on
`TrinityPush` in `ios/TrinityPush`, which the `NotificationService` extension links too). `cap sync`
registers it in both hosts; neither registers it by hand, and the native host contract fails when
the wiring drifts. The hosts keep the Firebase and APNs setup, the entitlements, the extension
target, the manifest `tools:node="remove"` of the push plugin's `MessagingService` and the
app-owned `push_notification_appearance.xml` notification icon and accent.

**Push handoff store.** `PushHandoffService` (data-access/notifications) keeps a native
store current through the `PushHandoff` plugin (`setAccount`, `setRooms`, `removeAccount`,
`clear`, `clearRoom`, `setNotificationText`, `clearDelivered`). Per signed-in account it holds
the homeserver URL, the access token (rewritten when the SDK refreshes it), the token's expiry when the account signed in through
OAuth 2.0 and its server gave the token a lifetime (MAS defaults to five minutes;
`MatrixClientService.accessTokenExpiry` hands it over only with the token it belongs to) and
the notification-sound choice, plus App lock's effective Notification text (`setNotificationText`;
iOS app-group `push-handoff/settings.json`, Android `settings:notification-text`; missing reads as
Show and unreadable as Always hide), room display names, DM flags and whether each room counts
as encrypted (`RoomEncryptionFlags`; unknown until the crypto store answers, which counts as
encrypted) written in one batch per sync or rename. It never holds refresh tokens, crypto keys or message history. An account's
entry is removed as the first step of its sign-out, together with that account's delivered
pushes, and the store is emptied, with
every delivered push, by clear-all-data and before a replace sign-in. A handoff failure
never blocks sign-in or sign-out; the replace sign-in waits for it for at most the
notification cleanup budget. On iOS the accounts live in the shared keychain
access group `$(AppIdentifierPrefix)dev.trinityproject.trinity.shared` with
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so the tokens stay off other phones restored
from an encrypted backup (items written with the older `kSecAttrAccessibleAfterFirstUnlock`
class move over when the app next writes them, at its next start), and the rooms in the
app-group file
`push-handoff/rooms.json`. On Android each value is AES-GCM encrypted with a non-exportable
Android Keystore key and stored in the private preferences file `trinity_push_handoff`
(`EncryptedSharedPreferences` is deprecated).

**Refresh before the background.** Each time the app goes to the background,
`NotificationSessionService` asks `PushHandoffService.refreshBeforeBackground` to refresh
every bound account whose token has an expiry and that holds a refresh token
(`MatrixClientService.canRefreshAccessToken`), unless that token rotated within the last
minute, so the copy in the store lives one full lifetime from then. The refresh starts in the
SDK's own token manager (`client.http.refreshOAuthTokens()`, added by
`patches/matrix-js-sdk@45.0.0.patch`), so it joins a refresh already in flight and reaches the
store as an ordinary rotation. On iOS and Android it then runs through
`PushHandoff.refreshTokens`: native code reads the record, makes the grant and writes the
result, and the SDK adopts the answer (`NativeTokenBridge.host`, the client's `tokenHost`).
JavaScript holds a non-secret marker in place of the refresh token, and its copy of the access
token is best effort, given 3 s. An account not yet moved to native, like every account on web
and Electron, stays on the SDK's own grant, which persists the pair before the SDK adopts it.
The app stays the only process that rotates tokens; the renderers refreshing tokens themselves
is [#1210](https://github.com/quwisky/trinity-matrix-client/issues/1210). Each return to the
foreground also adopts the pair native holds (`PushHandoffService.adoptOnResume`). A refused
refresh signs nothing out at that moment; the account's next request meets the refusal and
takes the usual path.

A refresh is attributed to the sign-in and the client it came from
([#1207](https://github.com/quwisky/trinity-matrix-client/issues/1207)). Every saved session
carries a lineage id that storage mints on each save and a refresh never changes. The stored
write is a compare-and-swap on it, checked in the same serialized turn as the write. A late
refresh is therefore saved while its sign-in is still the stored one, even from a client that
was retired, rolled back or stopped, because with refresh-token rotation those are the only
valid next tokens. It never overwrites a newer sign-in of the same account, even one saved
while the refresh waited, and does nothing once the account was signed out. A record saved
before lineages existed accepts any refresh. Separately, the tracked token and its expiry
belong to the client that started with them. Only a refresh from that client, while it is the
account's live or starting client, moves them and publishes a rotation. A refresh from any
other client never reaches the push store. Native code adds its own compare before it writes:
a grant's answer lands only while the stored pair and lineage are the ones the grant started
from. A late answer is discarded, and the SDK ignores one that arrives after it adopted a newer
pair.

The run is bounded. Native code bounds a migrated account's grant at 8 s itself.
`BACKGROUND_REFRESH_GRANT_TIMEOUT_MS` (8 s) bounds the token grant of each refresh the run
starts for an account still on the SDK's grant, counted from the start of that refresh
(`refreshOAuthTokens({ timeoutMs })`); past it the patched SDK aborts the grant, or does not
send it at all. A `tokenHost` ignores `timeoutMs`. The run itself exists only on iOS and
Android; on web and Electron the SDK's 30 s grant bound applies.
`BACKGROUND_REFRESH_TIMEOUT_MS` (15 s) caps each account's refresh, and then
the wait for the store writes it queued; past it the run completes without that account, so
the next background event refreshes again. `BACKGROUND_RUN_DEADLINE_MS` (25 s) cuts off the
whole run, asking for background time included, so the worst case is about 25 s. While any
account is due, the run holds iOS background time (`PushHandoff.beginBackgroundWork`,
`UIApplication.beginBackgroundTask`) from before the refreshes until the rotation's native
write has landed or a bound has passed. It completes only once the release has landed, and
still releases on error, unsubscription or a late grant; the task ends itself if iOS ends the
granted time first. Android holds nothing, and a run with no account due asks for nothing.
The refresh is still not proven to finish before the OS suspends the app: iOS can end
background time early, and Android can freeze or stop a backgrounded app. An interrupted
refresh can leave three things behind, and a refresh that outlasts a lock a fourth.

- Interrupted native write. If the server rotated but the native store write never ran,
  the store still holds the previous token with its previous expiry. The forced refresh
  revoked that token, so pushes for the account read "New message" only until that old
  expiry passes: at most one token lifetime, about 5 minutes on MAS defaults. After that
  they read "Open Trinity to read this message". Holding iOS background time until the write
  lands narrows this window but does not close it. A migrated account's vault write is native's
  own, before it answers: one that fails answers `rotated` with `unsaved: true`, so the app uses
  the new pair and that process holds it in memory until a later refresh writes it.
- Spent refresh token. This does not need the process to die. If the refresh grant's
  response is lost, for example because the connection is cut as the OS suspends the app,
  the app keeps the spent refresh token in memory and in storage, and the next refresh
  reuses it. A provider that rejects reused refresh tokens answers `invalid_grant`, and the
  SDK signs the account out and clears its local encryption state. MAS deployments that
  include its idempotent refresh-token grant (matrix-authentication-service PR #3650)
  accept the reuse while neither the new access token nor the new refresh token has been
  used, which is the lost-response case. Other providers may not; the device check in
  [#1211](https://github.com/quwisky/trinity-matrix-client/issues/1211) (part B) confirms
  the behaviour for the deployment in use. The grant bounds below abort a request the server
  may already have answered, which is the same case.
- Suspended refresh request. The patch aborts every refresh-token grant after 30 s, the
  same bound `localTimeoutMs` puts on every other Matrix request, and the background run's
  grants after 8 s. An aborted grant fails like a network error: nothing signs out, the
  SDK's shared refresh settles, and the next request refreshes again. A request suspended
  mid-flight therefore holds the account's requests for at most the rest of its bound of run
  time once the app resumes, and the 15 s run bound frees the background refresh sooner.
  The device check (#1211, step B4) includes "go to the background mid-refresh, come back,
  confirm sync resumes".
- Lock during a refresh. Locking the phone is the most common way to send the app to the
  background. A migrated account's native write runs under
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, which a lock does not take away. Only
  JavaScript's copy of the access token can fail then, and the refreshed token is still used.
  The rest of this case is an account not yet moved to native. Its tokens are stored with
  `KeychainAccess.whenUnlockedThisDeviceOnly`, and iOS discards the key for those items
  about 10 s after the lock. A forced refresh whose grant answers after that cannot save the
  rotated pair: `onTokenRefresh` rejects, the server has already rotated, and the SDK keeps
  the spent pair, which is the spent-refresh-token case above. Two things guard against it,
  and both stay for that account. They cover the whole run, so a migrated account also waits
  for the next background event.
  `beginBackgroundWork` reports whether protected data is available
  (`isProtectedDataAvailable`) and whether the device is locking (iOS posted
  `protectedDataWillBecomeUnavailableNotification` within the last 10 s and has not posted
  `protectedDataDidBecomeAvailableNotification` since); the run refreshes nothing in either
  case, still ends the background task, and the next background event with the phone
  unlocked refreshes. Otherwise every refresh starts at once as background time is granted,
  so a lock that arrives mid-run finds none left to start, and each grant must answer within
  8 s of the refresh call. The keychain write that saves the answer is not covered by that
  bound, so it has about 2 s of the 10 s left after a lock that came as the run started.
  What remains: a grant aborted at the 8 s bound after the server processed it spends the
  refresh token (the spent-refresh-token case), and a refresh the run joined because it was
  already in flight keeps the SDK's 30 s bound. The device check (#1211, step B4) should
  include locking the phone with the side button mid-refresh, then unlocking and confirming
  the account is still signed in and syncs.

**Rendering.** iOS runs the `NotificationService` extension; Android replaces the push
plugin's messaging service with `TrinityMessagingService`, which treats the app as
foreground, and leaves the notification to the app, while an activity is visible. Both
fetch the event, the sender's member state and, for a room the store does not know, its
`m.room.name` state, within one 5 s budget and without retries. Android enforces the budget
with a watchdog that falls back without the network; iOS shares one deadline across the
reads and also answers `serviceExtensionTimeWillExpire`. Redirects are refused, so the
token never follows one. Both apply the shared text rules (including the 200 code point
limit and Unicode `White_Space` trimming) pinned by
[`push-render-cases.json`](../../native/push-render/push-render-cases.json), which JUnit and
XCTest both run. A push for an account the store does not know keeps the gateway's
"Trinity" / "New message". The renderers never refresh a token. Once the stored expiry has
passed they read nothing and show the room name (or "Trinity") with "Open Trinity to read this
message", because only the running app can renew the token; any other failed read shows
"New message". A message that arrived unencrypted shows "New message" unless the store holds
its room as not encrypted: a room missing from the store, or stored without the flag, counts as
encrypted. Password and SSO tokens carry no expiry and are always read. The renderers
never log tokens, expiries, IDs, room names or message text. Android posts
one `MessagingStyle` notification per room on `messages` and cancels it when a push without
`event_id` arrives for that room. What shows depends on App lock's Notification text, which
only applies while App lock is on. Show leaves the lock screen to the system's preview settings.
Hide on the lock screen adds the `trinity.message.private` category on iOS, which shows "New
message" while Show Previews hides previews, and `VISIBILITY_PRIVATE` with a generic public
version on Android, which is used where the lock-screen setting hides sensitive content. Always
hide renders only "New message" with no title (the system shows the app's name); on iOS without
reading the event or making any network request, while on Android the renderer still fetches it
and drops the text before posting. Both renderers read the mode just before
posting (iOS a second time); with no store, iOS hides everything.

**Who presents in the background.** Once Android push is registered,
`PushService.backgroundDelivery` is `push`, and the notification policy stops the running
app presenting its own message notifications while the page is hidden
(`document.visibilityState === 'hidden'`, not merely unfocused), so `TrinityMessagingService`
is the only source. Opted-in reaction notifications are exempt, because no push carries
them. A visible app, and iOS, web and desktop, present as before.

**Opening a room** clears that account's delivered notifications for it:
`NotificationSessionService` calls `PushHandoff.clearRoom` once each time a room becomes the
focused Conversation, and again for the focused room when the app returns to the foreground
(pushes for it were shown natively while the app was hidden). Android cancels the notification tagged with the room ID for that
account; iOS removes notifications whose `threadIdentifier` is the room and whose
`trinity_user_id` is that account, or absent.

## Verify the boundary you changed

- Use notification and push-service unit tests for rule translation,
  transactions, account attribution, and error states.
- Use the browser journey for web notification policy and activation rendering.
  It cannot prove FCM, APNs, operating-system delivery, or a deployed gateway.
- Use a real native host, token, gateway, and credentials before claiming mobile
  delivery. Record unavailable platform or operator prerequisites plainly.
- Run `pnpm nx run trinity-ios:test-push` and `pnpm nx run trinity-android:verify-native` (the
  Android unit tests; CI runs them) for the text rules and the bounded reads.
- `e2e/mobile/specs/push-render-ios.e2e.mts` and `push-render-android.e2e.mts` drive the
  renderers through debug-only probes; the Android spec also taps the notification it posted
  with the app terminated and checks that the room opens. Both also store an already expired
  token and check for the expired-token text. They do not show a real FCM token,
  the extension launching, locked-phone rendering or closed-app delivery through
  `push.trinityproject.dev`, and nothing covers tap-to-open on iOS; check those on a device
  ([#1152](https://github.com/quwisky/trinity-matrix-client/issues/1152)).

The source of truth is
[`push.service.ts`](../../libs/data-access/notifications/src/lib/push.service.ts),
[`push-handoff.service.ts`](../../libs/data-access/notifications/src/lib/push-handoff.service.ts),
[`native-push-registration.service.ts`](../../libs/platform-native/src/lib/native-push-registration.service.ts),
[`push-handoff.bridge.ts`](../../libs/native/capacitor-push/src/lib/push-handoff.bridge.ts),
[`NotificationService.swift`](../../ios/App/NotificationService/NotificationService.swift),
[`PushHandoffPlugin.swift`](../../libs/native/capacitor-push/ios/Sources/PushHandoffPlugin/PushHandoffPlugin.swift) and
[`TrinityMessagingService.kt`](../../libs/native/capacitor-push/android/src/main/kotlin/dev/trinityproject/trinity/push/TrinityMessagingService.kt).
