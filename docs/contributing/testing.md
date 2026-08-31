# Testing

A change is proven here by four independent layers. None of them subsumes another,
and each one exists because the layer below it is blind to a specific class of
failure.

| Layer                       | Command                    | Proves                                                                                 |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------------------- |
| Vitest unit specs           | `pnpm test`                | Component and service behaviour, in jsdom, against mocked collaborators                |
| Electron main-process specs | `pnpm electron:test`       | The desktop shell's Node-side logic, with the `electron` module mocked wholesale       |
| Registered system journeys  | `pnpm e2e`, `pnpm e2e:all` | Environment-owned Web, Synapse, component, protocol, Electron and Android lifecycles   |
| Focused Playwright journeys | `pnpm e2e:<environment>`   | One lifecycle with registry-validated prerequisites, serialization and artifact policy |

Invocation details for all of these — argument forwarding, the harness table, which
ones need Docker — are in [Commands](commands.md). The executable ownership model,
CI tiers and migration destination are in
[End-to-end test architecture](e2e-architecture.md). This page is about what each
layer actually establishes, and about the traps that make a spec pass without
proving anything.

## Unit tests

The `test` target is declared once in
[`nx.json`](https://github.com/quwisky/trinity-matrix-client/blob/develop/nx.json)
as an `nx:run-commands` target that runs `vitest run` with `cwd` set to the project
directory. Each project opts in by declaring an empty `"test": {}` in its own
`project.json`. Because it is run-commands and not a Vitest executor, extra Vitest
arguments have to be forwarded after `--`.

Every project's `vite.config.ts` is a single line calling `createVitestConfig(__dirname)`
from
[`vite.base.config.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/vite.base.config.ts).
That factory walks up from the project directory to the folder holding `nx.json` to
find the workspace root, so it works at any nesting depth, and wires the Analog
Angular plugin, `vite-tsconfig-paths` against `tsconfig.base.json` (which is how
`@trinity/*` aliases resolve inside specs), `environment: 'jsdom'`, and
`setupFiles: ['src/test-setup.ts']`.

Coverage is fully configured — the v8 provider, `text`/`html`/`lcov` reporters,
output under `coverage/<project>` — but it is opt-in and thresholdless. A normal
`vitest run` collects nothing, and no CI job passes `--coverage`.

### The scripts project runs plain Node, on a raised timeout

`scripts` is the one project with a `test` target that does not use that factory. Its
[`vitest.config.mjs`](https://github.com/quwisky/trinity-matrix-client/blob/develop/scripts/vitest.config.mjs)
is standalone — `environment: 'node'`, `include: ['**/*.spec.mjs']`, no Angular plugin —
because what it covers is the build scripts and the repository invariants, with no
Angular anywhere.

It also sets `testTimeout: 30_000`, which is not arbitrary.
`lint-invariants.spec.mjs` constructs a real ESLint instance and resolves configs
against the actual tree: roughly 1.6s on a warm dev machine, but 6.3s on a loaded CI
runner, past Vitest's 5s default. The result was the `Unit tests` job failing on a
timeout rather than an assertion — a red run that says nothing about the code. The
ceiling sits well clear of the worst observed time so it still catches a genuine hang,
and it is set per project, so nothing else inherits it. Do not answer a slow run here
by deleting the spec: what it guards, and why a green `pnpm lint` is not evidence of
it, is in [CI and releases](ci-and-releases.md#the-lint-invariants-spec).

### The pool is pinned to forks, and that is load-bearing

`vite.base.config.ts` sets `test.pool: 'forks'` explicitly. Without that line
`@analogjs/vite-plugin-angular` defaults the pool to `vmThreads`, which reuses
long-lived workers and is the one Vitest pool that sets no `isolateWorkers` — so
jsdom windows, TestBed state and module graphs accumulate in a single V8 isolate
for the whole run.

That put `feature-rooms`, by far the largest project, at a 4.3 GB peak and got it
OOM-killed on roughly half of all `nx run-many -t test` runs. `forks` isolates per
test file so the OS reclaims memory after each one: a measured 4.27 GB drops to
0.91 GB, for about 19% more wall time. It is also Vitest's own default, so naming
it here simply wins through the plugin's `userConfig` escape hatch, with no patching.

An earlier attempt set `VITEST_MAX_THREADS=2` on the Nx target. That was a CPU cap
for a memory-bound failure, and under `forks` the variable is inert anyway, since it
only writes `poolOptions.threads` and `poolOptions.vmThreads`.

## The app is zoneless, and so are the specs

`provideTrinityApplication()` provides `provideZonelessChangeDetection()`, the
polyfills import no `zone.js`, and the dependency is gone from `package.json`
entirely.
[`test-setup.base.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/test-setup.base.ts)
calls `setupTestBed({ zoneless: true })`, so specs exercise the same
change-detection mode as production rather than a zone-driven approximation of it.

Every project's `src/test-setup.ts` is a one-line import of that shared file. Two
projects append a local shim: `feature-rooms` a controllable `ResizeObserver` with
a static instance registry and an `emit()` hook, so the virtualized-list specs can
drive the measurement path; `feature-settings` a no-op `ResizeObserver`, because
Brain's `hlm-select` installs one on render. `util-matrix` is the exception that
imports only `@testing-library/jest-dom/vitest` — that library is DI-free and has
no TestBed.

### Import render from the workspace testing wrapper

```ts
import { render } from '@trinity/testing';
```

[`libs/testing/src/lib/render.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/testing/src/lib/render.ts)
re-exports everything from `@testing-library/angular/zoneless` and overrides
`render`. The reason is narrow and easy to trip over.

Angular Testing Library's `/zoneless` `render()` honours only Angular's native
`bindings` API and **silently ignores** the `inputs` and `on` options that every
spec in this repo passes. A required signal input is therefore never set, and the
component throws NG0950 on its first change detection. Switching to
`bindings`/`inputBinding` is not an escape, because many specs later update an input
through `componentRef.setInput`, which Angular forbids on a component that uses
input bindings — NG0317.

The wrapper renders with `skipDetectChanges: true`, applies `inputs` via
`setInput`, subscribes `on` handlers to the output emitters, and only then calls
`fixture.detectChanges()`. It deliberately types its public options against the
non-zoneless `RenderComponentOptions`, which is parameterised by the component, so
call sites keep input and output type checking.

75 of the 201 spec files import `render` from `@trinity/testing`, and exactly one
file in the workspace imports `@testing-library/angular` — the wrapper itself.
Nothing enforces that. There is no ESLint rule banning the direct import, so the
only thing standing between a new spec and an unexplained NG0950 is knowing this.

### ng-mocks, wired to Vitest spies

`test-setup.base.ts` calls `ngMocks.autoSpy(() => vi.fn())`, so every auto-mocked
method on an ng-mocks stub is already a Vitest spy: `.mockReturnValue(...)` and
`.toHaveBeenCalledWith(...)` work on it without further setup.

`MockProvider` is the dominant idiom — 104 spec files use it — for stubbing an
injected service. `MockComponent` appears in 11 files, for child components whose
rendering is not the subject of the test. To swap the live `MatrixClient` behind
`MatrixClientService` mid-spec, the standard move is
`ngMocks.stubMember(matrix, 'instance', client)`; the presence, invites, devices,
verification and crypto service specs use it heavily to prove per-account isolation.

### Detached fixtures for synchronous rAF

Two message-list components run backfill work inside `requestAnimationFrame`. jsdom
has no layout, so `scrollHeight` and `clientHeight` are both 0, the viewport always
reads as "not full", and the backfill effect engages. The specs therefore stub rAF
to fire inline:

```ts
beforeEach(() =>
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }),
);
afterEach(() => vi.unstubAllGlobals());
```

With `render()` the component is attached to `ApplicationRef`, so the signal write
from inside that synchronous callback re-enters the zoneless scheduler mid-tick and
throws `cannot synchronously execute watches while scheduling`. The fix is a
**detached** fixture, which ticks only when the spec says so:

```ts
const fixture = TestBed.createComponent(SimpleMessageListComponent);
fixture.componentRef.setInput('canLoadOlder', true);
fixture.detectChanges(); // first pass resolves the scroll viewchild
fixture.componentInstance.loadOlder.subscribe(() => emits++);
fixture.componentRef.setInput('messages', [/* … */]);
fixture.detectChanges();
```

The pattern is used at four sites across
[`simple-message-list.component.spec.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/feature/rooms/src/lib/message-list/simple-message-list/simple-message-list.component.spec.ts)
and
[`virtual-message-list.component.spec.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/feature/rooms/src/lib/message-list/virtual-message-list/virtual-message-list.component.spec.ts),
with the reasoning written out at the first one.

### jsdom shims you inherit

Three shims live in `test-setup.base.ts`, each recorded against a specific failure.

| Shim                             | Why it is there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A patched `_virtualConsole.emit` | Filters two known-benign `jsdomError` messages: `Could not parse CSS stylesheet` (Tailwind v4 emits `@property`, `color-mix` and nested rules that jsdom's CSS parser rejects) and `Not implemented: navigation` (any component redirecting via `location.href`). It has to patch the VirtualConsole rather than `console.error`, because jsdom captured the original console reference before Vitest swapped in its capturing one.                                                                                                                                                  |
| `matchMedia`                     | Brain's sonner toaster reads it in an `afterRender` hook, so rendering `<hlm-toaster>` throws without it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PointerEvent`                   | jsdom has shipped PointerEvent since 27, so this is no longer a polyfill — it survives for its **defaults**. The native constructor is spec-correct (`pointerType: ''`, `isPrimary: false`), and Brain's `BrnTooltip` opens only for `pointerType` of `mouse` or `pen`. On stock jsdom a plain `fireEvent.pointerEnter` therefore builds an event Brain silently rejects, and the spec fails in a way indistinguishable from the bug it was written to catch. The stub subclasses `MouseEvent`, because Brain reads `clientX`/`clientY` off the same object for overlay positioning. |

Two limits are recorded as verified against jsdom 30. Pointer _capture_ is still
entirely absent, so a spec driving Brain's sonner, drawer or slider swipe paths must
stub `setPointerCapture`, `hasPointerCapture` and `releasePointerCapture` itself.
And `element.click()` fires a native `PointerEvent`, so an event from a click is not
an instance of the stubbed class — latent today, since nothing does that check.

## Vitest does not type-check specs

Vitest goes through the Analog plugin and esbuild, which transpiles without type
checking. `pnpm build` uses the `production` named input, which excludes
`**/*.spec.ts`. The one type-aware ESLint rule explicitly ignores `**/*.spec.ts`,
because specs live in a tsconfig each project's own `tsconfig.json` excludes, so the
project service finds no program for them.

The first-class desktop project closes that hole for its own package:
`trinity-desktop:typecheck` invokes `electron/tsconfig.spec.json`, which includes the
production and spec sources. `e2e/**` remains separate: it sits in ESLint's global
ignores, runs through Node's type-stripping loader, and is touched only by Prettier.

!!! warning "Verify e2e edits with an explicit type check"

    A spec with a genuine type error — a wrong argument shape to a mocked service, a
    renamed model field — runs green, passes `pnpm lint`, passes `pnpm build`, and
    merges. It only surfaces later, when the assertion has quietly stopped meaning
    what it says. For `.mts` files under `e2e/`, run `tsc --noEmit` against them
    yourself.

For a library spec the equivalent is `tsc --noEmit -p libs/<lib>/tsconfig.json`. It is
worth running after any refactor that moves code between files, because two of this
workspace's gates are blind to different halves of the problem: ESLint does not flag an
undefined identifier in TypeScript (`no-undef` is off, since the compiler owns that), and
Vitest does not type-check at all. A method extracted without its free-function import
fails at runtime with `ReferenceError`; a delegate written with the wrong parameter type
passes every test. Only `tsc` names either one.

## A green-looking run can still exit 1

**Read the exit code, not the summary.** Vitest reports unhandled errors separately from
failing assertions, so a run can print `984 passed` and exit `1` on the same line-count.
Nothing in the output says "failed" next to a test name.

The usual cause is an Observable that errors with no error handler on the subscription.
That is sometimes deliberate — `MessageActionsService.onSend` subscribes without one
because a failed send is surfaced by the local echo's retry state, not a toast — but RxJS
still reports it through `config.onUnhandledError` and rethrows it asynchronously, where
Vitest counts it against the run.

```bash
pnpm exec nx test feature-rooms --skip-nx-cache; echo "exit=$?"
```

If a test deliberately drives such a path, capture the report rather than leaking it, and
assert it happened — the escape is part of the contract:

```ts
const previous = config.onUnhandledError;
config.onUnhandledError = (error) => unhandled.push(error);
try {
  actions.onSend({ body: 'x', mentions: [] });
  // RxJS reports on a macrotask, so the handler must stay installed across one tick.
  await new Promise((resolve) => setTimeout(resolve, 0));
} finally {
  config.onUnhandledError = previous;
}
```

## TestBed.inject of a component is not the component

`TestBed.inject(SomePage)` constructs the class through DI. It does **not** create a
component instance, and two consequences bite:

- **Lifecycle hooks never run.** Anything wired in `ngOnInit` is unwired for the whole
  spec. If a page hands a callback to a collaborator there, the collaborator holds
  `undefined` in every test — silently, if the call site is optional.
- **A component's `providers:` array is not applied.** Page-scoped services have to be
  handed to the TestBed by hand, which means they resolve from the environment injector
  instead: their `inject(DestroyRef)` is the environment's, so no such spec can observe
  teardown. To test cancellation, build a host component that provides the service and
  call `fixture.destroy()`.

To assert that a component really declares its own providers, override the template rather
than inspecting metadata — `providersResolver` is also set by `viewProviders`, so it
cannot tell the two apart:

```ts
TestBed.configureTestingModule({ providers: [RoomShellStore] });
TestBed.overrideComponent(RoomsPage, { set: { template: '', imports: [], host: {} } });
const fixture = TestBed.createComponent(RoomsPage);
// Resolves through the component's node injector, so it is NOT the root instance.
expect(fixture.debugElement.injector.get(RoomShellStore)).not.toBe(TestBed.inject(RoomShellStore));
```

Emptying the template keeps `providers:` intact while dropping every child component, so
the page constructs cheaply.

## Tests that cannot fail

Every item below is a real shape this repository has shipped. They are worth
recognising, because each one is green.

**Mocking the collaborator can make a spec structurally incapable of seeing the
bug.** `<hlm-toaster/>` renders from `@spartan-ng/brain/sonner`'s own toast store.
A service spec that mocked `ngx-sonner` passed while no toast ever rendered in the
app, because the call pushed into a store the toaster never observes — and it failed
silently, with no error anywhere. The guard is
[`trn-toast-render.spec.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/components/overlay/src/lib/toast/trn-toast-render.spec.ts),
which mounts the real toaster and asserts the string reaches
`document.body.textContent`. When the defect is "the two sides disagree about which
object they share", only driving the real objects can catch it.

**A listener attached after the event window has closed observes nothing.** The
Electron spec named "boots the shell without renderer errors" attaches
`page.on('pageerror', …)` inside the test body, but `beforeAll` already launched the
app and awaited `domcontentloaded`, and the preceding test already waited for the
login screen. The listener watches an essentially zero-length window, so a renderer
exception during startup would not fail it.

**A branch that CI never takes is a branch CI does not gate.** The Electron
`secureStore` spec branches on `store.isAvailable()`. On a developer machine with an
OS keyring it asserts the full encrypt-store-read-delete round trip. On a headless
runner with no keyring it asserts the _degradation_ contract instead. Only
`inLocalStorage === false` is asserted in both. The CI `desktop` job therefore gates
the refusal path; the round trip is proven only when a human runs `pnpm electron:e2e`
locally.

**A Helm host class assertion is a race, not a check.** Helm styles component hosts
through an asynchronous `classes()` manager built on an effect and a global
MutationObserver, so asserting on the rendered `class` string is flaky. The smoke
tests in `libs/spartan/tests` assert the `cva` functions directly instead, because
those are pure and synchronous.

**An effect that nothing flushed after the interesting moment.** The rooms shell turns
one error signal into a danger toast from a single effect. Every failure test asserted
`status.error()` held the message and stopped there, so deleting the effect outright left
the whole suite green — the error was recorded and never shown. The effect was running;
what was missing was a `TestBed.tick()` _after_ the failure. When the behaviour under test
is "the user is told", assert the toast, not the signal that feeds it.

**A guard asserted where it cannot bite.** An e2e checked that pressing Escape a second
time "does nothing" — but the drawer was already closed by then, so a handler with its
guard deleted would have called the same close on an already-closed drawer and looked
identical. The guard only becomes observable on the wide layout, where the member column
starts open. Before writing a negative assertion, name the mutation it should catch and
check that the mutation would actually change what you are asserting.

!!! tip "Mutate the method, not a line of text"

    When you verify a test by mutation, anchor the edit to the enclosing method.
    `action.pipe(takeUntilDestroyed(this.destroyRef))` appears twice in one service; a
    text-anchored replace hit the other occurrence, the suite stayed green, and a
    perfectly good teardown test looked vacuous. A mutation that does not fail is only
    evidence once you have confirmed it landed where you meant.

## Playwright: the app journeys

The spec files under `e2e/playwright/` run in Chromium against the disposable
Synapse stack.
[`e2e/playwright.config.mts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/e2e/playwright.config.mts)
spreads `nxE2EPreset(...)` and then overrides three of its values _after_ the
spread, so the preset's CI-conditional defaults do not apply.

| Setting                      | Value                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `retries: 2`                 | Unconditional, so retries are on locally too. The preset would use 0 outside CI.                                                                                                                                   |
| `workers: 2`                 | Every spec drives the same one Synapse; the default of roughly half the cores oversubscribes it and the resulting slow `/sync` is what makes sync-dependent specs flaky.                                           |
| `timeout: 120_000`           | Playwright's 30s default is too tight — a cold UI login is Rust-crypto init plus a first `/sync`, 15 to 40 seconds under load.                                                                                     |
| `trace: 'retain-on-failure'` | Deliberately not `on-first-retry`, which traces the _retry_ — for a flaky spec, the attempt that passed. On one measured CI-mode run, two specs burned 212s of 464s on failed first attempts with no trace at all. |

Because retries are unconditional, a spec that fails once and passes on the retry is
reported as _flaky_ rather than failed, which is easy to skim past locally. Pass
`--retries=0` when you want the honest first-attempt result.

After sign-in, do not use `networkidle` as a navigation readiness signal. The live
Matrix client deliberately holds a `/sync` long-poll open, so the network may never
be idle even though the destination is fully interactive. Use `domcontentloaded`,
then wait for the route or the concrete control the journey needs.

The stable signed-in destination is Account-qualified: wait for `/rooms` with a
non-empty `account` query parameter (use `waitForRooms`) before capturing a route or
opening a modal that must preserve it. Every environment imports the typed helper from
`e2e/support/app.mts`; standalone protocol features import the same contract
from `support/navigation.mjs`. A bare `/rooms` is the pre-repair spelling.

Composer sends are single-flight. A local echo can paint before the SDK send settles,
so consecutive-send journeys must enter the next draft, wait for `composer-send` to
be enabled, and only then press Enter. Likewise, message rows can be replaced by a
remote echo or receipt update while hovered; use `clickRowToolbar` or
`clickRowMenuItem` instead of splitting hover, menu-open and item-click into unrelated
steps.

### Android runs shared journeys in the installed WebView

`pnpm e2e:android` delegates to the serialized `trinity-android:e2e` Nx host target and is
deliberately separate from the Chromium suite. It builds the
production Capacitor app, installs it on a validated API 36 x86_64 emulator, and attaches
Playwright to the app's own WebView. That boundary makes native hardware Back, touch input,
Android TLS handling, and session restoration after force-stop/relaunch observable.

Every canonical spec imports the composition fixture at `e2e/fixtures.mts`. That edge
selects the browser adapter for Web or the Android adapter for the installed package;
neither environment fixture imports the other. The Android config collects the entire
canonical glob plus native-only specs, and a source-shape guard prevents new specs from
bypassing the composition boundary.
Platform adapters cover test options, native preferences and permissions, external
authentication, and a separately packaged second device while keeping one set of journey
assertions. External FCM notification delivery, encrypted-key export, and the one
compositor-panning assertion remain explicit Android skips: none is replaced with an
in-page assertion that bypasses the named native behavior.

The MSC2545 journey is a useful example of why this sharing matters. One platform-neutral helper
creates a pack room on disposable Synapse, discovers and installs one state key through Settings,
sends its sticker, and removes the account reference. Chromium proves the browser flow; collection
of its Web wrapper in the installed Android WebView additionally proves the production Capacitor
build, touch-sized install control and native renderer boundary. Electron invokes the same helper
through a custom-scheme navigation adapter. Its exact assertions and focused commands live in
[`e2e/README.md`](../../e2e/README.md#msc2545-image-pack-management).

The outer runner owns Synapse, one exact emulator serial, the APK, the Playwright Android
driver packages, and the `tcp:8448` reverse mapping. Device validation rejects a target
that already contains Playwright drivers, so their later removal is unambiguously owned by
this run. It restores only state it changed and
records screenshots, traces, logcat/crash buffers, activity state, and package diagnostics
under `dist/.playwright/android/` on failure.

The matching iOS host exposes `trinity-ios:verify` on every OS and
`trinity-ios:verify-native` on macOS. The first pins its Nx lifecycle, shared artifact,
plugins, deep-link scheme and negotiated capabilities; the second performs an unsigned
iPhone Simulator build. There is not yet a Playwright iOS WebView driver equivalent to the
Android harness, so no browser journey is claimed on Linux or CI outside a macOS/Xcode runner.

The `trinity-e2e-support` invocation binds application, Storybook and report servers to
OS-selected loopback ports before a child builds its artifact. Playwright configs only read the
validated descriptor and never own `webServer`, global setup or teardown. A running development
server therefore cannot make a suite reuse stale `www/`, and an aggregate can pass the same live
origin to browser, protocol, Android and Electron children without restarting shared resources.

Note also which build this is. The web suite runs the **development** bundle, with
optimization off, no service worker and no file replacements. A production-only
regression — the service worker, `inlineCritical`, `environment.prod.ts`, output
hashing, a budget overage — passes all 79 spec files and is caught only by
`pnpm build`, `pnpm e2e:web` or by the desktop suite.

### The production Web/PWA host contract

`pnpm e2e:web` runs the `trinity-e2e-web:production-pwa` Nx target without Docker. The support wrapper
builds the production configuration and its dynamic server exposes the exact shared `www/`
artifact. The check enters on an unknown deep link,
waits for Application Runtime to reach the login surface, verifies the manifest and crypto WASM,
then switches Chromium offline and reloads another deep link under service-worker control. This
is the executable boundary for Web startup, routing and offline shell behavior; authenticated
Matrix journeys remain in the sequential Synapse-backed suite.

### One invocation owns external resources

The registry preflights Docker and every other selected prerequisite before opening an
invocation. When Synapse is required, the owner acquires its process lock, starts the fixed-port
stack once, writes the credentials only to a mode-0600 descriptor under ignored `dist/`, and
passes that descriptor to children. Missing Docker is a failed preflight, never a green run made
of skipped authenticated specs. Child suites validate and join the live owner; their teardown is
a no-op. The outer owner performs bounded teardown and surfaces cleanup failures.

### Three race fixes the support helpers encode

[`e2e/support/app.mts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/e2e/support/app.mts)
exists mostly to stop specs re-learning the same three lessons.

- `waitForSent(row)` waits for `data-mid` to match `/^\$/`. A local echo renders with
  matrix-js-sdk's `~roomId:txnId` placeholder and the remote echo **re-creates the
  row** under the real event id, so acting before then either loses a click mid-rerender
  or targets an id the server never saw. Threading, pinning and poll votes all break
  on this.
- `clickRowToolbar(row, button)` wraps hover-then-click in `expect(...).toPass()`. The
  hover toolbar is `opacity: 0; pointer-events: none` until hovered, and Playwright's
  own click retries never re-hover, so any re-render leaves it clicking the message
  body until the step times out.
- `fillLabeledInput` uses `getByLabel(label, { exact: true })`, because the password
  field's "Show password" aria-label also matches a substring `getByLabel('Password')`
  and trips strict mode.

Throwaway accounts are registered through Synapse's admin HMAC API in
`support/account.mts`, which **imports** `REGISTRATION_SHARED_SECRET` from
`start.mjs` rather than restating it. A drifted copy fails only as an opaque
`403 M_FORBIDDEN: HMAC incorrect`.

## The disposable Synapse stack

[`e2e/support/synapse/docker-compose.yml`](../../e2e/support/synapse/docker-compose.yml)
runs four services on a `trinity-e2e` network:

| Service        | Image                               | Published on              | Role                                                                              |
| -------------- | ----------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| Synapse        | `matrixdotorg/synapse:v1.157.2`     | `127.0.0.1:8008`          | Primary homeserver, plain HTTP behind Caddy                                       |
| Remote Synapse | `matrixdotorg/synapse:v1.157.2`     | `127.0.0.1:8009`          | Independent signing key, database and server name for genuine federation journeys |
| Dex            | `ghcr.io/dexidp/dex:v2.45.1-alpine` | `127.0.0.1:5556`          | An OIDC provider with in-memory storage, for the SSO specs                        |
| Caddy          | `caddy:2.11-alpine`                 | `127.0.0.1:8448`, `:9448` | TLS, discovery, federation fronts, and an internal Open Graph page on 8080        |

TLS is not decorative. The shipped `index.html` CSP allows only `https:` and `wss:`
for `connect-src`, and matrix-js-sdk's `AutoDiscovery` fetches
`https://<domain>/.well-known/matrix/client`, so the homeserver has to be reachable
over TLS even in a throwaway harness. Caddy uses its internal self-signed CA, which
is why the Playwright config sets `ignoreHTTPSErrors: true`.

Because both the ports and the `./data` state directory are fixed, **every**
Synapse-backed entry point owns the same one stack. They must run strictly
sequentially — see the warning in [Commands](commands.md).

The room-link Playwright journey uses both Synapses. The remote service is not a mocked `via`
response: the primary validates signed federation requests through Caddy before it can preview or
join the remote room. Both generated state directories are discarded at teardown.

### What start.mjs does, and the traps it exists to close

[`start.mjs`](../../e2e/support/synapse/start.mjs)
does considerably more than `docker compose up`, and each step is there because
something failed without it.

- It **replaces** the generated `registration_shared_secret` in place. Synapse has
  emitted a random one since around v1.119, so merely appending the harness secret
  leaves the first line winning: `register_new_matrix_user` signs with one secret
  while Synapse validates against the other, and the only symptom is
  `403 HMAC incorrect`.
- It appends an idempotent extras block: registration enabled, `rc_login` and
  `rc_message` at 100/s so two near-simultaneous logins plus SAS to-device traffic
  are not throttled, and URL previews enabled with an empty IP blacklist so Synapse
  can fetch the Open Graph page for the link-preview spec.
- It rewrites the whole OIDC region on every start, because two values in it vary
  with how the stack came up: how Synapse addresses Dex, and the app origin allowed
  in `sso.client_whitelist`.
- It passes `UID` and `GID` into the container. The Synapse image runs as its
  built-in 991:991 and chowns the bind-mounted `./data` to match. Filesystems that
  remap ownership hide this entirely, which is why it goes unnoticed on macOS and
  Docker Desktop and fails every time on a plain Linux runner, where the second
  `start()` cannot rewrite `homeserver.yaml` and teardown cannot delete the directory.
- It polls Synapse's `/health`, Dex's discovery document (checking the `issuer`
  matches), Synapse's own `/login` flows for `m.login.sso`, and finally Caddy's
  well-known document.

!!! danger "A warm stack serves the previous run's config"

    A bind-mounted config file is not part of a compose *service definition*, so
    `up -d` leaves an already-running container alone and it keeps serving whatever
    it loaded at start. `start.mjs` closes this by sha256-fingerprinting all three
    mounted configs, recording which services were up **before** `up -d` — the only
    moment a created and an untouched container are distinguishable — and restarting
    exactly the stale ones. None of the readiness polls would notice otherwise: the
    only one that reads Synapse's view of the provider cannot tell one issuer from
    another, and the mismatch surfaces much later as an opaque token-exchange failure
    mid-login. Do not simplify the restart away.

### The Dex harness, and why it is legacy SSO

Dex exists so the suite can hold a Matrix account with **no password**. Synapse
creates SSO accounts through `oidc_providers`, and such an account can never satisfy
password user-interactive auth — which is the only way to drive Trinity's "your
identity provider has to do this" path against a real homeserver rather than a mock.

It is deliberately legacy SSO, where Synapse owns the session and returns a
`loginToken`, and not MSC3861 next-generation auth. Delegating authentication
outright forces password login and registration off for the whole homeserver, which
every other spec depends on, and Synapse refuses to start with both configured.
Synapse reaches Dex by compose hostname while the browser uses the published port,
so `discover: false` plus split explicit endpoints is mandatory — a discovery
document can only advertise one.

`dex.yaml` declares exactly two static identities, one per spec file, each password a
precomputed bcrypt hash fixed at container start. There is no per-test identity, so
`fullyParallel` would otherwise put both SSO specs on one shared account in different
workers. One of them, the recovery-reset spec, permanently seeds a cross-signing
master key and a key-backup version on its account and then asserts that nothing else
changed.

`support/sso.mts` drives the round trip. `ssoLoginToken()` captures an unspent token
by redirecting to an unrouted `/sso-harness-callback` under the app origin, because
Synapse refuses any URL outside `sso.client_whitelist`. `ensureCrossSigning()` exists
because Synapse skips user-interactive auth for a user's _first_ cross-signing upload
— unconditional in the pinned v1.119.0 — so a reset on a virgin account succeeds
outright and never reaches the branch under test.

## Desktop specs

`pnpm electron:e2e` delegates to the serialized, uncached `trinity-desktop:e2e` Nx target. That
target depends on `trinity-desktop:build`, whose graph begins with `trinity:build`, the
**production** Angular build. The Electron specs are the browser-driven gate on that output, which
is exactly why the desktop dark-theme regression and image-pack manager journey live here.
`pnpm electron:e2e:smoke` focuses the Docker-independent launched-shell checks.

The config sets `fullyParallel: false`, `workers: 1` and a 120s timeout, and has no
`webServer` or `baseURL`: each spec launches the process itself. The support invocation owns the
disposable Synapse stack for the full suite, while the smoke suite requests no Synapse resource;
both Playwright configs are descriptor-only joiners and own no global setup or teardown.
[`launch.mts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/e2e/electron/support/launch.mts)
resolves the Electron executable through `createRequire` against
`electron/package.json`, since the package lives in `electron/` and not at the root,
and gives every launch a fresh `mkdtemp` user-data directory so the app always boots
unauthenticated.

What the specs establish:

- The origin is `trinity://app`, not `file://`.
- `WebAssembly.compileStreaming` of `/assets/crypto/matrix_sdk_crypto_wasm_bg.wasm`
  succeeds with `Content-Type: application/wasm` and a non-empty export list. The
  strict form is the point: it rejects unless the response is streamable, correctly
  typed and from a secure context, which is exactly the set of privileges the custom
  scheme registers.
- Protocol-v1 negotiation returns explicit supported/unavailable results, the bridge exposes only
  the six grouped capability objects, and `require`, `process`, raw `ipcRenderer`, and retired flat
  methods are all absent in the renderer.
- The safeStorage round trip, or its clean refusal, with the secret never landing in
  `localStorage`.
- `.dark` on `<html>` actually beats `:root` in the real renderer.
- The full image-pack manager journey works over `trinity://app`: discovery, install,
  enable/disable, scope, sticker send, uninstall, final account-data readback, and source-state
  preservation. Same-account second-client propagation remains in the Web/Android wrapper because
  Electron enforces a single-instance lock.

The `--no-sandbox` argument in `launch.mts` is the Chromium _zygote_ flag needed to
run as root or in a container. It is explicitly not the app's
`webPreferences.sandbox`, which stays `true` and is asserted by the "no Node in the
renderer" spec.

!!! warning "Electron needs an X server even headless"

    On headless Linux or in CI, `_electron.launch()` times out with no useful
    message, which reads like a Playwright bug rather than a missing display. Wrap
    it: `xvfb-run -a pnpm electron:e2e`.

## Standalone protocol harnesses

`e2e/features/*.mjs` are raw `playwright` Node scripts rather than
`@playwright/test` specs. Each joins the invocation owner's dynamically allocated
application endpoint and drives Chromium or WebKit, parameterised by `TRINITY_HS`,
`TRINITY_USER` and `TRINITY_PASS` so it can run against any homeserver. They print
`RESULT: PASS` or `RESULT: FAIL` and exit accordingly, and `HEADED=1` plus
`SLOWMO=<ms>` make them watchable. The nine Synapse-backed ones have a thin runner
under `e2e/runners/` that starts the stack, spawns the body, and stops the stack in a
`finally`. The compatibility files do not own servers, ports, locks, or Synapse.

`verify-sas.mjs` is the deepest of them: two browser contexts in one Chromium are two
devices of the same Matrix user, because isolated IndexedDB means two crypto stores
and therefore two device ids. It synchronises off a live `data-stage` attribute with
`waitForFunction` and no fixed sleeps, asserts the seven emoji match across both
contexts, and deliberately observes the half-confirmed window that only a two-device
run can see.

`verify-qr.mjs` uses the same two-client setup but supplies Device B with a
canvas-backed synthetic camera stream containing Device A's rendered QR image. This
keeps physical hardware out of CI while exercising the production encoder, camera
scanner, raw-byte decoder, Matrix reciprocation, and completion on both clients.

## Electron main-process specs

`electron/vitest.config.mts` is three lines: `environment: 'node'` and
`include: ['src/**/*.spec.ts']`. The specs mock the `electron` module wholesale with
`vi.mock` plus `vi.hoisted` handler maps, so IPC channels can be driven directly.
Eleven files cover the CORS shim and its IPC surface, the dock badge, secure storage,
notification payloads, deep links, geolocation, the custom scheme, window creation,
the packaging hook and startup. `main.spec.ts` captures the
`app.whenReady().then(cb)` callback so startup can be driven deterministically
instead of racing microtasks.

These are part of `pnpm test` through `trinity-desktop:test`. The separate `desktop` CI job remains
because it also compiles the shell, downloads and launches the real Electron binary, and exercises
the custom scheme and sandbox under Xvfb.

## After a Playwright version bump, reinstall the browsers

```bash
pnpm exec playwright install chromium webkit
```

This is not a one-off per clone. Each Playwright release pins its own browser build,
so a bumped runner against old binaries fails every browser test at launch with
`Executable doesn't exist at .../chromium_headless_shell-<n>` — which reads like a
catastrophic regression rather than a missing download. The 1.61 to 1.62 bump did
exactly this. WebKit covers the Storybook icon-motion contract and `pnpm spike:webkit`. CI is immune because it
keys its browser cache on the lockfile hash, so a moved lockfile necessarily misses.

## What none of this proves

The release pipeline runs no browser or Electron end-to-end test at all — see
[CI and releases](ci-and-releases.md) for what does gate a tag, and for the
repository-level invariant specs that guard configuration a green run cannot see.

## Production-renderer responsive checks and pull-request proof

The visual lifecycle provides a separate real-application semantic and geometry gate:

```bash
pnpm exec nx run trinity-e2e-components:production-renderer
```

It creates and records a production build, then drives seven representative cross-cutting
viewport/device profiles against disposable Synapse, including genuine WebKit plus full Pixel 5
and 320x568 mobile descriptors rather than resized desktop Chromium. The suite checks geometry,
horizontal overflow, rendered contrast, focus, accessible names, unread content, safe encryption
setup and the production reduced-motion contract with Trinity's production typography. See
[`e2e/components/production-renderer/README.md`](../../e2e/components/production-renderer/README.md)
for the matrix.

Visual proof is a review artifact, not source. Capture screenshots and GIFs under ignored
Playwright output or another temporary directory, upload them directly to the pull request, then
discard the local copies. Never commit prototypes, proof media or pixel baselines. Failure-only
screenshots, traces and videos remain useful diagnostics, but they stay in ignored local output or
short-lived CI artifacts.

For cross-platform rollout evidence, the production-renderer target builds `www/` once and hashes it
before either wrapper copies it:

```bash
pnpm exec nx run trinity-e2e-components:production-renderer
pnpm electron:build:prebuilt
TRINITY_E2E_PREBUILT_WWW=1 pnpm e2e:android -- --grep @renderer-smoke
pnpm bundle:manifest:verify
```

The verifier requires an exact byte-for-byte file set in `electron/www` and the Capacitor asset
tree. Android may add only `cordova.js` and `cordova_plugins.js`; any other unrecorded file fails the
gate. To rerun only the web evidence without rebuilding, set `TRINITY_E2E_PREBUILT_WWW=1`; the runner
first verifies `www/` against the recorded manifest.

## The styling blind spot, and what closes it

Three separate blocking bugs in the redesign phases were invisible to a completely green
suite, for one reason: **nothing asserted appearance or layout.** jsdom applies no CSS, so no
unit test can see a styling bug at all; and the Playwright specs are written as user journeys
that assert `data-testid` and text, which is exactly the part that stays correct when styling
breaks.

The three, and what each needed:

| Bug                                                                                                   | Why nothing caught it                                             | What catches it now                             |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| Extracting the timeline dividers left their CSS behind, so both rendered unstyled                     | The markup, testids and text were all still correct               | `scripts/component-styling.spec.mjs` — static   |
| A `background:` shorthand reset the `background-size` positioning the blurhash, tiling it as a mosaic | The end-to-end test asserted the image URL, which was never wrong | `scripts/shorthand-overrides.spec.mjs` — static |
| A delayed loading strip outlived the prepend it accompanied, moving the reader's content              | No test related the strip's lifetime to the scroll restore        | A targeted invariant test — see below           |

**Two of the three are decidable from the source**, and are now build failures. Both were
validated by running them against the revisions that shipped the bugs: each reports the exact
defect there and nothing on a fixed tree. That is the bar for a guard like this — a check
that has never been shown to fail against a real bug is a check nobody should trust.

**The third is not automatable**, and pretending otherwise would be worse than admitting it.
A relationship between _when_ something is removed and _when_ something else is measured is
semantic. What replaces the linter is a habit:

> When a change alters **when** a piece of UI appears or disappears, and anything measures
> layout, the test is the relationship — not the appearance.

Concretely: assert with no timer advance at all after the triggering state clears, because
anything that needs one is by definition still on screen when the dependent measurement runs.

### The guard suite

The two named above are not a pair. Cross-project specs under `scripts/` read the app's source or
resolved workspace metadata, which is the only way to check something that spans libraries — the Nx boundaries stop
any single project from importing them all. They sit alongside the older repository
invariants in the same project (`lint-invariants`, `host-directives`, `stack-versions`), which
are covered in [CI and releases](ci-and-releases.md).

| Spec                             | What it refuses to let through                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `architecture-contract.spec.mjs` | Unclassified projects, new dependency exceptions, implicit entrypoints, cycles, source-counter drift, or a stale generated map |
| `boot-splash.spec.mjs`           | A splash outside `<trn-root>`, one that needs a script, or colours drifted from the tokens                                     |
| `component-styling.spec.mjs`     | A class styled in one component and rendered only by another                                                                   |
| `contrast-matrix.spec.mjs`       | A text role below WCAG AA on a surface it can land on, in any palette × mode                                                   |
| `message-list-bindings.spec.mjs` | The windowed and simple message lists drifting apart on the bindings they share                                                |
| `scroll-behaviour.spec.mjs`      | A programmatic scroll that hard-codes `behavior: 'smooth'`, which no stylesheet can undo                                       |
| `scrollbar-style.spec.mjs`       | Visible scrollbar paint outside the global token contract, or a drifting hidden exception                                      |
| `shorthand-overrides.spec.mjs`   | A shorthand silently re-initialising a longhand an earlier rule set                                                            |
| `styling-idiom.spec.mjs`         | A new component stylesheet, or one orphaned when its `styleUrl` went away                                                      |
| `styling-tokens.spec.mjs`        | A hand-picked z-index or duration where the scale has a token                                                                  |
| `token-resolve.spec.mjs`         | A `var(--trinity-…)` nothing defines — an invalid declaration the browser drops                                                |

They are ordinary Vitest specs, so `pnpm test` runs them with everything else. On their own:

```bash
pnpm exec nx test scripts
pnpm exec nx test scripts -- token-resolve   # one of them, by path substring
```

That target lists its cache inputs by hand in `scripts/project.json`, and it has to. The specs
read `apps/` and `libs/`, which are outside their own project, and `scripts` has no dependency
edges — so under the default inputs nothing they actually open was part of the cache key, and
every run after the first replayed a pass for a tree it had never seen. A new guard that reads
a kind of file none of those globs cover needs its glob added, or it will go quiet in exactly
the same way.

### Writing an appearance assertion

Reach for a real browser and read computed style. It is the only place these are visible:

```ts
const styling = await el.evaluate((node) => ({
  display: getComputedStyle(node).display,
  ruleFlexGrow: getComputedStyle(node, '::before').flexGrow,
}));
expect(styling).toEqual({ display: 'flex', ruleFlexGrow: '1' });
```

Prefer a property that is _generated_ by the rule you care about — a `::before` that only
exists because a stylesheet reached the element is a sharper probe than a colour, which can
be inherited from somewhere else and look right by accident.

### Sweeps that read source

Several guards here read source text. Two rules, both learned the hard way:

- **Strip comments first.** A guard's own explanation quotes the thing it forbids, and more
  than one sweep in this repo has reported its own prose as a violation.
- **Prove the sweep found something.** Every one of these carries a non-vacuity assertion,
  because the failure mode is not a false alarm — it is going quiet.
