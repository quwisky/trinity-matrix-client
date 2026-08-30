# Library inventory

The workspace holds one application and 83 libraries. Every shipped library carries its current
`type:*` and `scope:*` tags plus target `role:*` and `capability:*` metadata; UI libraries also
carry a `ui:*` tag that
separates Trinity's own wrapper layer from the vendored kit; those tags are what
[`@nx/enforce-module-boundaries`](https://github.com/quwisky/trinity-matrix-client/blob/develop/eslint.config.mjs)
checks. See [the architecture overview](index.md) for what each tag permits.

The role/capability metadata is an incremental overlay, not a claim that the move is already
complete. Multi-capability projects and cross-capability edges are enumerated with removal issues
in the [generated dependency map](generated/dependency-map.md); `pnpm architecture:check` rejects
any unrecorded expansion.

Libraries are imported through `@trinity/*` path aliases declared in
[`tsconfig.base.json`](https://github.com/quwisky/trinity-matrix-client/blob/develop/tsconfig.base.json),
never by relative path across a library boundary. Imports _within_ a library stay relative.

`libs/` itself has nine entries. Six are layer parents holding that layer's libraries:
`application/` (3), `data-access/` (15), `feature/` (5), `util/` (2), `runtime/` (3) and `components/` (31) — the public
component tier feature code reaches for. `spartan/` (22) groups the generated Helm components plus
the `tests` project that holds the specs pinning their behaviour. The remaining two are single
libraries sitting directly under `libs/`: `platform-native` and `testing`.

A library answers to three different strings, and they are not interchangeable. For Room Library:

| What            | Value                               | Declared in                            |
| --------------- | ----------------------------------- | -------------------------------------- |
| Nx project name | `data-access-room-library`          | `name` in the library's `project.json` |
| Directory       | `libs/data-access/room-library`     | the filesystem                         |
| Import alias    | `@trinity/data-access/room-library` | `paths` in `tsconfig.base.json`        |

Nx takes the project name, so `pnpm exec nx test data-access-room-library` is the command to run
that library's specs. Source code takes the alias. In the
tables below, the `Library` column is the directory and the `Alias` column is what you import.

## Utility libraries

Pure code with no Angular dependency injection. `type:util` may depend only on other `type:util`
libraries, which in practice means npm packages and nothing else in the workspace.

| Library            | Alias                  | Tags                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/util/matrix` | `@trinity/util/matrix` | `type:util`, `scope:shared` | 26 DI-free modules: the `MessageView` model and its builders, day separators, date formatting, edit history and diffing, timeline-event helpers, media and session models, the Rust crypto store naming, presence, message content, markdown editing, voice, typing, `matrix.to` links, polls, transient-error classification, password UIA, attachment and key-file crypto, authenticated media, room avatars, room creation, room state, the Shiki code highlighter, and the crypto WASM loader |
| `libs/util/ui`     | `@trinity/util/ui`     | `type:util`, `scope:shared` | The view-layer helpers that are not components: `runWithBusy`, `mediaQuerySignal` with the `MD_QUERY`/`BELOW_MD_QUERY` breakpoint pair, and `resolveInternalReturnTo`. Both stateful helpers take a `DestroyRef` rather than injecting one, which is what keeps this library DI-free                                                                                                                                                                                                              |
| `libs/testing`     | `@trinity/testing`     | `type:util`, `scope:shared` | Test-only helpers: the zoneless-safe `render()` wrapper and a complete protocol-v1 Electron bridge fixture. See [testing](../contributing/testing.md)                                                                                                                                                                                                                                                                                                                                             |

`libs/testing` is the one project in the workspace whose `project.json` declares `"targets": {}`.
It picks up an inferred `lint` target from the `@nx/eslint` plugin, but it has no `test` target at
all, so its own correctness is only ever exercised through the specs that import it.

## Shared runtime libraries

| Library                    | Alias                          | Tags                                                                     | Purpose                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `libs/runtime/projection`  | `@trinity/runtime/projection`  | `type:data-access`, `scope:shared`, `role:kernel`                        | Projection Runtime: four closed scope variants, generation-safe publication, coalesced reconciliation, attachment/reset/reattachment ownership, finite readiness barriers, and deterministic listener, retained-payload, and latency diagnostics             |
| `libs/runtime/host`        | `@trinity/runtime/host`        | `type:platform`, `scope:shared`, `role:kernel`, `capability:host`        | Narrow operation contracts, explicit supported/unavailable manifests, and cold finite product-facing commands for authentication handoff, deep links, Back, file export, notification presentation, location, badges, secure storage, lifecycle, and updates |
| `libs/runtime/preferences` | `@trinity/runtime/preferences` | `type:platform`, `scope:shared`, `role:kernel`, `capability:preferences` | Policy-free typed preference catalog and context-keyed signal store; capability descriptors declare scope, default, validation, migration, sensitivity, storage/export policy, and editor metadata while hydration and writes return cold typed Observables  |

## Application workflow libraries

| Library                      | Alias                            | Tags                                                                           | Purpose                                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `libs/application/badge`     | `@trinity/application/badge`     | `type:feature`, `scope:matrix`, `role:application`, `capability:badge`         | `BadgeCoordinator` observes Room Library's aggregate unread signal for one Application Runtime session and writes only through the host-neutral `BadgeSink`; failed writes remain warning-ready typed outcomes                       |
| `libs/application/workspace` | `@trinity/application/workspace` | `type:data-access`, `scope:matrix`, `role:application`, `capability:workspace` | Typed application, Room, and compact-Conversation surface identities; the fixed semantic Back registry; and the cold application-surface presentation port whose Router/platform/UI adapter is supplied only by the composition root |
| `libs/application/runtime`   | `@trinity/application/runtime`   | `type:feature`, `scope:matrix`, `role:application`, `capability:runtime`       | Ordered six-stage startup, executable typed recovery and visible optional warnings, explicit recover/stop/restart, the presentation-only application root, and ownership of one session-long adapter stream                          |

## Platform library

| Library                | Alias                      | Tags                                                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | -------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/platform-native` | `@trinity/platform-native` | `type:platform`, `scope:shared`, `role:adapter`, `capability:host` | Web, Capacitor, and Electron adapters selected at composition, including the device-preference adapter and temporary privacy compatibility facade for the typed Preferences Store, plus legacy platform services still migrating behind operation contracts: secure/session storage, geolocation, voice, host media, theme, external-browser dispatch, the Electron preload bridge, keyboard shortcuts, error handling, build information, and reset primitives |

The adapter library may branch on host identity internally; product callers do not. It depends on
the host runtime contract and pure utilities, and holds no Matrix knowledge.

## Data-access libraries

One library per Matrix domain. Apart from `libs/util/matrix`, which models the SDK's types, these
are the only places `matrix-js-sdk` is imported — thirteen of the fifteen do, with
`libs/data-access/accounts` and `libs/data-access/gif` being the exceptions. All are tagged
`scope:matrix` except `data-access-matrix-client`, which is `scope:shared`.

| Library                                | Alias                                      | Tags                                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `libs/data-access/accounts`            | `@trinity/data-access/accounts`            | `type:data-access`, `scope:matrix`     | Account Runtime: read-only lifecycle state plus cold restore, authenticated-establishment, Active Account switch, explicit Account sign-out, and installation-reset commands; typed outcomes expose safe recovery guidance while Matrix and storage cleanup remain adapter-contained                                                                                                                                                                                                                                                                                                                                                                                                       |
| `libs/data-access/matrix-client`       | `@trinity/data-access/matrix-client`       | `type:data-access`, **`scope:shared`** | The client and session foundation: `MatrixClientService` (a registry of concurrently syncing accounts), `SecretStorageKeyHolder`, the Matrix adapter for Projection Runtime's sync-state tracer, `projectFromClient`, the lifecycle-free `TrustCryptoPort`, and the dev-only crypto startup probe                                                                                                                                                                                                                                                                                                                                                                                          |
| `libs/data-access/auth`                | `@trinity/data-access/auth`                | `type:data-access`, `scope:matrix`     | Password, legacy SSO, OIDC-native authentication and registration produce opaque Account grants for Account Runtime; `authGuard` restores through Account Runtime, and this library owns no sign-out or installation-reset lifecycle API                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `libs/data-access/trust`               | `@trinity/data-access/trust`               | `type:data-access`, `scope:matrix`     | Trust: atomic encryption-health state, cross-signing and 4S setup/recovery/reset, room-key import/export, device management, and QR/SAS verification. Commands are cold finite Observables with secret-safe typed failure and recovery metadata; QR bytes are emitted once rather than retained in public state; provider recovery is supplied through an app-composed port                                                                                                                                                                                                                                                                                                                |
| `libs/data-access/gif`                 | `@trinity/data-access/gif`                 | `type:data-access`, `scope:matrix`     | KLIPY and Giphy search plus the provider settings. Notably imports no other `@trinity` library                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `libs/data-access/homeserver`          | `@trinity/data-access/homeserver`          | `type:data-access`, `scope:matrix`     | `HomeserverInfoService`: what each signed-in account's homeserver is running — software and version (best-effort, from the federation API), spec versions and capabilities. Cached per session, never persisted                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `libs/data-access/room-library`        | `@trinity/data-access/room-library`        | `type:data-access`, `scope:matrix`     | Room Library: joined room and space summaries, incoming invitations, account scope, favourites, low-priority grouping, ordering, canonical named-row filtering, hierarchy, create/join/leave actions, mixed-account projections, and aggregate unread. Its one-shot mutations are cold finite Observables, including account-scope and ordering preference persistence, favourite/priority writes, hierarchy changes, and unread cleanup                                                                                                                                                                                                                                                   |
| `libs/data-access/media`               | `@trinity/data-access/media`               | `type:data-access`, `scope:matrix`     | `MediaPipeline` for opaque staging, encrypted transfer, typed progress/cancellation/retry and safe presentation references; its internal `MediaService` byte engine and bounded decrypted cache; `AvatarService`; the bounded MSC2545 `ImagePackService` projection; `ImagePackManagementService`; and its short-lived server-confirmed `ImagePackSelectionStore`                                                                                                                                                                                                                                                                                                                          |
| `libs/data-access/notifications`       | `@trinity/data-access/notifications`       | `type:data-access`, `scope:matrix`     | SDK-event normalization, delivery policy and typed notification intents/activations; push registration and gateway integration; per-room notification settings, push rules and keyword rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `libs/data-access/profile`             | `@trinity/data-access/profile`             | `type:data-access`, `scope:matrix`     | Profile, presence and ignored users                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `libs/data-access/room-administration` | `@trinity/data-access/room-administration` | `type:data-access`, `scope:matrix`     | Room Administration: authoritative joined-member and ban summaries, role classification and assignable presets, moderation, aliases, power-level policy, room configuration, and Conversation redaction/pin governance. Mutations are cold finite Observables with typed recovery metadata for permission refresh, invalid input, server rejection, and partial updates; Room Library and Conversation consume app-composed narrow policy ports rather than this implementation.                                                                                                                                                                                                           |
| `libs/data-access/rooms`               | `@trinity/data-access/rooms`               | `type:data-access`, `scope:matrix`     | Discovery adapters for room-link previews and the public-room directory; this temporary package is contracted by #321                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `libs/data-access/search`              | `@trinity/data-access/search`              | `type:data-access`, `scope:matrix`     | Quick-switcher ranking, directory search and in-room message search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `libs/data-access/timeline`            | `@trinity/data-access/timeline`            | `type:data-access`, `scope:matrix`     | `ConversationRuntime` owns immutable Account-and-Room handles, durable compose intent, exact message actions, privacy-aware receipts, typed text/media lifecycles, exact-root thread children and pinned-message projection/commands; Conversations physically owns and contributes its privacy preference descriptors; Message Presentation normalizes SDK-authoritative events into immutable models and replaces media security material with opaque references; Room Administration supplies redaction and pin governance through composition-root ports; package-internal projection adapters cannot be imported by features; the library also contains URL previews and edit history |
| `libs/data-access/widgets`             | `@trinity/data-access/widgets`             | `type:data-access`, `scope:matrix`     | Demand-driven room-widget discovery, safe URL-template expansion, and explicit disclosure metadata for external opening                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Data-access libraries may depend on one another, and several do. The real edges today are
`search → room-library, rooms`, `timeline → media`, and
`auth → accounts`. Every domain library except `data-access-gif` also depends on
`data-access-matrix-client`.

!!! warning "data-access-matrix-client is scope:shared on purpose"

    It is the only data-access library outside `scope:matrix`, and that is what keeps the client
    and session foundation domain-agnostic. Adding an import of any domain library to it fails lint
    on the scope axis even though the type axis would allow it. If you find yourself wanting to,
    the dependency belongs the other way round.

## Feature libraries

Screens and pages. `type:feature` may not depend on another `type:feature`; see
[crossing a forbidden edge on purpose](index.md#crossing-a-forbidden-edge-on-purpose).

| Library                 | Alias                       | Tags                           | Purpose                                                                                                                                                                                                                                           |
| ----------------------- | --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/feature/shell`    | `@trinity/feature/shell`    | `type:feature`, `scope:matrix` | The lazy development-only crypto spike page                                                                                                                                                                                                       |
| `libs/feature/auth`     | `@trinity/feature/auth`     | `type:feature`, `scope:matrix` | `LoginPage` and `SsoCallbackPage`                                                                                                                                                                                                                 |
| `libs/feature/crypto`   | `@trinity/feature/crypto`   | `type:feature`, `scope:matrix` | `EncryptionSetupPage`, `EncryptionUnlockPage`, `DeviceVerificationPage`                                                                                                                                                                           |
| `libs/feature/rooms`    | `@trinity/feature/rooms`    | `type:feature`, `scope:matrix` | The entire chat surface, across 44 component directories: the rooms shell, sidebar and server rail, message list, composer, threads, reactions, polls, media, search, member and space management                                                 |
| `libs/feature/settings` | `@trinity/feature/settings` | `type:feature`, `scope:matrix` | Exports `settingsRoutes` plus the lazy-loaded `SettingsDialogComponent`; both consume one internal registry of fourteen sections, while shared catalog renderers update capability-owned preference descriptors without owning raw keys or policy |

`feature-settings` exports only its two composition roots, not its individual sections. The app
reaches the dialog root through a dynamic loader token, so nothing outside the library can import
one section accidentally or pull the settings chunk into the initial bundle.

## UI libraries

Presentational only. `type:ui` may not depend on `type:data-access`, so a component here can never
reach a service.

| Library                             | Alias                                   | Tags                                   | Purpose                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/components/encryption-dialog` | `@trinity/components/encryption-dialog` | `type:ui`, `scope:shared`, `ui:public` | `EncryptionDialogService` and its `ENCRYPTION_DIALOG_COMPONENTS` loader token: presents the unlock and device-verification flows as a dialog on wide layouts and a route on narrow ones. Its own library rather than part of `overlay`, which stays the generic dialog wrapper                    |
| `libs/components/settings-dialog`   | `@trinity/components/settings-dialog`   | `type:ui`, `scope:shared`, `ui:public` | `SettingsDialogService` and `SETTINGS_DIALOG_CONFIG`: lazy-loads one settings modal on web/Electron, routes installed Android/iOS, reports load failures without leaving the current route, and prevents stale or duplicate opens without importing the settings feature                          |
| `libs/components/emoji-picker`      | `@trinity/components/emoji-picker`      | `type:ui`, `scope:shared`, `ui:public` | Trinity-authored: `<trn-emoji-picker>` over `TrnEmojiPick`, plus the `TrnEmojiIndex` facade the `:shortcode` autocomplete uses — the only importer of `@ctrl/ngx-emoji-mart`                                                                                                                      |
| `libs/components/field`             | `@trinity/components/field`             | `type:ui`, `scope:shared`, `ui:public` | Trinity-authored field composition: `<trn-field>` groups projected controls without changing their native behaviour, while `<trn-field-label>` owns the visual variant and native label/control association                                                                                       |
| `libs/components/icon`              | `@trinity/components/icon`              | `type:ui`, `scope:shared`, `ui:public` | Trinity-authored: `<trn-icon>` over a closed `TrnIconName` union of the 82 icons in use, the single `TRN_ICONS` vendor map, and `provideTrnIcons()` — the only importer of `@ng-icons` outside the generated kit                                                                                  |
| `libs/components/overlay`           | `@trinity/components/overlay`           | `type:ui`, `scope:shared`, `ui:public` | Trinity-authored imperative overlay adapters: `TrnDialogService`, `TrnAlertService`, `TrnActionSheetService`, `TrnToastService`, plus `TrnDialogRef`, Trinity's own two-method handle (`close`, `closed`) so a modalled component can close itself without naming `@angular/cdk` in its signature |

`libs/components/*` is the **public tier**, tagged `ui:public`: Trinity-authored wrappers whose
API is ours, so the library underneath can be swapped without touching a call site. It is the
only UI tier feature code is meant to reach.

The 22 libraries under `libs/spartan/` are `@spartan-ng/cli`-generated Helm components,
all tagged `type:ui`, `scope:shared`, `ui:vendor-wrapper`, all with the `hlm` selector prefix
(`libs/spartan/tests` is the odd one out — no components, just the two specs that pin
generated-kit behaviour across several libraries at once):

| Directory                    | Alias                         |
| ---------------------------- | ----------------------------- |
| `libs/spartan/avatar`        | `@trinity/helm/avatar`        |
| `libs/spartan/badge`         | `@trinity/helm/badge`         |
| `libs/spartan/button`        | `@trinity/helm/button`        |
| `libs/spartan/card`          | `@trinity/helm/card`          |
| `libs/spartan/checkbox`      | `@trinity/helm/checkbox`      |
| `libs/spartan/dropdown-menu` | `@trinity/helm/dropdown-menu` |
| `libs/spartan/input`         | `@trinity/helm/input`         |
| `libs/spartan/label`         | `@trinity/helm/label`         |
| `libs/spartan/progress`      | `@trinity/helm/progress`      |
| `libs/spartan/radio-group`   | `@trinity/helm/radio-group`   |
| `libs/spartan/select`        | `@trinity/helm/select`        |
| `libs/spartan/sonner`        | `@trinity/helm/sonner`        |
| `libs/spartan/spinner`       | `@trinity/helm/spinner`       |
| `libs/spartan/textarea`      | `@trinity/helm/textarea`      |
| `libs/spartan/tooltip`       | `@trinity/helm/tooltip`       |
| `libs/spartan/utils`         | `@trinity/helm/utils`         |

These are the widest case of the three-way naming split described above: the directory is
`libs/spartan/*`, the alias namespace is `@trinity/helm/*`, and the Nx project name is the bare
component name. The button library lives at `libs/spartan/button`, is imported as
`@trinity/helm/button`, and is built with `nx build button`.

Everything under `libs/spartan/` is generated; the hand-written Trinity code that used to sit
among it — the overlay adapters, the icon and the emoji picker — now lives in `libs/components/`.
Regenerating or adding Helm components goes through the CLI; see
[UI and theming](ui-and-theming.md).

## The secondary entry point

Almost every alias points at a library's barrel, its `src/index.ts`. One points at a single file
instead, for host-capability containment rather than stylistic preference.

| Alias                              | Target                                            | Why it bypasses the barrel                                                                                                                        |
| ---------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@trinity/platform-native/qr-code` | `libs/platform-native/src/lib/qr-code.service.ts` | The QR scanner consumes one host operation without importing the broad platform barrel; #312 replaces it with an operation-based host capability. |

The architecture contract records this exception. Shiki is no longer one: its highlighter lives
inside the lazy Conversations feature and `rooms.page.ts` imports it relatively, so no public alias
can pull the grammars into the eager bundle.

## Libraries are not buildable

No library outside `libs/spartan/` has a `build` target. There is no intermediate compilation step: the application build
(`@angular/build:application`) compiles library sources directly, resolved through the tsconfig
path aliases. That is what makes a cross-library change a one-step edit rather than a
build-and-consume cycle.

The sixteen generated Helm libraries do carry an `@nx/angular:ng-packagr-lite` build target from
the spartan generator, emitting to `dist/libs/spartan/<name>`. The application does not consume
those outputs.

Every library except `libs/testing` and the sixteen generated Helm ones has a `test` target, wired
through `nx:run-commands` running `vitest run` with the project directory as `cwd` — which is why
arguments to a single test run have to be forwarded after `--`. `lint` and `e2e` targets are not
declared in any `project.json` at all; they are inferred by the `@nx/eslint` and `@nx/playwright`
plugins configured in `nx.json`. See [commands](../contributing/commands.md) for how to run them.
