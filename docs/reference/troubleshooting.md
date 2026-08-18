# Troubleshooting

An index of failures this codebase actually produces, grouped by where you hit them. Each
entry states the symptom first, because that is what you have when you arrive here.

Most of these are not bugs. They are consequences of a real constraint, and the entry
explains the constraint so the fix stops looking arbitrary.

## Build and tooling

### pnpm test fails in the scripts project with ENOENT or a floor assertion

**Symptom.** `nx run-many -t test` fails in `scripts` before any test runs, with
`ENOENT ... docs/reference/stack.md`, or with `expected 0 to be greater than or equal to 10`.

**Cause.** `scripts/stack-versions.spec.mjs` reads
[the stack reference](stack.md) at module scope and parses its version table. Moving the
file, dropping the table, or restyling the version column so it is no longer a bare
`1.2.3` all break it.

**Fix.** Keep the table, or update the path and the row regex in the spec in the same
commit. Do not delete the spec: the drift it prevents is real and recurring.

### An edit to the version table does not fail the test locally

**Symptom.** You put a wrong version in the stack table, run `pnpm test`, and it passes.
Or you bump a dependency and the table is never re-checked.

**Cause.** The `scripts` project's `test` target inherits Nx's `default` inputs, which are
`{projectRoot}/**/*` plus `sharedGlobals`. `docs/`, `package.json` and `pnpm-lock.yaml`
are all outside that set, and `node_modules/*/package.json` is read at runtime where Nx
never sees it. The cache key only moves when a file under `scripts/` changes.

**Fix.** `pnpm exec nx test scripts --skip-nx-cache`. CI is unaffected — its runners are
always cold, because the setup action deliberately caches nothing for Nx.

### The Electron compile fails with TS5107 on `moduleResolution`

**Symptom.** `pnpm -C electron run compile` errors with
`Option 'moduleResolution=node10' is deprecated`.

**Cause.** `electron/tsconfig.json` is back on `"moduleResolution": "Node"`. TypeScript 6
rejects node10 resolution outright, and the shell is on the same TypeScript as the root
workspace, so there is no older compiler to fall back on.

**Fix.** The shell needs the Node16 pair — `"module": "Node16"` with
`"moduleResolution": "Node16"`, which emits byte-identical CommonJS for this package:

```bash
cd electron && ./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

This most often arrives through `nx migrate`: `@nx/js`'s codemods glob every
`tsconfig*.json` in the repo, `electron/tsconfig.json` included. Check that file in the
diff of any migration.

### A native build points at a pnpm path that does not exist

**Symptom.** `pnpm android:build` or opening Xcode fails with "No such file or directory"
naming a path like `node_modules/.pnpm/@capacitor+android@8.4.1_@capacitor+core@8.4.1/…`.

**Cause.** `cap sync` writes absolute plugin paths into `android/capacitor.settings.gradle`
and `ios/App/CapApp-SPM/Package.swift`, and under pnpm those paths embed the exact resolved
version and its peer hash. Any Capacitor version bump invalidates them.

**Fix.** Run `pnpm android:sync` and `pnpm ios:sync` after any Capacitor dependency change
and commit the regenerated files. The dependency bot ignores `android/**` and `ios/**`, so
its Capacitor group PR will never do this for you.

### Every browser test fails at launch after a Playwright bump

**Symptom.** Nearly every spec fails with `Executable doesn't exist at
.../chromium_headless_shell-<n>`. It reads like a catastrophic regression rather than a
missing download. The 1.61 to 1.62 bump failed 165 of 167 specs this way.

**Cause.** Each Playwright release pins its own browser build.

**Fix.** `pnpm exec playwright install chromium webkit` after every bump, not once per
clone. CI is immune only because its browser cache is keyed on `pnpm-lock.yaml`, so a moved
lockfile necessarily misses.

### pnpm build produced a minified, hashed, service-worker build

**Symptom.** Unexpected minification, hashed filenames, an `ngsw` manifest and no source
maps. Or `pnpm electron:e2e` taking far longer than expected.

**Cause.** `apps/trinity/project.json` sets `defaultConfiguration: "production"`, so a bare
`nx build trinity` is a production build — and `electron:build`, `electron:e2e`,
`android:sync`, `ios:sync` and everything downstream all call `pnpm run build`.

**Fix.** Pass `--configuration=development` when you want a dev build. The spike and
Synapse e2e scripts already do. This is also why production-only regressions are only
reachable through the desktop path.

### nx test cannot find the project you named

**Symptom.** `Cannot find project 'core'`, or `Cannot find project 'data-access/rooms'`.

**Cause.** Two different mistakes produce the same message. `@trinity/core` was dissolved
into per-domain libraries, so no project called `core` exists. And for every library nested
under `libs/data-access/`, `libs/feature/` and `libs/util/`, the Nx project name, the
directory and the import alias are three different strings: the project `data-access-rooms`
lives in `libs/data-access/rooms` and is imported from `@trinity/data-access/rooms`. Only
the hyphenated form names a task, so a directory or an alias pasted into an `nx` command
never resolves.

**Fix.** Use the hyphenated project name — `pnpm exec nx show projects` lists them all. The
`test` target is `nx:run-commands` running `vitest run` with `cwd` set to the project, so
Vitest arguments come after `--`:

```bash
pnpm exec nx test util-matrix -- message-view
pnpm exec nx test feature-rooms --configuration=watch
```

See [commands](../contributing/commands.md).

### Moving a library breaks its test suite with every config file correct

**Symptom.** After relocating a library, every spec in it fails before a single test runs,
with `Failed to resolve import "../../../test-setup.base" from "src/test-setup.ts"`.

**Cause.** `project.json`, `tsconfig.json`, `tsconfig.spec.json` and `vite.config.ts` are
the files you go looking for, and they are easy to correct. `src/test-setup.ts` also reaches
the workspace root by relative path, and nothing in the config layer names it by depth, so
it is invisible from there. The whole file is one line:

```ts
import '../../../../test-setup.base';
```

What makes it easy to overlook is that the neighbouring config genuinely is
depth-independent. `vite.base.config.ts` derives the workspace root by walking up to the
directory holding `nx.json`, and its docblock says so, so a `vite.config.ts` that moved a
level deeper keeps working. The setup file it points at does not: a library directly under
`libs/` needs three `../` segments, one nested a level deeper needs four.

**Fix.** After moving a library, grep it for relative specifiers that climb out of it and
re-check each one against the new depth:

```bash
grep -rn "'\.\./\.\./" libs/data-access/rooms
```

That surfaces both root-relative imports the library template carries: `vite.config.ts`
reaching `../../../vite.base.config`, and `src/test-setup.ts` reaching
`../../../../test-setup.base`.

### A library move can silently weaken module boundaries

**Symptom.** None at all. `pnpm lint` stays green.

**Cause.** `@nx/enforce-module-boundaries` reports a violation only for an import it can
resolve to a project in the Nx graph. If a renamed specifier stops resolving, the rule does
not fail — it has nothing to say about that import, and silence is exactly what a compliant
codebase looks like. A passing lint is therefore not evidence that the rule still applies.
`scripts/lint-invariants.spec.mjs` does not close the gap either: it asserts the rule is
configured at severity 2, which is a weaker claim than the rule still matching anything.

**Fix.** Prove it with a positive control. Add an import the tags forbid, confirm lint
fails, then revert:

```bash
echo "import type { RoomsService } from '@trinity/data-access/rooms';" >> libs/components/icon/src/index.ts
pnpm exec nx lint components-icon --skip-nx-cache   # must fail
git checkout -- libs/components/icon/src/index.ts
```

`libs/components/icon` is tagged `type:ui` and `scope:shared`, while `data-access-rooms` is
`type:data-access` and `scope:matrix`, so both axes are violated. The scope one is what gets
reported:

```text
A project tagged with "scope:shared" can only depend on libs tagged with "scope:shared"
```

An unused-variable error rides along with it; the boundary error is the one that matters.

### A broken import in an e2e spec survives lint

**Symptom.** An unused symbol or a wrong import in an `.mts` Playwright spec passes
`pnpm lint` and only fails when the suite runs.

**Cause.** `eslint.config.mjs` lists `e2e` in `globalIgnores`, alongside `android`, `ios`,
`**/www`, `**/dist` and `**/release`. Those specs are also not covered by any `tsc`
invocation in the repo.

**Fix.** Verify edits to `e2e/**` by running the suite, or with an explicit `tsc --noEmit`
against them.

## Tests

### The Playwright web suite tested code you did not build

**Symptom.** `nx e2e trinity-e2e` asserts on stale UI, or passes against an uncommitted
hot-reloaded change.

**Cause.** The config sets `reuseExistingServer: !process.env['CI']` with
`url: http://localhost:4200`, and the static server defaults to the same port `pnpm start`
uses. When anything answers on 4200, Playwright skips the entire `webServer.command`, so
`nx run trinity:build:development` never runs and `www/` is never refreshed.

**Fix.** Kill the dev server before running the suite, or set `PORT` and `BASE_URL`. CI is
safe because the flag is false there.

### A spec passes locally and fails in CI, reported as flaky

**Symptom.** Playwright's summary says "flaky" rather than "failed", which is easy to skim
past.

**Cause.** `playwright.config.mts` sets an unconditional `retries: 2` after spreading the
Nx preset, so local runs retry too. Workers are likewise forced to 2 everywhere, on purpose:
every spec drives one shared disposable Synapse and the default worker count oversubscribes
it.

**Fix.** Run with `--retries=0` when you want the honest first-attempt result, and read the
flaky count in the summary rather than only the pass or fail line.

### A different test fails each run, and the totals do not add up

**Symptom.** One project's suite fails on a different test every run, and the summary reads
something like `Tests 42 passed (49)` — seven tests that simply never executed. Sometimes an
`Unhandled Errors` block appears with `[vitest-pool]: Worker forks emitted error` and
`emitUnexpectedExit`.

**Cause.** The worker fork was killed by the OS, not by a failing assertion. The `Killed`
line goes to the fork's own stderr and never reaches the log, which is why this does not look
like an OOM.

What drives peak RSS is **which component the file mounts, not how many tests it has**.
Measured across `feature-rooms`:

| Spec                         | Tests | Peak RSS |
| ---------------------------- | ----- | -------- |
| `message-composer.component` | 116   | 973 MB   |
| `channel-sidebar.component`  | 85    | 931 MB   |
| `edit-history.component`     | 24    | 960 MB   |
| `rooms.page.actions`         | 46    | 1246 MB  |

A 24-test file costs as much as a 116-test one: roughly 950 MB is a fixed floor for the module
graph, jsdom and Angular. Files that mount `RoomsPage` sit ~300 MB above it because of the
service graph they wire up, and those cross the line first. Per-test retention is real — no
`afterEach` reclaims it, and `vi.clearAllMocks()`, `ngMocks.reset()` and
`TestBed.resetTestingModule()` all leave the curve unchanged — but at these file sizes it is
second-order next to the floor.

**Fix.** Measure, do not guess: `/usr/bin/time -f %M pnpm exec vitest run <file>
--maxWorkers=1` prints peak RSS in KB. Split only files measurably above the floor, at a
`describe` boundary, and re-measure — a green run on a quiet machine proves nothing. Splitting
a file already at the floor buys nothing, so test count alone is not a reason to split.

At the floor there is no repo-side fix left: one spec file needs ~1 GB, so the suite needs
memory more than it needs tuning. Run `--parallel=1 -- --maxWorkers=1`, and do not run `lint`
alongside it — its type-aware rules are themselves memory-hungry.

**Confirming it is the machine and not your change.** `git diff <base>...HEAD --name-only |
grep <project>` to show the project is untouched, then repeat the run two or three times: a
genuine regression fails the same test every time, starvation picks a different one. Do not
reach for `git worktree` to test the base commit — Nx runs a dependency check that tries to
purge a symlinked `node_modules` and aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.

### The e2e web server dies with a Go stack trace

**Symptom.** `nx e2e trinity-e2e` fails before any test runs, with
`Error: Process from config.webServer was not able to start`, and the `[WebServer]` output
carries `fatal error: all goroutines are asleep - deadlock!` and a Go stack through
`esbuild/internal/bundler`. A plain `pnpm build` succeeds moments earlier.

**Cause.** Memory pressure, not a build error. The webServer builds `trinity:build:development`
in a second process while Playwright, Chromium and the Synapse containers are already resident;
esbuild's Go runtime deadlocks rather than reporting an allocation failure. Below roughly
2.3 GB available it reproduces reliably; at ~2.9 GB it does not.

**Fix.** Free memory and re-run — stop the Nx daemon (`pnpm exec nx daemon --stop`) and close
anything large. There is deliberately no repo-side workaround: capping esbuild's parallelism
in the config would slow every build to accommodate one constrained machine.

### A negative assertion in a projection spec proves nothing

**Symptom.** `expect(rebuildSpy).not.toHaveBeenCalled()` passes green, and the rebuild it
was supposed to rule out happens one microtask later.

**Cause.** `coalesce()` queues rebuilds with `queueMicrotask`, so nothing has run yet when
the assertion executes.

**Fix.** Flush the turn first with `await Promise.resolve()`. Without it, every negative
listener assertion in a projection spec is vacuous. See
[state and reactivity](../architecture/state-and-reactivity.md).

### NG0950 during a component spec's first change detection

**Symptom.** "Input is required but no value is available yet", or stale reads in an
otherwise correct test.

**Cause.** The app is zoneless. Angular Testing Library's zoneless `render()` binds only
through Angular's native `bindings` API and silently ignores the `inputs` and `on` options.
Switching to `bindings`/`inputBinding` is not a workaround either — a later
`componentRef.setInput` then triggers NG0317.

**Fix.** `import { render } from '@trinity/testing'`. The wrapper renders with
`skipDetectChanges`, applies `inputs` via `setInput`, wires `on` handlers, then detects.

### Cannot synchronously execute watches while scheduling

**Symptom.** That error in a timing test that stubs `requestAnimationFrame` to fire inline.

**Cause.** `render()` attaches the component to `ApplicationRef`, so a signal write from
inside a synchronous rAF callback re-enters the zoneless scheduler mid-tick.

**Fix.** Use a detached `TestBed.createComponent(...)` fixture, which only ticks on the
spec's own `detectChanges()`. The pattern is create, `componentRef.setInput(...)`,
`detectChanges()` — that first pass resolves the scroll viewchild — then subscribe to
outputs and drive further inputs. Put the rAF stub in `beforeEach` with
`vi.unstubAllGlobals()` in `afterEach`.

### A tooltip spec fails exactly like the bug it was written to catch

**Symptom.** `fireEvent.pointerEnter(el)` produces no tooltip.

**Cause.** jsdom has shipped `PointerEvent` since v27, but with the spec defaults
(`pointerType: ''`, `isPrimary: false`), and Brain's tooltip opens only for a `pointerType`
of `mouse` or `pen`. The shim in `test-setup.base.ts` is not a missing-feature polyfill; it
survives for its **defaults**.

**Fix.** Name `pointerType` explicitly at the call site, and do not delete the shim.
Separately, pointer _capture_ is still entirely absent in jsdom 30 — stub
`setPointerCapture`, `hasPointerCapture` and `releasePointerCapture` per-spec for sonner,
drawer and slider swipe paths.

### Two green suites and a shipped defect

**Symptom.** A unit spec mocks a collaborator and passes; nothing works in the app. The
recorded instance: the toast service spec mocked its sonner dependency and passed while no
toast ever rendered.

**Cause.** When the defect is "the two sides disagree about which object they share", a
mocked spec is structurally incapable of seeing it.

**Fix.** Add a spec that mounts the real objects and asserts the observable outcome — for
toasts, mounting the real toaster and asserting the string reaches
`document.body.textContent`. Note it needs a settle of `ApplicationRef.tick()`, then
`await Promise.resolve()`, then `tick()` under zoneless.

### pnpm test passes but the desktop CI job fails

**Symptom.** A change to `electron/src/*.ts` is green locally and red in CI.

**Cause.** The inferred Nx project `trinity-desktop` exposes only a `lint` target — its
package.json `test` script is not surfaced as an Nx target — so `nx run-many -t test`
skips it.

**Fix.** Run them explicitly with `pnpm -C electron test`.

### The Electron e2e suite times out with no useful message

**Symptom.** `_electron.launch()` times out. It reads as a Playwright bug.

**Cause.** Electron needs an X server even when running headless.

**Fix.** `xvfb-run -a pnpm electron:e2e` on any headless machine. The separate
`--no-sandbox` flag in the launcher is Chromium's zygote sandbox, required to run as root
or in a container; it is **not** the app's `webPreferences.sandbox`, which stays `true` and
is asserted by the "no Node in the renderer" spec.

### SSO logins fail against the disposable Synapse after an earlier harness run

**Symptom.** The token exchange fails with nothing useful in the logs, even though the
start script just rewrote `homeserver.yaml`.

**Cause.** A bind-mounted config file is not part of a compose service definition, so
`up -d` leaves an already-running container alone and it keeps serving what it loaded at
start.

**Fix.** Nothing — the start script already handles it by fingerprinting the mounted
configs and restarting exactly the stale services. Do not "simplify" that restart away.
None of the readiness polls would catch its absence.

### register_new_matrix_user fails with HMAC incorrect

**Symptom.** `403 M_FORBIDDEN: HMAC incorrect` during harness startup or from a spec's
`registerUser()`.

**Cause.** Since roughly v1.119, Synapse's `generate` writes a random
`registration_shared_secret` into `homeserver.yaml`. Appending yours below it leaves the
first line winning, so the tool signs with one secret and Synapse validates against
another.

**Fix.** The start script replaces the line in place and only appends when none exists.
Never restate the secret anywhere else — the account helper imports it from the start
script precisely because a drifted copy fails as the same opaque 403.

## Electron and native

### Desktop packaging dies at codesign with a missing arm64 path

**Symptom.** On an Intel Mac, `pnpm electron:package:mac` builds the `.app` and then fails
on `release/mac-arm64/Trinity.app: No such file or directory`.

**Cause.** The script hardcodes the arm64 output directory; electron-builder writes x64
output to `release/mac/`.

**Fix.** Fix the path or re-sign by hand for a local x64 build. CI sidesteps it by invoking
`electron-builder --mac` directly on an Apple Silicon runner.

### codesign command not found in CI

**Symptom.** An Electron step fails on Linux or Windows.

**Cause.** `electron:build` ends with `electron:sign:dev`, which ad-hoc-signs the dev
binary against a local self-signed identity. It self-skips off macOS now, but it did not
always, and while it called `codesign` unconditionally it killed `electron:start`,
`electron:e2e` and every `package:*` on Linux and Windows.

**Fix.** Never use `electron:build` or `electron:package:*` in CI. Run the three useful
steps directly: `pnpm build`, then `pnpm -C electron install --frozen-lockfile`, then
`pnpm -C electron run build`.

### Secure storage refuses to work on a Linux box

**Symptom.** The desktop shell reports secure storage as unavailable and falls back to
plaintext, even though Electron says encryption is available.

**Cause.** With no OS password manager, Electron falls back to the `basic_text` backend,
which "encrypts" with a hardcoded key. That is obfuscation, not encryption: anything
running as the user recovers the Matrix access token. `secureStorageUsable()` therefore
also checks `getSelectedStorageBackend()` and refuses `basic_text` and `unknown`.

**Fix.** Install and unlock a keyring, or accept the documented plaintext fallback, which
at least emits a warning instead of storing a secret under a false promise.

### Desktop notifications never appear on macOS

**Symptom.** Nothing displays, silently.

**Cause.** Electron posts through macOS `UNUserNotification`, which requires a stable code
signature. An unsigned or ad-hoc-signed build fails with `UNErrorDomain error 1`.

**Fix.** Sign and notarize the build. The shell logs the failure explicitly on the
notification's `failed` event, and launching with `TRINITY_NOTIFY_TEST=1` posts a test
notification a few seconds after startup. See
[push notifications](push-notifications.md) and [desktop](../platforms/desktop.md).

### Native-only code does not run on desktop, or desktop takes the native path

**Symptom.** Sign-in on Electron gets the web redirect URI and the callback never comes
back. Or a native-gated feature no-ops where you expected it to work.

**Cause.** There is no Capacitor bridge in the hand-rolled Electron shell, so
`Capacitor.isNativePlatform()` is `false` and `getPlatform()` is `'web'`.

**Fix.** Detect desktop with the preload marker `globalThis.trinityDesktop.isElectron`.
Note the two correct-but-opposite usages: the service worker and push are kept off by
treating desktop as web, while the auth redirect must treat desktop like native.

### Dynamic client registration is rejected before login starts

**Symptom.** The OIDC provider rejects registration with "redirect_uri must not have an
authority". This is not the `invalid_client` the recovery path handles.

**Cause.** RFC 8252 section 7.1 requires a private-use scheme redirect to have no
authority, so it must be `eu.qwky.trinity:/sso-callback` with a single slash.
`//sso-callback` parses `sso-callback` as the authority with an empty path.

**Fix.** Keep the single-slash form. Legacy SSO still uses `//`, so the Electron, Android
and iOS deep-link matchers must be **scheme-only** (`eu.qwky.trinity:`) — matching on
`://` silently drops every OIDC callback. Any change to the registered redirect URI also
needs the client-id cache-key version bumped, or every cached client id is stranded.

### The OIDC token exchange fails with a missing code verifier

**Symptom.** Native and Electron sign-in fails at the exchange; on a cold-start relaunch it
fails everywhere.

**Cause.** The PKCE code verifier did not survive the redirect. Nothing in matrix-js-sdk
persists it: 42 dropped `oidc-client-ts`, which used to keep the sign-in state in
`sessionStorage` under `mx_oidc_<state>`. `OidcStateStore` is the only copy, and the
callback needs `oidc.clientId`, `oidc.deviceId` and `oidc.codeVerifier` to rebuild the
`OAuth2` client — missing any one of them dead-ends at "Missing sign-in details".

Off the web the in-memory route was never viable anyway: on native the authorization happens
in the system browser and on Electron in an external window, so the app's WebView storage is
a different store, and a process eviction loses it outright.

**Fix.** Check the stash actually reached Preferences before the redirect, and that it has
not aged out — it is single-use and expires after 10 minutes, and `peek()` bins an expired
stash rather than serving it. Note the verifier is persisted on **every** platform including
web (where Preferences means `localStorage`); it used to be skipped there, and re-introducing
that skip would break web login outright.

## UI and theming

### Danger text renders as an invisible strip in dark mode

**Symptom.** Alert copy, the encryption warning shield, send-failed retry and the
kick, ban and leave-room labels are unreadable. Measured at 1.26:1 on the chat canvas.

**Cause.** Helm's `--destructive` is a **fill-only** token, always paired with a near-white
foreground. In dark mode it is a near-black maroon.

**Fix.** Use `text-danger`, never `text-destructive`. Trinity splits danger into three
roles: `--trinity-danger` for alert text and icons on a surface,
`--trinity-danger-solid` for a filled badge, and `--trinity-danger-solid-foreground` for
the text on that fill. The values were measured against the worst backdrop each role lands
on; `--trinity-active`, the selected-row surface, was not swept, so re-measure before
putting danger text there. See [UI and theming](../architecture/ui-and-theming.md).

### A style silently does nothing and no tool complains

**Symptom.** A component renders with square corners, or the wrong surface, and the SCSS
reads correctly.

**Cause.** A `var(--x)` with **no fallback** whose custom property is undefined causes the
browser to drop the entire declaration. Nothing checks that a consumed `--trinity-*` token
exists: Stylelint sets `custom-property-pattern: null` and does no cross-file resolution.

**Fix.** Grep every `var(--trinity-…)` used without a fallback across `libs` and `apps` and
confirm each is defined in `variables.scss`. References that do supply a fallback are safe,
because they render the fallback.

### A new palette looks right in light and shows light surfaces in dark

**Symptom.** Exactly that, with no error anywhere.

**Cause.** Attribute selectors weigh in the same specificity column as classes, so
`:root[data-theme='x']` is a **tie** with `:root.dark` and, being authored later, wins.

**Fix.** Scope the palette's light block with `:not(.dark)`, which raises it and makes it
simply not match in dark mode. The intended ladder is `:root`, then `:root.dark`, then
`:root[data-theme='x']:not(.dark)` and `:root[data-theme='x'].dark`. Using `:root.dark`
rather than a bare `.dark` is what makes dark out-rank the light default regardless of
bundle order.

### A toast never appears, with no error and nothing in the DOM

**Symptom.** `toast()` is called and nothing happens.

**Cause.** Since spartan 1.1, Brain ships its own sonner port and no longer depends on
`ngx-sonner`. The mounted toaster renders from Brain's own store, so calling
`ngx-sonner`'s `toast()` pushes into a store nothing observes, and it fails silently.

**Fix.** Import `toast` from `@spartan-ng/brain/sonner`. One service does this and carries
the constraint in its docblock; route new call sites through it.

### The desktop build renders unthemed or light-in-dark

**Symptom.** Only the packaged Electron app is affected; the web build is fine.

**Cause.** Angular's critical-CSS inlining rewrites the stylesheet link into a preload with
an `onload` swap. That handler never fires over the custom `trinity://` scheme the shell
serves from, so the token stylesheet never activates and every `var(--trinity-*)` falls
back to nothing.

**Fix.** `optimization.styles.inlineCritical` stays `false` in the production
configuration. There is a live regression test in the Electron suite that toggles `.dark`
inside the real renderer and asserts the resolved token value.

### A timestamp keeps its old format after the user changes the preference

**Symptom.** Already-rendered timestamps never update.

**Cause.** A pure pipe caches on its input, so a timestamp that never changes skips
`transform()` entirely and never re-reads the preference signal — and has its producer link
trimmed, leaving the view permanently deaf.

**Fix.** Call the formatting service as a method from the template. That re-registers the
dependency on every change-detection pass, so an OnPush view refreshes when the preference
moves even though none of its inputs changed.

### A dialog's content floats over the timeline

**Symptom.** The layout is right, only the background is missing.

**Cause.** The CDK dialog panel is transparent. Every dialog component paints its own
surface.

**Fix.** Use the `dialog-surface()` mixin from the shared feature-rooms mixins. Related:
the dialog service's `autoFocus` defaults to CDK's `'first-tabbable'`, which is wrong for
any dialog whose header carries a Cancel button ahead of the field the user came to type
in. Name the element instead, `autoFocus: '[data-autofocus]'` — a component-side `focus()`
cannot fix it, because CDK focuses after attach.

### Unit tests pass and pnpm build fails with NG8022

**Symptom.** Exactly that, after adding a disabled state to a form field.

**Cause.** The workspace uses Signal Forms exclusively. Binding `[disabled]` on a
`[formField]` node is a compile error the AOT compiler catches and Vitest never sees.

**Fix.** Put it in the schema: `disabled(path, { when: … })`. It must be the `{ when }`
object form — passing a function or string directly is deprecated, and the type-aware
`no-deprecated` rule fails the build on it. Related: a bare `<form>` whose only binding is
a control triggers a native submit and a full page reload; put it under `[formRoot]`.

### A spec asserting a Helm component's host classes is flaky

**Symptom.** The expected utility classes are sometimes present, sometimes not.

**Cause.** Helm styles its host through an async class manager: an effect plus a
document-wide MutationObserver, applying the merged class string on a microtask or
animation-frame schedule.

**Fix.** Assert the pure synchronous `cva` functions (`buttonVariants`, `badgeVariants`)
and that the component renders without throwing. Never assert the applied host classes.

## Matrix and encryption

### A fresh login throws an account mismatch from initRustCrypto

**Symptom.** "the account in the store doesn't match the account in the constructor", or an
account silently losing its E2EE keys after a cold start.

**Cause.** Two variants. Calling `clearStores()` with no argument deletes the SDK's
default-prefix store, not this account's, orphaning the real one — and since the account's
registry record is gone, the startup orphan sweep then deletes it. Separately, scoping the
crypto-store prefix by user id alone breaks re-login, because the Rust `OlmMachine` binds
to a `(userId, deviceId)` pair and a fresh login always mints a new device id.

**Fix.** Always pass `{ cryptoDatabasePrefix: account.cryptoPrefix }` taken from the
account client, never recomputed. The prefix must include the device id, and storage must
recompute it whenever an account's device id changes, reclaiming the abandoned store.

### TypeScript cannot find CryptoApi or decodeRecoveryKey

**Symptom.** Import errors for `CryptoApi`, `CryptoEvent`, `decodeRecoveryKey`,
`EventShieldColour`, `ServerSideSecretStorage` or `SecretStorageKeyDescriptionAesV1`.

**Cause.** matrix-js-sdk does not re-export the crypto API from the package root, in 41.x or
42.x. The
root does export a `SecretStorage` namespace, which is a different thing.

**Fix.** Deep-import from `matrix-js-sdk/lib/crypto-api` and
`matrix-js-sdk/lib/secret-storage`. These resolve only because the SDK's `package.json` has
no `exports` field; if upstream adds one, every deep import here breaks at once.

### Set up encryption is offered on an account that already has recovery

**Symptom.** Taking that offer mints a new 4S key and deletes every key-backup version.

**Cause.** After initial sync, `secretStorage.getDefaultKeyId()` routes through
`getAccountDataFromServer`, which answers from this client's **local** store. That view is
stale for as long as a `/sync` echo is missing — up to about 110 seconds when a long-poll
dies.

**Fix.** Any decision that can destroy something must ask the server directly with an
authed request on the account-data endpoint, bounded by a timeout, and fail open. The same
applies to writes: `setAccountData` short-circuits to a no-op when the local store already
matches and then waits for an echo it never caused, so the deterministic writer is
`setAccountDataRaw`, wrapped in a retry and with no read gating it.

### First-run encryption setup hangs on a spinner forever

**Symptom.** Against a homeserver that accepts the socket and never answers.

**Cause.** `createClient` passes no `localTimeoutMs`, and matrix-js-sdk's fetch layer only
attaches a timeout signal when one is given. Nothing below these calls bounds anything.

**Fix.** Wrap every homeserver round-trip in the crypto flows with the local `withTimeout`
helper, which also attaches a no-op catch to the losing promise so its later rejection does
not surface as unhandled.

### An unverified message renders exactly like a verified one

**Symptom.** No shield at all after a transient crypto or store error.

**Cause.** Returning `null` from a shield probe means "no shield", which is visually
identical to a fully authenticated message.

**Fix.** Fail closed. A caught probe error yields a grey caution shield with a generic
reason, so a transient failure can never visually upgrade a message's authenticity. Keep
the catch, so a probe failure cannot break the timeline.

### The correct recovery key is accepted and the device stays unverified

**Symptom.** The flow reports success and the device remains at `needs-recovery`
permanently.

**Cause.** `resetCrossSigning` rotates the private keys locally before it uploads anything.
A reset abandoned in between leaves the olm machine holding keys nobody published, and
`bootstrapCrossSigning({})` sees privates already present and does nothing.

**Fix.** Detect it with the narrow condition — all three privates cached locally **and** in
4S **and** cross-signing not ready — then export and re-import the secrets bundle patched
with the real seeds from 4S, followed by `crossSignDevice`. Checking only
"cross-signing is not ready" is far too wide and matches every ordinary unverified device.
See [Matrix and encryption](../architecture/matrix-and-encryption.md).

### A recovery reset destroyed the key backup and gave nothing back

**Symptom.** A user who cancels the password prompt, mistypes their password, or is on an
SSO-only or OIDC-native account loses everything. Measured on Synapse v1.119.0:
`room_keys/version` goes from 200 to `M_NOT_FOUND`.

**Cause.** `CryptoApi.resetEncryption` deletes every key-backup version and all of secret
storage **before** the cross-signing upload that needs interactive auth — and the password
prompt lives inside that upload.

**Fix.** Trinity does not call it. A hand-written copy authenticates first against a
harmless request, so a refusal costs zero writes. Because it is a copy, diff
`rust-crypto.js`'s `resetEncryption` on every SDK bump: a step added upstream is not
inherited. Also, do not wrap the reset in `runWithBusy` — that maps failures to `EMPTY`, and
this is the one path that must inspect why it failed to distinguish a cancelled prompt from
an unsupported one.

## Architecture

### A read model freezes after logout then login

**Symptom.** The room list, unread badges or crypto status stop updating after a logout or
an account switch, and nothing in the console says why.

**Cause.** A logout swaps in a brand-new `MatrixClient`. A `connected: boolean` guard makes
the second `connect()` a no-op, leaving listeners attached to the discarded client.

**Fix.** Never hand-roll this. `projectFromClient` keeps `connectedClient: MatrixClient | null`
and compares by identity, disconnecting first when it differs. Call it from a field
initializer of a root-provided service, which is an injection context — the account-switch
re-projection creates an `effect()` and needs one, or you get NG0203 or a silently dead
switch.

### A section stays empty until the user clicks twice

**Symptom.** After clicking a foreign account's space pill, sub-space sections stay
permanently empty until the pill is clicked again.

**Cause.** The rooms and spaces services re-project onto the new client from an effect,
which flushes _after_ the switch Observable completes. Anything requested before that flush
is wiped by it.

**Fix.** Defer the follow-up with `afterNextRender(() => …, { injector })` — past the render
that follows the switch, not merely past the Observable.

### An action lands on the wrong account

**Symptom.** A favourite that does not stick, a mark-read that never clears the badge, or
an avatar fetched through the wrong homeserver.

**Cause.** In the mixed-account view a room row may belong to a signed-in account that is
not active, so `matrix.instance` is the wrong client.

**Fix.** Take an optional `accountId` and resolve through `clientFor(accountId)` falling
back to `matrix.instance`. Note a room two accounts are both in renders as **one** row
whose unread is the loudest of the two, so idempotent actions must reach all of the row's
`accountIds` or the merged badge can never be cleared.

### A stale rebuild uses the wrong client

**Symptom.** A rebuild coalesced from account A's events runs after the active client is
already B, and rebuilds from B.

**Cause.** Re-reading `matrix.instance` inside a coalesced `rebuild()` instead of taking the
bound `client` argument the projection passes in precisely to close that window.

**Fix.** Take the argument. Several existing services still re-read `matrix.instance`,
benignly, because the re-projection effect was about to rebuild anyway — do not copy them.

### Lint rejects a commit with a module-boundary error

**Symptom.** `@nx/enforce-module-boundaries` fails and the pre-commit hook refuses the
commit. Two flavours: a feature importing another feature, or a scope violation from
`data-access-matrix-client`.

**Cause.** There is no allow-list and no per-file suppression anywhere in the repo. The type
axis and the scope axis are checked independently, so a library can satisfy one and fail the
other — `data-access-matrix-client` is tagged `scope:shared` on purpose, so the client
foundation stays domain-agnostic.

**Fix.** For a cross-feature need, either read the relevant `@trinity/data-access/*` signal
from the feature that owns the surface, or put a lazy-loader `InjectionToken` in a `type:ui`
library below both (as `@trinity/components/encryption-dialog` does),
provide it in `main.ts` with a dynamic `import()`, and inject it optionally with a graceful
fallback. See [libraries](../architecture/libraries.md).

### The initial bundle grows and a lazy route stops paying off

**Symptom.** The initial budget starts creeping toward its 2 MB warning.

**Cause.** Two variants. A **value** import of a lazy page in `app.routes.ts` merges the
chunk into the initial bundle — esbuild also does not constant-fold `environment.production`,
so guarding a route with a ternary does not strip its `import()`. And re-exporting a heavy
or dev-only module from a barrel that `main.ts` imports eagerly ships it eagerly.

**Fix.** Use `import type` for a type-only reference, and spread a dev-only route out of the
array entirely. Keep heavy modules out of barrels and reach them through their own path
alias. Nothing enforces either — only the comments at the sites.

### A subscriber's success callback silently never runs

**Symptom.** Cleanup or navigation in `.subscribe(() => { … })` does not happen, and no
error reaches the caller. Or a busy spinner sticks on forever.

**Cause.** `runWithBusy`'s `catchError` writes the message into the `error` signal and
returns `EMPTY`, so the failure is swallowed by design and the template's error banner is
the only channel. Separately, `busy` is set eagerly at call time, before the returned
Observable is subscribed, so calling it and never subscribing leaves `busy` stuck true
because `finalize` never runs.

**Fix.** Put failure handling in the template, subscribe to everything you call, and do not
use it on a path that must triage its own errors.

### The app is wedged and there is no way to clear its data

**Symptom.** Trinity will not start, will not sign in, or renders wrongly, and signing out
does not help — because sign-out only removes tokens and the account registry. On iOS,
Android and the desktop shell there is no devtools "clear site data" to fall back on.

**Cause.** The app's local state spans four surfaces, and nothing cleared them all: ~20
`trinity.*` preferences, the account registry and secrets under `matrix.*` / `secure.*`, the
OIDC and SSO round-trip stashes under `oidc.*` / `sso.*`, two IndexedDB families (the message
sync store and the Rust crypto store, per account and per device), and the service-worker
caches on web. A bad `trinity.push.gateway`, a stale feature flag or a crypto store that will
not initialise therefore survives everything the UI offers.

**Fix.** **Erase all data on this device**, at the bottom of the login page — deliberately
there rather than in Settings, which is behind `authGuard` and so unreachable in exactly this
situation. It erases all four surfaces and restarts the app. It is irreversible: encryption
keys not in a server-side backup go with it, so it asks you to type `ERASE`. Nothing on the
server is deleted.

If Trinity is open in a second window, one of the databases may still be held open when the
wipe runs. It finishes anyway rather than stopping half-way: the deletes run concurrently, so
by the time one reports blocked the rest are already gone, and aborting there would leave the
very half-erased install that stopping is meant to avoid. Whatever survives is an orphan no
account points at, which `sweepOrphanedCryptoStores` reclaims on the next cold start, when
nothing holds a connection. The names are logged to the console.

**See also.** [The factory reset](../architecture/matrix-and-encryption.md#the-factory-reset)
for the mechanism — which phase orderings are load-bearing and why, why deletion is bounded
rather than awaited, and the three surfaces it deliberately cannot reach. The user-facing
version is in [Signing in](../users/signing-in.md#starting-over-when-trinity-will-not-work).

## Related pages

- [Commands](../contributing/commands.md) for what each script actually runs
- [Testing](../contributing/testing.md) for the suites and when to use which
- [Stack reference](stack.md) for pinned versions and version-specific traps
