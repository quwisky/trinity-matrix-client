# Testing

A change is proven here by four independent layers. None of them subsumes another,
and each one exists because the layer below it is blind to a specific class of
failure.

| Layer                       | Command                           | Proves                                                                                   |
| --------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| Vitest unit specs           | `pnpm test`                       | Component and service behaviour, in jsdom, against mocked collaborators                  |
| Electron main-process specs | `pnpm -C electron test`           | The desktop shell's Node-side logic, with the `electron` module mocked wholesale         |
| Playwright journeys         | `pnpm exec nx e2e trinity-e2e`    | Real UI flows in Chromium against a real Synapse homeserver, on a **development** build  |
| Desktop and protocol runs   | `pnpm electron:e2e`, `pnpm e2e:*` | The real Electron binary on a **production** build, and per-feature protocol round trips |

Invocation details for all of these — argument forwarding, the harness table, which
ones need Docker — are in [Commands](commands.md). This page is about what each
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

`apps/trinity/src/main.ts` provides `provideZonelessChangeDetection()`, the
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

## Specs are type-checked by nothing

Each project has a `tsconfig.spec.json`, and **no target ever invokes `tsc` on it**.
Vitest goes through the Analog plugin and esbuild, which transpiles without type
checking. `pnpm build` uses the `production` named input, which excludes
`**/*.spec.ts`. The one type-aware ESLint rule explicitly ignores `**/*.spec.ts`,
because specs live in a tsconfig each project's own `tsconfig.json` excludes, so the
project service finds no program for them.

The same hole exists in the desktop package — `electron/tsconfig.json` excludes
`src/**/*.spec.ts`, so `pnpm -C electron run compile` never sees them — and `e2e/**`
is worse still: it sits in ESLint's global ignores, runs through Node's
type-stripping loader, and is touched only by Prettier.

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
[`trn-toast-render.spec.ts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/libs/spartan/overlay/src/lib/toast/trn-toast-render.spec.ts),
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
tests in `libs/spartan/overlay` assert the `cva` functions directly instead, because
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

79 spec files under `e2e/playwright/`, Chromium only, driven against the disposable
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

The `webServer` runs `nx run trinity:build:development` and then serves `www/`
statically on port 4200, with `reuseExistingServer` on whenever `CI` is unset. That
last part has a sharp edge: `pnpm start` uses the same port, so if a dev server is
running, Playwright skips the whole `webServer` command, the build never runs, and
the suite silently tests whatever `www/` happens to contain. Kill the dev server
first, or set `PORT`/`BASE_URL`.

Note also which build this is. The web suite runs the **development** bundle, with
optimization off, no service worker and no file replacements. A production-only
regression — the service worker, `inlineCritical`, `environment.prod.ts`, output
hashing, a budget overage — passes all 79 spec files and is caught only by
`pnpm build` or by the desktop suite.

### Global setup turns its own graceful degradation off in CI

[`global-setup.mts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/e2e/playwright/support/global-setup.mts)
brings the stack up and writes credentials to `.synapse-session.json`. Every
authenticated spec reads that at module load and calls
`test.skip(!session.available, …)`.

Locally, a missing Docker records `available: false` and those specs skip. Under
`CI` the failure is rethrown instead, because almost every spec is authenticated and
a runner that cannot reach Docker would otherwise report a green E2E job that tested
next to nothing. `TRINITY_E2E_ALLOW_NO_SYNAPSE=1` opts back out. This is why the CI
job needs no extra environment variable to be strict.

### Three race fixes the support helpers encode

[`e2e/playwright/support/app.mts`](https://github.com/quwisky/trinity-matrix-client/blob/develop/e2e/playwright/support/app.mts)
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

[`e2e/synapse/docker-compose.yml`](https://github.com/quwisky/trinity-matrix-client/blob/develop/e2e/synapse/docker-compose.yml)
runs three containers on a `trinity-e2e` network:

| Container | Image                               | Published on     | Role                                                                        |
| --------- | ----------------------------------- | ---------------- | --------------------------------------------------------------------------- |
| Synapse   | `matrixdotorg/synapse:v1.119.0`     | `127.0.0.1:8008` | The homeserver, plain HTTP behind Caddy                                     |
| Dex       | `ghcr.io/dexidp/dex:v2.45.1-alpine` | `127.0.0.1:5556` | An OIDC provider with in-memory storage, for the SSO specs                  |
| Caddy     | `caddy:2.8-alpine`                  | `127.0.0.1:8448` | TLS termination, the `.well-known` document, and an Open Graph page on 8080 |

TLS is not decorative. The shipped `index.html` CSP allows only `https:` and `wss:`
for `connect-src`, and matrix-js-sdk's `AutoDiscovery` fetches
`https://<domain>/.well-known/matrix/client`, so the homeserver has to be reachable
over TLS even in a throwaway harness. Caddy uses its internal self-signed CA, which
is why the Playwright config sets `ignoreHTTPSErrors: true`.

Because both the ports and the `./data` state directory are fixed, **every**
Synapse-backed entry point owns the same one stack. They must run strictly
sequentially — see the warning in [Commands](commands.md).

### What start.mjs does, and the traps it exists to close

[`start.mjs`](https://github.com/quwisky/trinity-matrix-client/blob/develop/e2e/synapse/start.mjs)
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

`pnpm electron:e2e` is not an Nx target. It runs `pnpm run electron:build` and then
`playwright test -c e2e/playwright.electron.config.mts`. The build chain begins with
`pnpm build`, the **production** Angular build, which makes the seven tests in
`e2e/electron/app.electron.spec.mts` the only browser-driven gate on production
output — and is exactly why the desktop dark-theme regression test lives here.

The config sets `fullyParallel: false`, `workers: 1` and a 60s timeout, and has no
`webServer` or `baseURL`: each spec launches the process itself.
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
- `trinityDesktop.isElectron === true` while `require` and `process` are both
  `undefined` in the renderer, with the deep-link, notification and secure-store
  members present.
- The safeStorage round trip, or its clean refusal, with the secret never landing in
  `localStorage`.
- `.dark` on `<html>` actually beats `:root` in the real renderer.

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
`@playwright/test` specs. Each serves `www/` on its own dedicated port through a
small static server and drives Chromium or WebKit, parameterised by `TRINITY_HS`,
`TRINITY_USER` and `TRINITY_PASS` so it can run against any homeserver. They print
`RESULT: PASS` or `RESULT: FAIL` and exit accordingly, and `HEADED=1` plus
`SLOWMO=<ms>` make them watchable. The eight Synapse-backed ones have a thin runner
under `e2e/runners/` that starts the stack, spawns the body, and stops the stack in a
`finally`.

`verify-sas.mjs` is the deepest of them: two browser contexts in one Chromium are two
devices of the same Matrix user, because isolated IndexedDB means two crypto stores
and therefore two device ids. It synchronises off a live `data-stage` attribute with
`waitForFunction` and no fixed sleeps, asserts the seven emoji match across both
contexts, and deliberately observes the half-confirmed window that only a two-device
run can see.

## Electron main-process specs

`electron/vitest.config.mts` is three lines: `environment: 'node'` and
`include: ['src/**/*.spec.ts']`. The specs mock the `electron` module wholesale with
`vi.mock` plus `vi.hoisted` handler maps, so IPC channels can be driven directly.
Eleven files cover the CORS shim and its IPC surface, the dock badge, secure storage,
notification payloads, deep links, geolocation, the custom scheme, window creation,
the packaging hook and startup. `main.spec.ts` captures the
`app.whenReady().then(cb)` callback so startup can be driven deterministically
instead of racing microtasks.

These are not part of `pnpm test`. The `trinity-desktop` Nx project exposes only a
`lint` target, which is why CI has a separate `desktop` job.

## After a Playwright version bump, reinstall the browsers

```bash
pnpm exec playwright install chromium webkit
```

This is not a one-off per clone. Each Playwright release pins its own browser build,
so a bumped runner against old binaries fails every browser test at launch with
`Executable doesn't exist at .../chromium_headless_shell-<n>` — which reads like a
catastrophic regression rather than a missing download. The 1.61 to 1.62 bump did
exactly this. WebKit is needed only for `pnpm spike:webkit`. CI is immune because it
keys its browser cache on the lockfile hash, so a moved lockfile necessarily misses.

## What none of this proves

The release pipeline runs no browser or Electron end-to-end test at all — see
[CI and releases](ci-and-releases.md) for what does gate a tag, and for the
repository-level invariant specs that guard configuration a green run cannot see.
