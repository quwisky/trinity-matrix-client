# Library inventory

The workspace holds one application and 40 libraries. Every library carries a `type:*` and a
`scope:*` tag in its `project.json`, and the UI libraries carry a third `ui:*` tag that
separates Trinity's own wrapper layer from the vendored kit; those tags are what
[`@nx/enforce-module-boundaries`](https://github.com/quwisky/trinity-matrix-client/blob/develop/eslint.config.mjs)
checks. See [the architecture overview](index.md) for what each tag permits.

Libraries are imported through `@trinity/*` path aliases declared in
[`tsconfig.base.json`](https://github.com/quwisky/trinity-matrix-client/blob/develop/tsconfig.base.json),
never by relative path across a library boundary. Imports _within_ a library stay relative.

`libs/` itself has seven entries. Three are layer parents holding that layer's libraries:
`data-access/` (12), `feature/` (5) and `util/` (1). `spartan/` (19) groups the Helm components and
the overlay adapters. The remaining three are single libraries sitting directly under `libs/`:
`platform-native`, `testing` and `ui`.

A library answers to three different strings, and they are not interchangeable. The directories
were nested without renaming the Nx projects, so for the rooms data-access library:

| What            | Value                        | Declared in                            |
| --------------- | ---------------------------- | -------------------------------------- |
| Nx project name | `data-access-rooms`          | `name` in the library's `project.json` |
| Directory       | `libs/data-access/rooms`     | the filesystem                         |
| Import alias    | `@trinity/data-access/rooms` | `paths` in `tsconfig.base.json`        |

Nx takes the project name, so `pnpm exec nx test data-access-rooms` is still the command to run
that library's specs and nothing about the move changed it. Source code takes the alias. In the
tables below, the `Library` column is the directory and the `Alias` column is what you import.

## Utility libraries

Pure code with no Angular dependency injection. `type:util` may depend only on other `type:util`
libraries, which in practice means npm packages and nothing else in the workspace.

| Library            | Alias                  | Tags                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/util/matrix` | `@trinity/util/matrix` | `type:util`, `scope:shared` | 26 DI-free modules: the `MessageView` model and its builders, day separators, date formatting, edit history and diffing, timeline-event helpers, media and session models, the Rust crypto store naming, presence, message content, markdown editing, voice, typing, `matrix.to` links, polls, transient-error classification, password UIA, attachment and key-file crypto, authenticated media, room avatars, room creation, room state, the Shiki code highlighter, and the crypto WASM loader |
| `libs/testing`     | `@trinity/testing`     | `type:util`, `scope:shared` | One export: the zoneless-safe `render()` wrapper every component spec must use. See [testing](../contributing/testing.md)                                                                                                                                                                                                                                                                                                                                                                         |

`libs/testing` is the one project in the workspace whose `project.json` declares `"targets": {}`.
It picks up an inferred `lint` target from the `@nx/eslint` plugin, but it has no `test` target at
all, so its own correctness is only ever exercised through the specs that import it.

## Platform library

| Library                | Alias                      | Tags                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/platform-native` | `@trinity/platform-native` | `type:platform`, `scope:shared` | Every capability that differs by platform, behind one API: secure storage, session storage, storage persistence, feature flags, privacy settings, geolocation, voice recording, composer drafts, system-line settings, composer settings, theme, date and time formats, the mobile app badge, the Electron preload bridge, keyboard-shortcut chords, the global error handler, the `BUILD_INFO` token, and the factory-reset primitives (`LocalDataWipeService`, bounded IndexedDB deletion, `AppRestartService`) |

The library branches on Capacitor's `isNativePlatform()` internally, so callers never do. It may
depend on `util` and nothing else, which is why it holds no Matrix knowledge.

## Data-access libraries

One library per Matrix domain. Apart from `libs/util/matrix`, which models the SDK's types, these
are the only places `matrix-js-sdk` is imported — eleven of the twelve do, `libs/data-access/gif`
being the exception. All are tagged `scope:matrix` except `data-access-matrix-client`, which is
`scope:shared`.

| Library                          | Alias                                | Tags                                   | Purpose                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/data-access/matrix-client` | `@trinity/data-access/matrix-client` | `type:data-access`, **`scope:shared`** | The client and session foundation: `MatrixClientService` (a registry of concurrently syncing accounts), `SecretStorageKeyHolder`, and the three projection primitives `projectFromClient`, `coalesce` and `reprojectOnAccountSwitch`          |
| `libs/data-access/auth`          | `@trinity/data-access/auth`          | `type:data-access`, `scope:matrix`     | Login, legacy SSO, OIDC-native authentication, logout and account switching, the whole-install `FactoryResetService`, plus `authGuard`                                                                                                        |
| `libs/data-access/crypto`        | `@trinity/data-access/crypto`        | `type:data-access`, `scope:matrix`     | `CryptoService` (4S, cross-signing and key-backup status), `VerificationService` (emoji SAS), `DevicesService`, and the dev-only `CryptoSpikeService`                                                                                         |
| `libs/data-access/gif`           | `@trinity/data-access/gif`           | `type:data-access`, `scope:matrix`     | KLIPY and Giphy search plus the provider settings. Notably imports no other `@trinity` library                                                                                                                                                |
| `libs/data-access/invites`       | `@trinity/data-access/invites`       | `type:data-access`, `scope:matrix`     | Incoming room invites, and the mixed-account variant                                                                                                                                                                                          |
| `libs/data-access/media`         | `@trinity/data-access/media`         | `type:data-access`, `scope:matrix`     | `MediaService` for encrypted attachments, and `AvatarService`                                                                                                                                                                                 |
| `libs/data-access/notifications` | `@trinity/data-access/notifications` | `type:data-access`, `scope:matrix`     | Web and OS notifications, push registration, the push gateway, the app badge, per-room notification settings, push rules and keyword rules                                                                                                    |
| `libs/data-access/pinned`        | `@trinity/data-access/pinned`        | `type:data-access`, `scope:matrix`     | Pinned messages for the open room                                                                                                                                                                                                             |
| `libs/data-access/profile`       | `@trinity/data-access/profile`       | `type:data-access`, `scope:matrix`     | Profile, presence and ignored users                                                                                                                                                                                                           |
| `libs/data-access/rooms`         | `@trinity/data-access/rooms`         | `type:data-access`, `scope:matrix`     | The largest domain library: the room list, spaces, space children and per-space ordering, room settings, moderation and aliases, the public-room directory, the account scope, the three mixed-account projections, and the unread aggregator |
| `libs/data-access/search`        | `@trinity/data-access/search`        | `type:data-access`, `scope:matrix`     | Quick-switcher ranking, directory search and in-room message search                                                                                                                                                                           |
| `libs/data-access/timeline`      | `@trinity/data-access/timeline`      | `type:data-access`, `scope:matrix`     | `TimelineService`, `ThreadsService`, URL previews and edit history                                                                                                                                                                            |

Data-access libraries may depend on one another, and several do. The real edges today are
`notifications → rooms, timeline`, `search → rooms, invites`, `timeline → media`, and
`auth → media, notifications`. Every domain library except `data-access-gif` also depends on
`data-access-matrix-client`.

!!! warning "data-access-matrix-client is scope:shared on purpose"

    It is the only data-access library outside `scope:matrix`, and that is what keeps the client
    and session foundation domain-agnostic. Adding an import of any domain library to it fails lint
    on the scope axis even though the type axis would allow it. If you find yourself wanting to,
    the dependency belongs the other way round.

## Feature libraries

Screens and pages. `type:feature` may not depend on another `type:feature`; see
[crossing a forbidden edge on purpose](index.md#crossing-a-forbidden-edge-on-purpose).

| Library                 | Alias                       | Tags                           | Purpose                                                                                                                                                                                           |
| ----------------------- | --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/feature/shell`    | `@trinity/feature/shell`    | `type:feature`, `scope:matrix` | The application shell: `AppComponent`, `VerificationHostComponent`, `NavigationFocusService`                                                                                                      |
| `libs/feature/auth`     | `@trinity/feature/auth`     | `type:feature`, `scope:matrix` | `LoginPage` and `SsoCallbackPage`                                                                                                                                                                 |
| `libs/feature/crypto`   | `@trinity/feature/crypto`   | `type:feature`, `scope:matrix` | `EncryptionSetupPage`, `EncryptionUnlockPage`, `DeviceVerificationPage`                                                                                                                           |
| `libs/feature/rooms`    | `@trinity/feature/rooms`    | `type:feature`, `scope:matrix` | The entire chat surface, across 44 component directories: the rooms shell, sidebar and server rail, message list, composer, threads, reactions, polls, media, search, member and space management |
| `libs/feature/settings` | `@trinity/feature/settings` | `type:feature`, `scope:matrix` | Exports only `settingsRoutes`; the settings shell and its eleven sections are internal routing targets                                                                                            |

`feature-settings` is worth copying as a pattern. Its public surface is a route table, not a set of
components, so nothing outside the library can accidentally import one of its sections and pull it
into another chunk.

## UI libraries

Presentational only. `type:ui` may not depend on `type:data-access`, so a component here can never
reach a service.

| Library                        | Alias                              | Tags                                    | Purpose                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/ui`                      | `@trinity/ui`                      | `type:ui`, `scope:shared`, `ui:wrapper` | Trinity's own presentational components (`trn-avatar`, banner, page header, media bubble, message toolbar), the `AVATAR_RESOLVER` and `ENCRYPTION_DIALOG_COMPONENTS` tokens, `EncryptionDialogService`, and the `runWithBusy`, media-query and internal-URL helpers                               |
| `libs/components/emoji-picker` | `@trinity/components/emoji-picker` | `type:ui`, `scope:shared`, `ui:public`  | Trinity-authored: `<trn-emoji-picker>` over `TrnEmojiPick`, plus the `TrnEmojiIndex` facade the `:shortcode` autocomplete uses — the only importer of `@ctrl/ngx-emoji-mart`                                                                                                                      |
| `libs/components/icon`         | `@trinity/components/icon`         | `type:ui`, `scope:shared`, `ui:public`  | Trinity-authored: `<trn-icon>` over a closed `TrnIconName` union of the 82 icons in use, the single `TRN_ICONS` vendor map, and `provideTrnIcons()` — the only importer of `@ng-icons` outside the generated kit                                                                                  |
| `libs/components/overlay`      | `@trinity/components/overlay`      | `type:ui`, `scope:shared`, `ui:public`  | Trinity-authored imperative overlay adapters: `TrnDialogService`, `TrnAlertService`, `TrnActionSheetService`, `TrnToastService`, plus `TrnDialogRef`, Trinity's own two-method handle (`close`, `closed`) so a modalled component can close itself without naming `@angular/cdk` in its signature |

`libs/components/*` is the **public tier**, tagged `ui:public`: Trinity-authored wrappers whose
API is ours, so the library underneath can be swapped without touching a call site. It is the
only UI tier feature code is meant to reach.

The seventeen libraries under `libs/spartan/` are `@spartan-ng/cli`-generated Helm components,
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

## The two secondary entry points

Almost every alias points at a library's barrel, its `src/index.ts`. Two point at a single file
instead, and both exist for a bundling reason rather than a stylistic one.

| Alias                                 | Target                                       | Why it bypasses the barrel                                                                                                                                                                                                                                           |
| ------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@trinity/util/matrix/code-highlight` | `libs/util/matrix/src/lib/code-highlight.ts` | `message-view.ts` is in the eager chunk, and a barrel export would drag every Shiki grammar in with it. The module self-registers via `setCodeHighlighter()` when evaluated, so the render path stays synchronous; the lazily loaded rooms route is what pulls it in |
| `@trinity/feature/shell/home-page`    | `libs/feature/shell/src/lib/home.page.ts`    | `main.ts` imports the `feature-shell` barrel eagerly for `AppComponent`, so re-exporting the dev-only E2EE spike harness would ship it, and `CryptoSpikeService` with it, in production                                                                              |

Nothing enforces either exclusion. Both barrels carry a comment explaining it, and that comment is
the only guard. Before adding an export to a barrel that the app imports eagerly, check what it
drags along.

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
