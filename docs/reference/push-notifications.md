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

### Reaction notifications while connected

`ReactionNotificationSettingsService` stores the opt-in as
`eu.qwky.trinity.reaction_notifications` account data (`{ enabled: boolean }`, default `false`).
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
message text.

### Provision the gateway and native build

1. Deploy a Matrix push gateway and expose its notify endpoint, for example
   `https://push.example/_matrix/push/v1/notify`. Configure its platform credentials
   using the gateway's own instructions; [Sygnal's application configuration](https://github.com/matrix-org/sygnal/blob/main/docs/applications.md)
   describes its FCM and APNs integrations. Platform credentials belong on the
   gateway, not in Trinity's `PushConfig`.
2. Select the endpoint in **Settings → Notifications → Push gateway**, or set
   `environment.push` in the appropriate build environment:
   [`environment.ts`](../../apps/trinity/src/environments/environment.ts) or
   [`environment.prod.ts`](../../apps/trinity/src/environments/environment.prod.ts).
   Both checked-in defaults are `null`. A saved device override takes precedence
   over the build default; with neither configured, registration is disabled.

   ```ts
   push: { gatewayUrl: 'https://push.example/_matrix/push/v1/notify' },
   ```

   [`PushConfig`](../../libs/data-access/notifications/src/lib/push-config.ts)
   accepts `gatewayUrl` and an optional base `appId`. Omitting `appId` uses
   `eu.qwky.trinity`. `PushService` appends the platform suffix, so configure the
   gateway entries as `eu.qwky.trinity.android` and `eu.qwky.trinity.ios`, or the
   equivalent suffixed names for a custom base ID. The gateway's app key is
   distinct from the native bundle/package ID, which has no platform suffix.

3. For Android, register package `eu.qwky.trinity` in the matching Firebase
   project and place its downloaded configuration at
   `android/app/google-services.json`, following [Firebase's Android setup](https://firebase.google.com/docs/android/setup).
   [`build.gradle`](../../android/app/build.gradle) applies Google Services only
   when this nonempty file exists. The manifest already declares
   `POST_NOTIFICATIONS` and the `messages` channel; runtime permission and a
   correctly configured gateway are still required for delivery.
4. For iOS, provision the App ID and signing profile with Push Notifications
   enabled, then add that capability to the App target in Xcode as described in
   [Capacitor's iOS push setup](https://capacitorjs.com/docs/apis/push-notifications#ios).
   The checked-in project has registration callbacks in
   [`AppDelegate.swift`](../../ios/App/App/AppDelegate.swift), but no push
   entitlement; callback code alone does not provision the capability. Configure
   the gateway with credentials permitted for this bundle and APNs environment.
   For token authentication, [create an APNs-enabled private key](https://developer.apple.com/help/account/keys/create-a-private-key)
   and supply its key file, Key ID and Team ID through the gateway's configuration.
   Do not infer silent background handling from notification registration: the
   [Capacitor plugin does not implement iOS silent push](https://capacitorjs.com/docs/apis/push-notifications#silent-push-notifications--data-only-notifications).
5. Rebuild, sync and install the native host with `pnpm android:run`, or
   `pnpm ios:run` on macOS with Xcode and signing configured. These commands own
   the web build and Capacitor sync; see [mobile run and debug guidance](../platforms/mobile.md).
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
   unregister. Remove pushers before invalidating credentials or clearing the
   gateway configuration.

5. Listener preparation and recovery observation are bounded, but a healthy retained listener has
   no idle timeout. Targeted retry reuses retained ownership for registration failures and
   reattaches only the push listener when ownership was released. Diagnostics include stable
   registration codes, never tokens, Account IDs, gateway responses or notification payloads.

The gateway setting is device-local and not secret: its URL is sent to the
homeserver in pusher metadata. The user-facing settings flow validates and
explains it in [Control notifications](../users/notifications.md#configure-mobile-push-carefully).

Treat the gateway as a metadata boundary. Its shared device token can correlate
the installation's account pushers, and the pusher owner tag can identify an
account when forwarded for activation. `event_id_only` excludes message text,
but it does not make room/event identifiers, unread counts, priority, or account
metadata private from the gateway operator.

## Keep a gateway migration recoverable

A pusher is identified by account, app ID, and device token. Changing the app ID
creates another pusher; it does not update the old one. The separate
`appliedAppId` ledger records the app ID that reached the homeserver. On an app
ID change, `PushService` removes stale pushers before setting replacements. If
that sequence stops after removal, the account stays unregistered until the next
registration; setting first would leave the old gateway receiving events.

The ledger advances only after every account succeeds. Clearing a gateway must
therefore unregister first, while the ledger still identifies every app ID to
remove. The service attempts a pusher readback for the app-ID/token identity. A
definitive missing tuple changes registration to an error; a failed readback is
inconclusive and preserves the applied result. Neither result proves a gateway
or platform service delivered an alert.

A rotated device token has a different identity from an app-ID change. Current
registration does not remove the old-token pusher automatically; logout or
explicit cleanup remains the recovery path.

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
