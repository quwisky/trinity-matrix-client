# Push notifications

Use this reference when changing, operating, or diagnosing Trinity's notification
pipeline. For a person's settings and recovery steps, use
[Control notifications](../users/notifications.md). Host prerequisites belong in
[the platform guides](../platforms/index.md).

## Choose the layer that owns the task

| Need                                               | Owner and boundary                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Decide whether a Matrix event is eligible          | Server-side Matrix push rules, stored per account and shared with that account's other clients.                        |
| Present an alert while Trinity is connected        | The Notifications capability and the selected web, desktop, or native host presentation adapter.                       |
| Wake a suspended iOS or Android installation       | A Matrix pusher registered for the device token and its configured push gateway.                                       |
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

## Configure and register mobile push

Mobile push needs a gateway that can deliver to the platform service. Trinity
registers one pusher per signed-in account using the installation's device token
as the shared `pushkey`. It uses `event_id_only`, so the gateway receives event
and room identifiers, unread counts, priority, and pusher metadata rather than
message text.

### Provision the gateway and native build

1. Deploy the Trinity push gateway and expose its notify endpoint, for example
   `https://push.example/_matrix/push/v1/notify`. Configure its Firebase and APNs
   credentials using the gateway's own instructions. Platform credentials belong
   in native provisioning and on the gateway, not in Trinity's `PushConfig`.
2. Select the endpoint in **Settings → Notifications → Push gateway**. A saved
   device override takes precedence over the build default. Both build environments
   share `DEFAULT_PUSH_GATEWAY_URL` from the internal
   [`push-client` library](../../libs/util/push-client/src/index.ts); change that one
   value to ship a real default. The checked-in value is
   `https://push.example.invalid/_matrix/push/v1/notify`, a nonfunctional placeholder.
   Settings identifies the placeholder, and successful pusher registration never
   proves that it can deliver a notification.

   [`PushConfig`](../../libs/data-access/notifications/src/lib/push-config.ts)
   accepts the gateway URL. Trinity chooses the gateway app ID automatically:
   `ovh.qwky.trinity.android` or `ovh.qwky.trinity.ios`. These gateway IDs are
   independent of the native package/bundle ID, `eu.qwky.trinity`; do not rename
   the native app merely to match a gateway entry. Custom gateway app IDs and
   the legacy `trinity_user_id` payload contract are no longer supported.

3. For Android, register package `eu.qwky.trinity` in the matching Firebase
   project and place its downloaded configuration at
   `android/app/google-services.json`, following [Firebase's Android setup](https://firebase.google.com/docs/android/setup).
   [`build.gradle`](../../android/app/build.gradle) applies Google Services only
   when this nonempty file exists. The manifest already declares
   `POST_NOTIFICATIONS` and the `messages` channel; runtime permission and a
   correctly configured gateway are still required for delivery. Unprovisioned
   builds reject registration safely through the native Android guard, so granting
   notification permission or restarting the app cannot trigger an uncaught Firebase
   initialization exception. The existing push plugin retains token and listener ownership.
4. The Trinity gateway requires an FCM registration token on iOS as well as Android.
   The current iOS host still forwards an APNs device token, so it cannot yet
   register a compatible pusher. The iOS integration work must add Firebase
   Messaging token delivery, a Push Notifications entitlement and the matching
   Firebase/APNs provisioning. Existing callbacks in
   [`AppDelegate.swift`](../../ios/App/App/AppDelegate.swift) alone do not establish
   FCM compatibility or a provisioned push capability.
5. Rebuild, sync and install the native host with `pnpm android:run`, or
   `pnpm ios:run` on macOS with Xcode and signing configured. These commands own
   the web build and Capacitor sync; see [mobile run and debug guidance](../platforms/mobile.md).
   Verify delivery with an installed native build, a device token and the deployed
   gateway. Browser tests and successful registration do not exercise that path.

### Preserve Account attribution

Each pusher includes `data.trinity_account_id`, a stable opaque Account Route,
and `data.trinity_push_version: "1"`, alongside `format: "event_id_only"`.
The route contains 1–48 base64url characters; it is neither a Matrix user ID nor
an access token. It is persisted with the saved Account record before the pusher
is written, survives reauthentication and token changes, and disappears when
that Account is removed.

The gateway forwards the route in its versioned data payload. Trinity admits
`schema: "1"` events only after validating their fields and resolving the route
against saved Accounts. Unknown or ambiguous routes, malformed payloads and
unsupported versions cannot select the Active Account as a fallback. An event
needs both a Room ID and event ID; count-only payloads never activate a
Conversation.

The internal shared library owns the v1 contract, route helpers and registration
coordination. Matrix writes stay in Notifications data access, persistence stays
with the Account storage adapter, and host token/presentation APIs stay in platform
adapters. Application Runtime and Workspace retain activation authority.

### Android native and foreground delivery

Android receives data-only gateway messages through
[`TrinityPushMessagingService`](../../android/app/src/main/java/eu/qwky/trinity/TrinityPushMessagingService.java).
This replaces Capacitor's application FCM handler in the merged manifest; Firebase's
lower-priority fallback remains. Token refresh uses Capacitor's inherited implementation.
The native handler validates the shared
v1 contract and reads only opaque routes from the existing Account registry. It
does not copy credentials, create a second Account registry, sync Rooms or decrypt messages.

When the Activity is resumed and both JavaScript notification owners are ready,
delivery uses the existing foreground policy, including focused-Conversation
suppression. Otherwise Android posts a generic **Trinity / New message** alert
without creating a WebView. The `messages` channel and operating-system permission
still apply; count-only payloads never create a new-message alert.

Native delivery, foreground push and live Matrix events share a bounded, persistent
presentation ledger through `NativePushDeliveryService`. Its hashed identities keep
Accounts separate and suppress repeated events after a process restart. The ledger
is private installation state and is excluded from configuration export and preference
reset. Account removal and push disablement retire owned alerts; malformed or unknown
routes cannot become notifications for whichever Account happens to be active.

A notification's immutable PendingIntent carries the validated opaque route, Room and
event to the existing Capacitor activation listener. Cold and warm taps therefore use
normal Account restoration and Workspace readiness before opening the owning
Conversation. Removed Accounts and unavailable Rooms use the same safe navigation
outcomes as other notification intents.

Background and process-absent delivery require a provisioned Firebase build, a valid
FCM token and a working gateway. Process absence is different from Android's
[force-stopped package state](https://developer.android.com/reference/android/content/pm/ApplicationInfo#FLAG_STOPPED):
after a force-stop, reopen the app before expecting push delivery. Battery and
background restrictions can also delay messages. Instrumentation that injects a
data-only message proves the native handler and activation path, not gateway/FCM transport.
Real-device delivery remains a separate verification requirement. iOS FCM and detailed
platform badge/count/sound handling have their own implementation slices.

Run the installed Android checks with
`pnpm nx run trinity-e2e-android:e2e -- android/push-delivery.spec.mts`.
The lifecycle target builds and installs Trinity's test APK, checks the shared payload
fixtures and notification-permission denial, then exercises cold and warm taps between
two real Accounts. It supplies an opaque route to an existing test Account without
requiring Firebase credentials. The warm phase retains the same app process and WebView.

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
   unregister. Remove pushers before invalidating credentials. Disabling push
   first persists the disabled choice, then removes identities from its separate
   registration ledger.

5. Listener preparation and recovery observation are bounded, but a healthy retained listener has
   no idle timeout. Targeted retry reuses retained ownership for registration failures and
   reattaches only the push listener when ownership was released. Diagnostics include stable
   registration codes, never tokens, Account IDs, gateway responses or notification payloads.

The gateway setting is device-local and not secret: its URL is sent to the
homeserver in pusher metadata. The user-facing settings flow validates and
explains it in [Control notifications](../users/notifications.md#configure-mobile-push-carefully).

Treat the gateway as a metadata boundary. Its shared device token can correlate
the installation's account pushers, and the opaque route distinguishes an Account across its deliveries. `event_id_only` excludes message text,
but it does not make room/event identifiers, unread counts, priority, or Account
metadata private from the gateway operator.

## Keep a gateway migration recoverable

A pusher is identified by Account, app ID and device token. The shared registration
coordinator persists a separate device-local record for each Account, including every
identity that may still exist on the homeserver. It saves that record before network
mutations, removes obsolete app IDs and tokens before registering a replacement, and
confirms the result with homeserver readback. An interrupted write or partial Account
failure therefore leaves enough information for the next registration opportunity to
retry. Other Accounts can finish independently, including Accounts sharing one token.

Older installations have only an applied app-ID record. Migration retains those IDs
and any legacy configured app ID before replacing settings. It discovers legacy rows
only under those identifiers with Trinity's application name and the Account's exact
Matrix device ID in the device display field. Current v1 rows also require the saved
opaque Account Route. The durable identity record is authoritative; unrelated device
pushers are left alone.

An explicit **Clear** persists the disabled choice before cleanup. The shipped default
cannot re-enable it after restart, and failed cleanup remains retryable while disabled.
Configuration export represents this choice as `{ "disabled": true }`; `null` restores
the build default. Registration records and device tokens are not exported.

**Retry** in notification Settings reapplies the saved registration or retries cleanup
when disabled. The same lifecycle runs after token refresh and Account changes. A
missing homeserver pusher is restored on the next registration opportunity, including
when a gateway rejection previously caused the homeserver to drop it; there is no
client-side gateway rejection callback. Failed or inconclusive readback remains a
registration error. A confirmed row proves registration, not notification delivery.

Account sign-out attempts pusher removal before credential revocation. Full reset
also orders those operations sequentially. Cleanup failure is reported through the
existing Account cleanup outcome; sign-out still follows its bounded local-security
policy rather than retaining credentials indefinitely. If the server cannot be reached,
Trinity cannot certify remote removal. Saved Account Routes are removed with the Account,
and stale notifications cannot activate it.

## Verify the boundary you changed

- Use notification and push-service unit tests for rule translation,
  transactions, account attribution, error states, and gateway migration.
- Use the browser journey for web notification policy and activation rendering.
  It cannot prove FCM, APNs, operating-system delivery, or a deployed gateway.
- Use a real native host, token, gateway, and credentials before claiming mobile
  delivery. Record unavailable platform or operator prerequisites plainly.

The source of truth is
[`push.service.ts`](../../libs/data-access/notifications/src/lib/push.service.ts),
[`push-gateway.service.ts`](../../libs/data-access/notifications/src/lib/push-gateway.service.ts),
and [`native-push-registration.service.ts`](../../libs/platform-native/src/lib/native-push-registration.service.ts).
