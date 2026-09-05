# Architecture overview

Trinity is an Nx **integrated** monorepo: four first-class host applications — Web/PWA at
`apps/trinity`, Android at `android/`, iOS at `ios/` and Electron at `electron/` — and 58
libraries under `libs/`, grouped by layer into `libs/application/`, `libs/data-access/`,
`libs/feature/`, `libs/util/`, `libs/runtime/` and `libs/components/` (the public component tier),
alongside `libs/platform-native`, `libs/testing` and the `libs/spartan/`
Helm components. Web, iOS, Android and desktop are all the same compiled bundle wrapped
differently, so there is no per-platform source tree. Host differences are selected behind
`@trinity/runtime/host` capabilities and implemented by `libs/platform-native`; they are not forks
of the app.

Names like `data-access-discovery` on this page are Nx project names, which is what `nx` commands take.
A library's directory and its import alias are two further, different strings; see
[the library inventory](libraries.md) for the mapping.

`nx.json` sets `"defaultBase": "develop"`, so `nx affected` diffs against `develop` rather than
`main`.

Trinity has contracted its capability-centered ownership model. The technical-layer rules remain
active alongside `role:*` and `capability:*` metadata, with empty migration-exception ledgers;
see the [target architecture](target-architecture.md), [migration baselines](migration-baselines.md),
[final validation record](final-validation.md),
and [generated dependency map](generated/dependency-map.md).

## Host projects are composition roots

`apps/trinity/src` contains no product component, directive, service or product policy. It selects
routes, environment values, lazy application-surface loaders and the Web-only service worker,
then delegates composition and lifetime ownership to `@trinity/application/runtime`. Its
production TypeScript source surface is:

| File                                                                       | What it is                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `main.ts`                                                                  | Thin host bootstrap, environment selection and Web service worker     |
| `app/app.routes.ts`                                                        | The eight top-level routes, plus a development-only ninth             |
| `app/application-dialog-loaders.ts`                                        | Cold Settings and Trust lazy-loader selection                         |
| `app/build-info.ts`                                                        | Generated at build time by the `build-info` target, and git-ignored   |
| `environments/environment.ts`, `environment.prod.ts`                       | Build-time configuration                                              |
| `polyfills.ts`                                                             | Comment-only; it exists to record that zone.js is deliberately absent |
| `test-setup.ts`                                                            | One line; it imports the workspace-root `test-setup.base.ts`          |
| `index.html`, `global.scss`, `theme/`, `rendered-markdown.scss`, `assets/` | Shell markup, styles and static assets                                |

The application root, `VerificationHostComponent`, startup state, retry surface, route-focus
source, concrete runtime/session adapters and Workspace presenters live in
`@trinity/application/runtime`. `provideTrinityApplication()` binds those implementations and all
cross-capability ports behind one provider interface; `startApplicationRuntime()` owns the sole
runtime subscription until Angular destroys the application. The remaining
`@trinity/feature/shell` entrypoint is only the lazy, development-only crypto spike page.

`trinity-android` and `trinity-ios` are thin Nx applications over the checked-in Capacitor
projects. Their `sync`, `build` and `run` targets depend on the `trinity` production build and
copy its exact flat `www/` artifact; they contain no product code or alternate composition.
Each also exposes a Docker-free static `verify` contract and a platform-toolchain
`verify-native` target. Android additionally owns the serialized installed-WebView journey.

`trinity-desktop` is the explicit Nx application for the standalone Electron package. Its
targets install the shell's pinned dependency graph, build and copy the same production `www/`
artifact, compile/test the main and preload processes, launch the custom-protocol renderer and
package each desktop platform. Its contract pins the versioned, sender-validated capability
bridge, hardened window and packaging posture; its serialized smoke journey launches the real
binary without Docker.

The build emits to the workspace-root `www/` directory rather than `dist/`, because Capacitor and
the Electron shell both wrap that directory unchanged. See
[the web platform page](../platforms/web.md) for what the build produces.

## Layers and the direction dependencies point

Every shipped project that participates in the application graph carries both the current
`type:*`/`scope:*` tags and target `role:*`/`capability:*` metadata. The current tags remain the
hard ESLint boundary while the target metadata is checked by `pnpm architecture:check` against a
frozen exception ledger.
[`@nx/enforce-module-boundaries`](https://github.com/quwisky/trinity-matrix-client/blob/develop/eslint.config.mjs)
turns the current tags into compile-time-adjacent rules. Dependencies point inward, and the rule set is
declared once at `eslint.config.mjs`.

| Source tag         | May depend on                                      | The point of the restriction                                                       |
| ------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `type:app`         | `feature`, `ui`, `data-access`, `util`, `platform` | The app composes providers and supplies concrete application adapters              |
| `type:feature`     | `ui`, `data-access`, `util`, `platform`            | **A feature may not import another feature.** Screens stay independently loadable  |
| `type:data-access` | `data-access`, `util`, `platform`                  | Domain services may fan out sideways to each other, but never up into a screen     |
| `type:ui`          | `ui`, `util`, `platform`                           | Presentational only. A `ui` component can never reach a service                    |
| `type:platform`    | `platform`, `util`                                 | Capability wrappers sit below everything except pure code                          |
| `type:util`        | `util`                                             | Pure, DI-free code. `libs/util/matrix` may depend on npm packages and nothing else |

A third axis, `ui:*`, separates the two halves of the UI tier so third-party UI can be
contained: `libs/components/*` is `ui:public`, the vendored Helm kit is `ui:vendor-wrapper`,
and `bannedExternalImports` keeps `@spartan-ng/brain`, `@angular/cdk`, `@ng-icons` and
`@ctrl/ngx-emoji-mart` out of `feature`, `data-access`, `util`, `platform` and `app`
entirely. Both UI tiers are exempt because both are wrapper layers; the public tier is
contained from the consumer side instead. Nothing is staged: all four
are errors at every tier below the kit, so a new vendor import fails `pnpm lint` rather than
warning. The kit is unrestricted because it is the wrapper. Each glob carries a trailing `*` — without it the
pattern matches only the bare specifier, nothing imports that, and the ban silently enforces
nothing while lint reports success. See [UI and theming](ui-and-theming.md).

There is no escape hatch. The rule is configured with `allow: []`, and there is not a single
`eslint-disable` for `@nx/enforce-module-boundaries` anywhere under `apps/` or `libs/`. A violation
fails `pnpm lint`, and the `pre-commit` hook runs lint-staged, so it fails the commit too.

## The second axis is scope

The `scope:*` tags are checked independently of the `type:*` tags, and a dependency has to satisfy
both.

| Source tag     | May depend on                  |
| -------------- | ------------------------------ |
| `scope:matrix` | `scope:matrix`, `scope:shared` |
| `scope:shared` | `scope:shared` only            |

`scope:shared` is the kernel: `util-matrix`, `projection-runtime`, `platform-native`, `ui`, the Helm
libraries — and, deliberately, `data-access-matrix-client`. Tagging the client and session foundation as shared
rather than matrix is what structurally prevents it from importing a domain library. `RoomLibraryService`
depends on `MatrixClientService`; `MatrixClientService` can never depend on `RoomLibraryService`, and
lint says so before a reviewer has to.

This is the axis that surprises people. A new import into `data-access-matrix-client` from, say,
`data-access-discovery` passes the type rule (`type:data-access` may depend on `type:data-access`) and
still fails the scope rule. That is the intended behaviour, not a misconfiguration.

## The rule that matters most

**Components never import `matrix-js-sdk`.**

This is not a style preference; it is checkable, and it currently holds absolutely. Across every
non-spec file in `libs/feature/*`, `libs/components/*` and `libs/platform-native` there are zero imports from
`matrix-js-sdk`. The SDK appears only under `libs/data-access/` — in eleven of its fourteen
libraries; `data-access-accounts` composes the Matrix adapter, `data-access-gif` talks to
KLIPY and Giphy, and Identity consumes its lifecycle-free Matrix port, so those three do not
import the SDK — and in
`libs/util/matrix`, which models its types.

Two things follow from keeping it that way:

- **The UI is testable without a homeserver.** A component that only reads signals and calls
  service methods can be rendered against mocked services, which is why the unit suite runs with no
  network at all.
- **The SDK stays swappable.** `matrix-js-sdk` is a large, fast-moving dependency. Confining it to
  one layer means a breaking change in it has a bounded blast radius.

When a feature genuinely needs an SDK _type_ — not the SDK — the owning data-access library
re-exports it. `libs/data-access/auth/src/index.ts` re-exports `OidcClientConfig` from
`matrix-js-sdk` with a comment saying exactly why: so a feature library can type delegated-auth
metadata without an SDK import of its own.

New SDK interaction belongs in a `data-access-*` service. See
[state and reactivity](state-and-reactivity.md) for the shape those services take.

The proposed visual evolution of those UI layers is documented separately in the
[modern UI redesign plan](modern-ui-redesign.md). It keeps the same dependency direction and
cross-platform bundle while modernising the shared design system and high-traffic surfaces in
reviewable phases.

## Crossing a forbidden edge on purpose

Some legitimate needs run against the grain of the layering. An incoming or user-initiated
verification request has to raise a `feature-crypto` page from Application Runtime or Workspace,
while feature-to-feature imports are banned.

Both are solved through an inward-facing application port, provided at the app with lazy feature
adapters. For user-initiated Settings and trust flows the port is
`WORKSPACE_APPLICATION_SURFACE_PRESENTER`, declared by `@trinity/application/workspace` and
consumed through cold `WorkspaceApplicationSurfaceService.open()` commands. Callers name a typed
semantic surface and optional semantic return destination; only the app adapter names Router,
platform policy, dialogs, or dynamic feature imports.

Application Runtime owns the inward-facing Trust loader seam. It exposes cold Observables, so
requesting a page has no effect until the presenter subscribes:

```ts
// libs/application/runtime/src/lib/application-dialog-loaders.ts
export type EncryptionDialogLoaders = Record<'unlock' | 'verify', () => Observable<Type<unknown>>>;
export const ENCRYPTION_DIALOG_COMPONENTS = new InjectionToken<EncryptionDialogLoaders>('ENCRYPTION_DIALOG_COMPONENTS');
```

```ts
// apps/trinity/src/main.ts
{
  provide: ENCRYPTION_DIALOG_COMPONENTS,
  useValue: {
    unlock: () => defer(() => import('@trinity/feature/crypto')).pipe(
      map((module) => module.EncryptionUnlockPage),
    ),
    verify: () => defer(() => import('@trinity/feature/crypto')).pipe(
      map((module) => module.DeviceVerificationPage),
    ),
  } satisfies EncryptionDialogLoaders,
}
```

The optional Workspace presenter is what makes this a port rather than a hidden upward edge: an
unwired host returns a typed `unavailable` outcome. The app adapter consumes the encryption
loaders optionally and falls back to the canonical `/encryption/*` routes when they are absent.
`AVATAR_RESOLVER` in `@trinity/components/generic-content` follows the identical contract:
the app wires it to `AvatarService.resolve`, and unwired, `<trn-avatar>` just uses its `url` input.

`VerificationHostComponent` reuses the Application Runtime loader seam rather than adding a second one. It renders
nothing, is mounted app-wide in `app.component.html` so an incoming verification is caught on any
route, and subscribes to `dialogComponents?.verify()` to lazy-load a page from a library it does
not import. It only presents `TrustVerificationService.active`; the named Trust session lifetime
owns incoming-request attachment and teardown.

!!! warning "Do not reach for a token first"

    A presentation port is the second-choice resolution. The first is to read the relevant
    `@trinity/data-access/*` signal from the feature that owns the surface: the encryption banner
    lives in `feature-rooms` and injects `TrustService` directly, then asks Workspace to present a
    typed trust surface rather than importing anything from `feature-crypto`. Reach for a port only
    when one feature must *present* another's page.

## Routing and lazy loading

All routes are declared in
[`apps/trinity/src/app/app.routes.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/apps/trinity/src/app/app.routes.ts),
and every one of them is lazy.

| Path                | Guard                             | Loads                                                        |
| ------------------- | --------------------------------- | ------------------------------------------------------------ |
| `login`             | none                              | `LoginPage` from `feature-auth`                              |
| `sso-callback`      | none                              | `SsoCallbackPage` from `feature-auth`                        |
| `rooms`             | `authGuard`                       | `RoomsPage` from `feature-rooms`                             |
| `settings`          | `authGuard`                       | `settingsRoutes` from `feature-settings`, via `loadChildren` |
| `encryption/setup`  | `authGuard`, plus `canDeactivate` | `EncryptionSetupPage` from `feature-crypto`                  |
| `encryption/unlock` | `authGuard`, plus `canDeactivate` | `EncryptionUnlockPage` from `feature-crypto`                 |
| `encryption/verify` | `authGuard`                       | `DeviceVerificationPage` from `feature-crypto`               |
| `spike`             | none, development builds only     | The dev E2EE harness from `feature-shell`                    |
| `''`                | —                                 | Redirects to `rooms`                                         |

Four details are not obvious from the table:

- **`authGuard` restores every Account, not one.** It short-circuits when Account Runtime already
  has an Active Account; otherwise its cold restore command starts the Active Account first and
  restores the remaining saved Accounts concurrently under per-Account deadlines. Navigation
  continues when the Active Account is ready even if an inactive Account needs reauthentication
  or fails, while an unavailable Active Account redirects to `/login`.
- **Authentication does not own a live Account.** Password, SSO, OIDC, and registration produce
  an opaque authenticated grant plus an explicit placement intent. Account Runtime alone persists
  the Account, starts its Matrix runtime, and commits Active placement; expected lifecycle
  failures remain typed through the compatibility auth facade and are translated into safe copy
  only by the current login screens.
- **`/settings` has no default child redirect.** Bare `/settings` renders the settings shell with
  an empty detail outlet; the fourteen sections are children of it. In-app entry points on web and
  Electron normally open the same registry in `SettingsDialogComponent` without navigating. The
  route remains the installed-mobile target and bookmark/deep-link surface. A failed modal chunk
  leaves the current room route intact and produces a retryable error instead of attempting the
  same unavailable feature chunk through the router.
- **Application routes attach to Workspace by semantic identity.** Direct Settings and encryption
  deep links register through the app-owned routed-surface adapter. Host Back closes a narrow
  Settings detail before Settings itself, honours a validated trust-flow return destination, and
  falls back to `/rooms` for a cold link with no history. Browser Back remains browser-owned.
- **The `canDeactivate` guards on the two encryption routes exist because those pages display a
  recovery key exactly once and never persist it.** The browser Back button would otherwise
  discard it silently. Those guards are also why `main.ts` passes
  `withRouterConfig({ canceledNavigationResolution: 'computed' })`: under the default `'replace'`,
  a guard that cancels a popstate navigation makes the router overwrite the history entry the
  browser has already moved to, so the next Back press jumps two entries instead of asking again.
- **The page classes are imported `import type`.** `app.routes.ts` needs `EncryptionSetupPage` and
  `EncryptionUnlockPage` only to type the guard callbacks; a value import would pull the crypto
  feature into the initial bundle and defeat the `loadComponent` split entirely.

The dev-only `/spike` route is _spread out of the array_ rather than guarded by a ternary
(`...(environment.production ? [] : [ … ])`), because esbuild does not constant-fold
`environment.production`. A ternary would leave the route absent at runtime but still ship the
chunk and precache it in the service worker.

The development-only spike is exported from `@trinity/feature/shell`, but the production
entrypoint never imports that library. Its dynamic route import therefore keeps the crypto harness
out of the eager application chunk.

The router is configured with `withPreloading(PreloadAllModules)`, so lazy chunks are fetched in
the background after the first route settles.

## Application startup

`@trinity/application/runtime` exposes one read-only state signal plus cold `run`, `recover` and
`stop` commands. A startup attempt executes six stages in order: host negotiation, installation
preference hydration, saved-Account restoration, optional session capabilities, Workspace
restoration, then application readiness. The production adapter preserves the old paint-order
constraints while initial Router navigation is disabled; it releases `initialNavigation()` only
after Account Runtime settles, so guards cannot race or duplicate cold-start restoration.

A required failure publishes a value-free diagnostic and typed recovery while the application
lifetime waits for `recover()` to execute that recovery before starting a new attempt. Partial
inactive-Account restoration and optional push, badge or update failures accumulate as visible,
non-blocking warnings. Once ready, the same runtime
subscription owns notification delivery and activation, badge projection, deep links, host Back, native gesture policy, route focus,
Workspace surface registrations, per-Account space-order hydration and service-worker updates.
Presenter and badge failures are emitted as session warnings; they do not end the runtime or bypass
Workspace's normal destination validation and repair.
`stop()` tears every source down;
subscribing to `run()` again performs a clean restart.

`main.ts` contains zero `provideAppInitializer` calls and no direct product implementation imports,
both frozen by the Web host contract. It passes routes, build/environment values and cold lazy
loaders to `provideTrinityApplication()`, adds only the Web service-worker registration, and hands
the bootstrapped application to `startApplicationRuntime()`. Application Runtime owns zoneless
change detection, error handling, cross-capability adapters, presentation loaders and exactly one
runtime subscription for the Angular application's lifetime.

## Where to read next

- [Library inventory](libraries.md) — every library, its tags, and what it is for.
- [State and reactivity](state-and-reactivity.md) — the projection idiom, `projectFromClient`, and
  the traps around it.
- [Matrix and encryption](matrix-and-encryption.md) — the client registry, sessions, and E2EE.
- [Image packs](image-packs.md) — MSC2545 discovery, projections, stable/legacy precedence,
  account-data mutation, and trust boundaries.
- [UI and theming](ui-and-theming.md) — Helm, Tailwind and the design tokens.
