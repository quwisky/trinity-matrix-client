# Troubleshooting

Start with the symptom, then check the named owner and the actual failure output.
A missing prerequisite, a failed check and an unexecuted check are different outcomes;
keep that distinction in a bug report or pull request. Reproduce with the same target,
configuration and dependency state before changing implementation or weakening a guard.

For setup and command selection, use [getting started](../contributing/getting-started.md),
[commands](../contributing/commands.md) and [testing](../contributing/testing.md).
Do not include tokens, recovery keys or real message content in shared diagnostics.

Preference and Room-order health diagnostics contain only generated scope references, stable
capability/operation identities and codes. A partial reset may list exported setting paths and
statuses, but never old, default or candidate values. Do not add thrown storage text, Account IDs,
Room IDs, API keys or preference values when copying these diagnostics into an issue. Retry the
specific visible scope; a global startup retry can repeat unrelated work.

## Build and tooling

### pnpm test fails in the scripts project with ENOENT or a floor assertion

The stack-version guard reads [stack.md](stack.md) and the Matrix architecture guide.
A missing document, unparseable table or fewer than **12** installed-package rows fails
before the guard can compare versions. Preserve backticked package names and numeric
`major.minor.patch` version cells. Run `pnpm nx test scripts -- stack-versions`.
If moving the reference, update its reader and links together; do not remove the guard.

### An edit to the version table does not fail the test locally

Check which files and installed package manifests the guard actually reads. It skips
non-numeric version cells and packages absent from root `node_modules`; Electron has a
separate installation. `scripts:test` now has `cache: false` and explicit cross-repository
inputs, so the historical stale-cache diagnosis no longer applies. Run
`pnpm nx test scripts -- stack-versions` and inspect its exit status and assertions.

### The Electron compile fails with TS5107 on `moduleResolution`

Inspect `electron/tsconfig.json`, especially after an Nx migration. The shell needs
`"module": "Node16"` and `"moduleResolution": "Node16"`; TypeScript 6 rejects the old
Node10 resolution setting. Run `pnpm electron:typecheck`, which uses the shell's own
pinned dependencies. Do not suppress the compiler error with an older root compiler.

### A native build points at a pnpm path that does not exist

Capacitor-generated plugin paths include resolved pnpm versions and can become stale
after a dependency change or checkout move. Re-run the appropriate `pnpm android:sync`
or `pnpm ios:sync`, then inspect the generated diff. Native build prerequisites and
platform-specific verification remain necessary; see [mobile](../platforms/mobile.md).
A successful sync alone does not prove Xcode or Gradle can build the application.

### Every browser test fails at launch after a Playwright bump

An `Executable doesn't exist` error usually means the Playwright package and downloaded
browser revisions differ. Run `pnpm exec playwright install chromium webkit` with the
checkout's pinned dependencies, then rerun the failed target. A missing browser is a
prerequisite failure, not evidence about the application's behavior.

### pnpm build produced a minified, hashed, service-worker build

That is the default renderer configuration. Use `pnpm nx run trinity:build:development`
for development output. Host targets can depend on a separate production build; inspect
`pnpm nx show project <project> --json` before assuming a forwarded configuration
changes a dependency. Production behavior is also exercised by Web/PWA targets, not only
Electron. See [commands](../contributing/commands.md).

### nx test cannot find the project you named

List projects with `pnpm nx show projects`. The project name, path and alias differ:
`data-access-room-library`, `libs/data-access/room-library` and
`@trinity/data-access/room-library` name the same library in three contexts. The old
`core` project no longer exists. Vitest filters follow `--`, for example:

```bash
pnpm nx test data-access-room-library -- account-scope
```

Inspect resolved targets before copying a command for another project.

### Moving a library breaks its test suite with every config file correct

Check relative imports in `src/test-setup.ts` as well as the project and Vite configs.
The setup import still depends on directory depth even where the shared config locates
the workspace root dynamically. Use `rg "test-setup.base|vite.base.config" <library-path>`
and resolve each path from its importing file. Run that project's tests and typecheck.

### A library move can silently weaken module boundaries

A passing boundary lint is not sufficient if renamed aliases no longer resolve to Nx
projects. Check `tsconfig.base.json`, resolved project tags and the graph after a move.
For a positive control, use an isolated disposable checkout: temporarily import
`RoomLibraryService` from `@trinity/data-access/room-library` into the public foundations
entrypoint and run `pnpm nx lint components-foundations --skip-nx-cache`.
The diagnostic must name the forbidden boundary, not merely an unused import. Remove
only that temporary edit and rerun lint. Never restore an entire file over unrelated work.

### A browser journey type error survives test transpilation

Playwright transpiles specs without typechecking them. Run
`pnpm nx run trinity-e2e-browser:typecheck` and
`pnpm nx run trinity-e2e-browser:lint` as well as the relevant journey.
Likewise, a passing Vitest suite does not replace its project typecheck.

## Tests

### The canonical browser config refuses to run directly

The config joins a lifecycle-owned invocation; it does not create a fallback build,
server, lock or disposable Synapse. Run `pnpm nx run trinity-e2e-browser:e2e`
and pass a capability-relative spec path or `--grep` after `--`. See
[E2E ownership](../contributing/e2e-architecture.md).

### A spec passes locally and fails in CI, reported as flaky

The canonical browser config sets two retries and two workers locally as well as in
CI. A later passing attempt does not erase a first-attempt failure. Reproduce with
`--retries=0` after the target's `--` separator, retain the first failure artifacts and
report flaky counts. Follow [testing](../contributing/testing.md) before changing retries.

### A different test fails each run, and the totals do not add up

Missing test totals or `Worker forks emitted error` can indicate a crashed or killed
worker. They do not prove memory starvation, and varying failures do not exclude a
regression. Inspect worker stderr, process exit signals, available memory and any OS
kill evidence. Compare the same focused target and dependency/configuration state in
isolated checkouts when needed; install dependencies per worktree rather than assuming
a shared symlink is safe.

Reduce competing work while diagnosing. Measure a focused run, for example:

```bash
/usr/bin/time -f %M pnpm nx test feature-rooms --skip-nx-cache -- message-composer --maxWorkers=1
```

On systems with GNU `time`, this reports peak resident memory in KiB. Record the actual
exit status too. Split tests only when measurements and responsibility boundaries justify
it; historical per-file memory figures are not universal limits.

### The e2e web server dies with a Go stack trace

An esbuild `all goroutines are asleep - deadlock!` failure during the lifecycle's
renderer build needs the complete build log and process/resource evidence. Memory
pressure is one possibility, not a diagnosis from the stack trace alone. Reproduce the
same `trinity:build:development` target with competing tasks stopped, and compare the
configuration and dependency state. Do not call the journey passing when its build failed.

### A negative assertion in a projection spec proves nothing

A negative assertion can run before a coalesced callback or before the projection was
attached at all. Start the owned projection lifetime, prove a relevant positive event is
observed, then exercise the forbidden event and wait for the scheduler/barrier it uses.
`await Promise.resolve()` flushes the immediate microtask used by `coalesce`; it is not
universal readiness proof. See [state and reactivity](../architecture/state-and-reactivity.md).

### NG0950 during a component spec's first change detection

Import `render` from `@trinity/testing`. Its zoneless wrapper renders without initial
change detection, applies inputs and output handlers, then detects. Bypassing it can leave
required inputs unset. Do not mix native `bindings` with later `setInput` updates without
checking Angular's binding contract; see [testing](../contributing/testing.md).

### Cannot synchronously execute watches while scheduling

A synchronous `requestAnimationFrame` stub can re-enter the zoneless scheduler while an
attached fixture is ticking. For a test that deliberately drives scheduling, use a detached
`TestBed.createComponent` fixture, set inputs, then call `detectChanges()` explicitly.
Restore global stubs in teardown. Do not change production scheduling merely to satisfy
an unrealistic inline-frame mock.

### A tooltip spec fails exactly like the bug it was written to catch

Set the pointer type explicitly when dispatching pointer events: tooltip opening
recognizes mouse or pen, while jsdom event defaults may not. Preserve the shared
`PointerEvent` defaults shim. Pointer-capture methods also need appropriate per-spec
stubs for interactions such as drawers and sliders. Use a real browser to prove geometry,
hover behavior and visible positioning.

### Two green suites and a shipped defect

A mock can hide disagreement between a caller and the real shared store or outlet.
Add integration coverage at that seam: for a toast, mount the real service and toaster,
wait for rendering, and assert the message appears. Keep unit coverage for isolated logic;
use browser evidence for layout or platform behavior. See [testing](../contributing/testing.md).

### pnpm test fails while installing the desktop test dependencies

`electron/` has its own manifest, frozen lockfile and dependency installation. Check
whether the failure is network access, a build-script policy or a stale lock before
changing files. Use the pinned pnpm to repair a genuinely inconsistent shell lock, then
run `pnpm electron:test`. Adding shell-only packages to the root bypasses its ownership.

### The Electron e2e suite times out with no useful message

Check the launch log and display availability. Headless Linux still needs an X server;
use `xvfb-run -a pnpm electron:e2e` where Xvfb is installed. The launcher flag
`--no-sandbox` is distinct from the renderer's `webPreferences.sandbox`; do not disable
the application sandbox as a launch workaround. See [desktop](../platforms/desktop.md).

### SSO logins fail against the disposable Synapse after an earlier harness run

A running container may still hold an older bind-mounted configuration. The harness
fingerprints mounted configs and restarts stale services; inspect that decision and the
container logs. Preserve the fingerprint/restart contract rather than relying on a
successful readiness poll, which does not prove the expected authentication config loaded.
Run fixed-port harnesses sequentially.

### register_new_matrix_user fails with HMAC incorrect

Compare the single harness-owned registration secret with the generated Synapse config
without printing it into shared logs. Duplicate `registration_shared_secret` entries can
make the helper and server use different values. Preserve the start script's replace-in-place
behavior and the helper's import of its canonical value; do not introduce another copy.

## Electron and native

### Desktop packaging dies at codesign with a missing arm64 path

The local macOS package script assumes `release/mac-arm64/Trinity.app`; an x64 build can
instead produce `release/mac/Trinity.app`. Check the actual artifact and host architecture
before changing signing paths. This is a known local-script limitation; a successful build
on another architecture does not validate it. See [desktop](../platforms/desktop.md).

### codesign command not found in CI

The current development-signing target skips signing off macOS. Inspect the resolved
command if a Linux or Windows job still invokes `codesign`. On macOS, development signing
and a distributable signed/notarized package are separate paths with different credentials.
Do not report a development signature as release verification.

### Secure storage refuses to work on a Linux box

Inspect the selected OS storage backend. Trinity rejects Electron's `basic_text` and
`unknown` backends as secure storage even when encryption is nominally available. Install
and unlock a supported keyring when secure storage is required. The documented plaintext
fallback emits a warning and does not provide equivalent protection; see
[desktop storage](../platforms/desktop.md).

### Desktop notifications never appear on macOS

Inspect the shell's notification failure event and signing status. macOS notification
presentation depends on the application identity and OS permission; use the signed build
path for representative validation. `TRINITY_NOTIFY_TEST=1` exercises presentation after
startup. A displayed test notification does not prove Matrix push delivery. See
[push notifications](push-notifications.md).

### Native-only code does not run on desktop, or desktop takes the native path

Electron has no Capacitor bridge: `isNativePlatform()` is false. Use the host capability
contract for product operations and keep host selection in its adapter. When maintaining
that adapter, the preload marker identifies Electron. Auth callbacks, service workers and
push have distinct host policies; do not derive them from one blanket native/web branch.
See [platforms](../platforms/index.md).

### Dynamic client registration is rejected before login starts

Check the actual redirect registered by the authentication adapter. OIDC uses
`eu.qwky.trinity:/sso-callback` with one slash; the legacy SSO form uses two. Native and
desktop matchers must accept the scheme without requiring `://`. When changing a registered
redirect, review the cached client-ID key version too. See
[authentication adapter](../../libs/data-access/auth/src/lib/oidc-client.service.ts).

### The OIDC token exchange fails with a missing code verifier

The round-trip state must persist before opening the authorization page. Check that
`OidcStateStore` saved the client ID, device ID and verifier, without logging their values.
The stash is single-use and expires after ten minutes; a missing or expired stash requires
a fresh sign-in. Web persistence matters too: process restarts and external browsers cannot
rely on an in-memory verifier. See [authentication adapter](../../libs/data-access/auth/src/lib/oidc-client.service.ts).

## UI and theming

### Danger text renders as an invisible strip in dark mode

Use `--trinity-danger` / `text-danger` for alert text and icons. Helm's `--destructive`
is a fill token, not a readable foreground on dark surfaces. Filled danger controls use
`--trinity-danger-solid` with `--trinity-danger-solid-foreground`. Verify contrast on the
actual backdrop and Theme; see [UI and theming](../architecture/ui-and-theming.md).

### A style silently does nothing and no tool complains

Inspect computed styles in the browser. An undefined custom property without a fallback
invalidates its declaration; a valid fallback can still conceal a misspelled token. Check
the token's owner and every theme variant. Also inspect cascade layers: unlayered component
SCSS outranks Tailwind's layered utilities, regardless of utility specificity. See
[UI and theming](../architecture/ui-and-theming.md).

### A new Theme looks right in light and shows light surfaces in dark

Inspect the selectors that match in both modes. A light Theme selector can tie with
`:root.dark` and win by source order. The intended forms separate
`:root[data-theme='x']:not(.dark)` and `:root[data-theme='x'].dark`. Follow the theme
foundation's current contract and verify the rendered light/dark combinations.

### A toast never appears, with no error and nothing in the DOM

Use the public `TrnToastService` from `@trinity/components/overlay` and ensure its real
outlet is mounted. Calling a third-party toast store directly can write to a store the
outlet never observes, and violates the product/UI boundary. Validate the service and outlet
together; see [UI and theming](../architecture/ui-and-theming.md).

### The desktop build renders unthemed or light-in-dark

Check the production renderer configuration and loaded stylesheets. Keep
`optimization.styles.inlineCritical: false`: the deferred stylesheet swap does not work
reliably over the shell's `trinity://` scheme. Verify resolved theme tokens in the launched
Electron renderer, not only a web dev server.

### A timestamp keeps its old format after the user changes the preference

A pure pipe can retain its result while its timestamp input stays unchanged, even when
a formatting preference changes. Use the owned formatting service from a template method
so the view tracks the preference signal. Verify an already-rendered timestamp updates;
recreating the component would miss the stale-view defect.

### A dialog's content floats over the timeline

Use the public overlay surface contract, including `trnOverlaySurface`, through
`@trinity/components/overlay`. Do not import a feature-room mixin into another feature.
Check the intended focus target through the dialog API: a Cancel button before the primary
field may otherwise receive focus. Validate focus and the visible surface in a browser.

### Unit tests pass and pnpm build fails with NG8022

Signal Forms owns field constraints. Put disabled state in the schema with
`disabled(path, { when: … })`; put length constraints there too rather than binding
`[attr.maxlength]` beside `[formField]`. AOT catches these conflicts while Vitest only
transpiles the template. Use `[formRoot]` for form handling and run the renderer build
for changed form bindings.

### A spec asserting a Helm component's host classes is flaky

Host classes can be applied asynchronously through the class manager. Unit-test pure
variant functions and component contracts without mistaking a pre-update snapshot for the
rendered result. When a class or layout is itself the behavior under test, wait for its
observable application in a real browser. jsdom cannot prove its visual effect.

## Matrix and encryption

### A fresh login throws an account mismatch from initRustCrypto

Verify the stored Account's exact client and device identity. Rust crypto binds a store
to both user and device; reusing a user-only prefix across fresh logins is wrong. Cleanup
must use the Account's actual `cryptoDatabasePrefix`, not recompute a default. Inspect
lifecycle outcomes before retrying or deleting data; local-only keys can be lost. See
[Matrix and encryption](../architecture/matrix-and-encryption.md).

### TypeScript cannot find CryptoApi or decodeRecoveryKey

The installed SDK adapters use `matrix-js-sdk/lib/crypto-api` and
`matrix-js-sdk/lib/secret-storage` for these APIs. Inspect the installed package declarations
and export map after an update. Keep imports inside SDK adapters and run their typechecks;
see [stack integration notes](stack.md#crypto-types-are-deep-imports).

### Set up encryption is offered on an account that already has recovery

A local sync projection can lag server account data. The current setup path checks the
server's recovery pointer directly and blocks setup when recovery is positively reported.
**A failed existence read currently permits setup**; this is not a fail-closed guarantee.
Do not turn that narrow implementation detail into general advice to proceed after a failed
destructive prerequisite. Inspect Security and the actual server state before repeating
setup. See [Matrix and encryption](../architecture/matrix-and-encryption.md).

### First-run encryption setup hangs on a spinner forever

Check which request or operation remains pending. Account clients have a 30-second
default request deadline; crypto operations add their own bounded budgets.
`runWithBusy` clears busy state on termination, including cancellation and empty completion.
Keep request deadlines and safe error presentation in the owning service; a component
spinner is not proof that the server request is still running.

### An unverified message renders exactly like a verified one

A shield-probe error must not be represented as the absence of a shield. The owned
presentation path catches probe failures and returns a grey caution shield with a generic
reason. Preserve that distinction and ensure a failed probe cannot break timeline rendering.
Do not infer verified authenticity from a failed read.

### The correct recovery key is accepted and the device stays unverified

A partially abandoned cross-signing reset can leave unpublished private keys cached
locally. The repair uses a narrow condition: all three private seeds exist locally and in
secret storage, but cross-signing is not ready. It restores the authoritative secret bundle
and signs the device. Do not apply this repair to every unverified device; inspect the
owned recovery implementation and [encryption guide](../architecture/matrix-and-encryption.md).

### A recovery reset destroyed the key backup and gave nothing back

Trinity owns its recovery-reset sequence instead of calling the SDK's destructive
`resetEncryption` directly. Pre-authentication refusal precedes writes; a later upload-stage
challenge can follow reversible pointer parking/local rotation and require rollback.
After identity publication, a failure can be partial and cannot be undone. Inspect Security
before retrying, and preserve error distinctions rather than swallowing them in
`runWithBusy`. Compare this owned sequence with upstream on SDK updates. See
[Matrix and encryption](../architecture/matrix-and-encryption.md).

## Architecture

### The authenticated renderer freezes immediately after sign-in

Inspect effect dependencies and synchronous callbacks. Notification reconciliation can
emit a warning that updates runtime state; tracking those incidental reads can create a
self-triggering loop. Read the owned trigger, then reconcile under `untracked`. Keep the
regression that changes a subscriber's unrelated signal and proves negotiation does not
restart. A CPU-bound renderer is not diagnosed by increasing Playwright timeouts.

### The startup spinner never leaves during optional capability discovery

Storage persistence, update discovery and native badge callbacks may never settle.
Their host commands must stay cold and finite, producing bounded fallback outcomes or typed
warnings. Check the optional capability's outcome and Application Runtime stage rather than
waiting indefinitely. Preserve never-settling-promise regressions and the badge adapter's
release of timed-out attempts. See [application startup](../architecture/index.md#application-startup).

### A second stored account fails while Rust crypto starts

Inspect per-Account restoration outcomes and the Matrix client's crypto initialization
queue. `initRustCrypto()` must be serialized despite separate database prefixes, while
unrelated Account work remains independent. The queue must advance after both success and
failure so one unavailable Account does not block later restoration.

### A read model freezes after logout then login

A new sign-in can create a new Matrix client. A boolean “connected” guard can leave
listeners on the retired client. Use the owned projection lifecycle and compare client
identity. `projectFromClient` is dormant until its owner subscribes to `run()`; construction
alone is not attachment. Verify attach, replacement, publication and release through
Projection Runtime. See [state and reactivity](../architecture/state-and-reactivity.md).

### A section stays empty until the user clicks twice

Check the Account switch outcome and Projection Runtime readiness before Workspace
repair. The current switch workflow awaits the active-account transition and its projection
acknowledgements. Do not add `afterNextRender` as a timing workaround for missing readiness;
find the projection or repair step that did not complete. Preserve Account/Workspace
ownership and cancellation behavior.

### An action lands on the wrong account

A mixed-account Room row can belong to a different Account, or several Accounts.
Resolve the command's exact Account through its capability API rather than reading the
current active client at execution time. Aggregate unread cleanup and favourite changes
must honor the row's full Account membership where their contracts require it. Validate
both active and non-active Account cases; see [state and reactivity](../architecture/state-and-reactivity.md).

### A stale rebuild uses the wrong client

A callback queued for Account A must not re-read the now-active client B. Use the bound
client/handle supplied by the projection and preserve generation checks that reject retired
publications. Exercise an Account switch while work is queued; a steady-state test does
not cover this race.

### Lint rejects a commit with a module-boundary error

Inspect both type and scope tags, plus public UI/vendor restrictions. A feature cannot
import another feature; the shared Matrix foundation cannot reach a product-domain library.
Move the dependency to its owning capability or use the application-owned composition
contract. Do not add an exemption to make lint pass. See
[library boundaries](../architecture/libraries.md).

### The initial bundle grows and a lazy route stops paying off

Inspect actual build chunks and import paths. A value import or eager barrel re-export
can pull a lazy implementation into startup. Use `import type` where only a type is needed,
and keep heavy implementations behind their owned lazy boundary. Conditional route syntax
alone does not prove dead code was eliminated. Rebuild the intended configuration and
check its output rather than relying on an old bundle-size measurement.

### A subscriber's success callback silently never runs

`runWithBusy` reports a caught failure and completes with `EMPTY`, so the subscriber's
next handler does not run. Keep unconditional cleanup in `finalize`; use a path that
preserves errors when the caller must distinguish cancellation, refusal or partial failure.
Cold commands need subscriptions owned by the appropriate lifetime. Present safe captured
errors through the surface's status service, not an incidental effect.

### The app is wedged and there is no way to clear its data

Account sign-out removes its client and stores as well as credentials; it does not reset
all installation preferences and other local state. If the login screen is reachable,
**Erase all data on this device** offers an installation reset after typing `ERASE`.
It removes local-only keys and the Web/PWA offline cache, so arrange recovery and connectivity
before using it. Server-side history is not deleted.

Close other Trinity windows first. Deletions can be bounded or blocked, and the next-start
orphan sweep targets Rust crypto databases only where enumeration is available; it is not
a guarantee that every leftover is removed. Report incomplete cleanup accurately. See
[the user reset procedure](../users/signing-in.md#starting-over-when-trinity-will-not-work)
and [the factory-reset contract](../architecture/matrix-and-encryption.md#the-factory-reset).

## Related pages

- [Commands](../contributing/commands.md) — supported target invocations
- [Testing](../contributing/testing.md) — validation scope and failure evidence
- [Stack reference](stack.md) — runtime requirements and dependency integration
- [Platform guides](../platforms/index.md) — host prerequisites and limitations
