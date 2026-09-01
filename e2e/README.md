# Trinity e2e

Trinity's system-level tests are registered by execution environment first and product
capability second. [`registry/index.mts`](registry/index.mts) owns the executable inventory:
Nx projects, prerequisites, CI tier, cache policy, serialization,
commands, artifacts and source entrypoints. `pnpm architecture:check` fails when that contract
drifts.

Use `pnpm e2e` for the pull-request-classified set, `pnpm e2e:all` for every suite available on
this host, or `pnpm e2e:<environment>` for browser, Web/PWA, components, protocol, Electron or
Android. The aggregate validates every prerequisite before starting work and runs registered
suites in safe order. Strict tier/environment aggregates stop on an unavailable prerequisite;
`e2e:all` does the same for every suite marked required and continues only past a suite explicitly
classified optional. Every current suite is required. Focused legacy
commands remain Nx-backed compatibility aliases through one released changelog cycle, and may be
removed only after replacements are documented, repository/CI references reach zero, and that
cycle has no reported migration failures.

Web/PWA, component/visual, canonical browser and protocol contracts now live in lifecycle-owned projects.
Canonical app journeys are grouped by capability under `e2e/browser/journeys/`, installed WebView
journeys live in `e2e/android/`, desktop journeys in `e2e/electron/`, and protocol journeys in
`e2e/protocol/`. The extracted
`trinity-e2e-support` project owns every process and the disposable stack under
`e2e/support/synapse/`; Synapse-backed children only join its serialized invocation.

The Synapse-backed web and protocol wrappers build the development bundle for you.
`pnpm nx run trinity-e2e-web:production-pwa` builds the production PWA and verifies its
routing, manifest, service worker, offline shell, and crypto WASM without Docker. The aggregate
`pnpm e2e:web` also runs the Docker-backed production-renderer matrix. Android builds the same
production web output and syncs it into the APK before every run.

> On a **containerised CI runner** (a job container talking to a separate Docker
> daemon), set `TRINITY_E2E_STATE_DIR` and `TRINITY_E2E_NETWORK_CONTAINER` — bind
> mounts and published ports are both resolved by the daemon, not by the job. See
> `e2e/support/synapse/paths.mjs` and docs/contributing/testing.md.

## Layout

```
e2e/
  registry/   typed suite, command, CI, prerequisite and migration-destination contract
  browser/    trinity-e2e-browser: capability-owned canonical journeys, catalog,
              browser-owned journey helpers and coverage reporting — `pnpm e2e:browser`
  components/ trinity-e2e-components: Storybook, CSS and scrollbar contracts
  protocol/   trinity-e2e-protocol: Playwright Test verification, crypto, media,
              relation, room, search and emoji journeys — `pnpm e2e:protocol`
  web/        trinity-e2e-web: production Web/PWA host and renderer contracts — `pnpm e2e:web`
  android/    API 36 Capacitor WebView fixture, native-only specs, and device
              orchestrator — `pnpm e2e:android`
  electron/   trinity-e2e-electron: launched-shell smoke and full desktop journeys
  support/    trinity-e2e-support: invocation/session ownership, dynamic servers,
              process locks, namespaces, reporting, and the Synapse+Caddy+Dex harness
```

Always invoke a journey through its `pnpm`/Nx command. Protocol specs use the same validated
invocation descriptor, Playwright fixtures, attempt namespace and report policy as the other
lifecycle projects; they never start a fallback server or homeserver.

[`browser/journey-catalog.mts`](browser/journey-catalog.mts) gives every canonical spec exactly
one owning capability and one primary contract type. The registry validator rejects missing,
duplicate, stale, or folder-mismatched entries and pins the pre-move inventory of 266 tests and
1,782 assertion calls. A browser run adds those classifications to each Playwright result and
writes `capability-coverage/coverage.json` below that run's ignored artifact directory, grouped by
capability and contract type. The eleven capability directories are `accounts`, `workspace`,
`room-library`, `room-administration`, `conversations`, `trust`, `identity`, `notifications`,
`discovery-search`, `settings`, and `host-shell`.

The canonical Nx target is one serialized, uncached lifecycle atom because every selected file
shares one disposable fixed-port Synapse stack. Per-spec inferred CI targets remain disabled;
focus the owned target by capability path or test name instead:

```bash
pnpm nx run trinity-e2e-browser:e2e -- conversations/message-links.spec.mts
pnpm nx run trinity-e2e-browser:e2e -- --grep "opens a copied message link"
```

## Scripts

| Command                                         | What it does                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm e2e`                                      | Run the pull-request-classified local E2E set after one registry/prerequisite preflight.                                                   |
| `pnpm e2e:all`                                  | Run the complete local E2E delivery gate; all current suites are required.                                                                 |
| `pnpm e2e:scheduled`                            | Run the scheduled-classified cross-browser and protocol suites with strict preflight.                                                      |
| `pnpm e2e:browser`                              | Run canonical Synapse browser journeys.                                                                                                    |
| `pnpm e2e:components`                           | Run Storybook, styling and cross-browser scrollbar contracts.                                                                              |
| `pnpm e2e:protocol`                             | Run every registered verification, crypto and protocol/system driver.                                                                      |
| `pnpm e2e:electron`                             | Run Electron shell smoke and the full Synapse-backed desktop journey under Xvfb when needed.                                               |
| `pnpm nx run trinity-e2e-web:production-pwa`    | Build the production Web/PWA host and verify routing, offline shell and crypto WASM without Docker.                                        |
| `pnpm e2e:web`                                  | Run the Web/PWA host plus Docker-backed production-renderer contracts.                                                                     |
| `pnpm smoke:login`                              | Unauthenticated → `/login`, real `.well-known` discovery for matrix.org.                                                                   |
| `pnpm spike:chromium` / `pnpm spike:webkit`     | In-app E2EE crypto spike.                                                                                                                  |
| `pnpm e2e:verify`                               | **Two-client device verification (emoji SAS)** — full live flow against a disposable Synapse.                                              |
| `pnpm e2e:verify:qr`                            | **Two-client QR verification** — production rendering/scanning through a synthetic camera stream against disposable Synapse.               |
| `pnpm e2e:media`                                | **Note-to-self encrypted media send** — pick a file → encrypt → upload → decrypt own echo.                                                 |
| `pnpm e2e:reply`                                | **Reply header + preview** — a reply keeps its own author/avatar even as a same-sender continuation, and renders the quoted reply preview. |
| `pnpm e2e:verify:up` / `pnpm e2e:verify:down`   | Bring the Synapse+Caddy+Dex harness up / tear it down by hand.                                                                             |
| `pnpm nx run trinity-e2e-components:scrollbars` | Run the focused native-scrollbar contract in Chromium, Firefox and WebKit against disposable Synapse.                                      |
| `pnpm e2e:android`                              | Build and install Android, then run every web journey plus native-only journeys in its API 36 WebView.                                     |
| `pnpm electron:e2e`                             | Build and launch Electron, then run desktop shell checks and the image-pack manager journey against disposable Synapse.                    |

The complete ownership model, compatibility policy and local delivery contract are in
[End-to-end test architecture](../docs/contributing/e2e-architecture.md).

Each suite writes standard output, blob, JUnit, local HTML and `suite-summary.json` artifacts under
`dist/.playwright/<project>/<run-id>/<suite-id>/`. Aggregate JSON and Markdown summaries live under
`dist/.playwright/trinity-e2e/<run-id>/<aggregate>/` and group pass, failure, retry, quarantine,
unavailable, skipped-by-tier and not-run outcomes by environment, capability and contract type.

### Remote protocol mode

Synapse-backed protocol targets normally create attempt-scoped accounts on the disposable
support stack. A focused mutating target can explicitly use a remote homeserver instead:

```bash
TRINITY_E2E_PROTOCOL_MODE=remote \
TRINITY_HS=https://matrix.example.test \
TRINITY_USER=protocol-test-user \
TRINITY_PASS=... \
pnpm e2e:verify
```

Remote mode validates the complete credential set before the build, requires an absolute HTTPS
URL without embedded credentials, keeps normal TLS verification enabled, and never copies
password values into annotations, reports or validation errors. It disables Playwright traces so
authenticated request tokens cannot land in artifacts. `e2e:rooms` and `e2e:search`
also require `TRINITY_SECONDARY_USER` and `TRINITY_SECONDARY_PASS`. These are mutating journeys:
use dedicated test accounts and expect rooms, messages, account data and encryption state to be
created. The exhaustive `pnpm e2e:protocol` gate deliberately remains disposable-only.

## Android WebView journeys

`pnpm e2e:android` is an Nx target, but it deliberately owns more than a normal browser
test: the production Android build, one API 36 x86_64 emulator, the Playwright Android
driver, the disposable Synapse stack, and `adb reverse tcp:8448`. Set
`TRINITY_ANDROID_SERIAL` to an already-running dedicated emulator, or create an AVD named
`Trinity_API_36`; the runner never selects an arbitrary attached device. It validates that
the target is an API 36 x86_64 emulator before installing anything.

Prerequisites are JDK 21, Docker, and an Android SDK containing platform tools, the
emulator, Android API 36, and the API 36 Google APIs x86_64 system image. On Linux, the
current user also needs read/write access to `/dev/kvm`; software emulation is too slow for
this suite.

The installed Capacitor app is cleared and relaunched for each test. Every canonical spec
under `e2e/browser/journeys/` imports the shared platform fixture, so Android collects the same
journeys in the package WebView. Platform adapters map browser options, permissions,
preferences, multi-device isolation, and native authentication boundaries without
substituting a desktop browser for the app under test. External FCM notification delivery
encrypted-key export, and the compositor-panning assertion are explicit Android skips until
those environments/product paths exist; they are not replaced with renderer shims that
would create false coverage.
Android-only specs additionally cover hardware Back and process restoration. Caddy's test
certificate is accepted through the attached WebView's DevTools session because
browser-config `ignoreHTTPSErrors` does not change Android WebView policy.

Failures retain a WebView screenshot, whole-device screenshot, Playwright trace, logcat
including the crash buffer, activity state, and package diagnostics under
`dist/.playwright/trinity-e2e-android/<run-id>/android.installed-webview/`. Device validation rejects pre-existing Playwright Android
driver packages; cleanup can therefore remove the run-installed drivers, restore the prior
reverse mapping, and stop only an emulator the runner started.

An explicitly supplied serial must be disposable. The suite clears both Trinity test
package IDs before their tests, replaces their APKs, and clears the device's logcat buffers;
those mutations cannot be restored. It also force-stops Trinity after the run. The exact
pre-run `adb reverse tcp:8448` mapping is restored, and a pre-existing emulator is left
running. The target must provide Chrome for native OIDC/SSO journeys. Their adapter observes both
a newly created Custom Tab page and navigation of a reused tab, which Android may choose for a
second provider launch in the same journey. Pass normal
Playwright arguments after `--`; CI divides the suite with `--shard=N/4` and fails on any
flaky retry. A source-shape guard requires every canonical spec to import the shared
fixture and requires the Android config to collect the canonical glob.

## MSC2545 image-pack management

`support/image-pack-management-journey.mts` is shared by Chromium, the installed
Android WebView, and Electron wrappers. Against disposable Synapse it:

1. creates a public source room with two stable packs and a same-key legacy duplicate;
2. resolves the room alias, joins it through **Find packs**, and lists both stable state keys;
3. installs one exact reference and observes the installed row immediately;
4. on Web/Android, signs the same account into a second isolated app and observes the synced pack
   there;
5. disables and re-enables sticker use, observing the composer update without restarting;
6. labels the installed pack **All rooms** and a current-room pack **This room**;
7. sends the selected image as `m.sticker` and confirms the event through the Matrix API;
8. removes the reference and verifies stable account data is `{ "rooms": {} }`;
9. verifies that uninstall did not delete the publisher's source state; and
10. returns to the room and confirms the account-only sticker action is gone.

The Android collection also asserts the source input and install button reach the 44px
coarse-pointer target. The Web/Android wrapper's isolated second client proves persisted
same-account propagation. Electron runs one shell process because its single-instance lock makes
a second simultaneous app launch unsuitable for that assertion. The journey does not claim atomic
conflict freedom; Matrix account-data writes have no CAS primitive.

Run only this journey on web:

```bash
pnpm nx run trinity-e2e-browser:e2e -- conversations/stickers-custom-emoji.spec.mts
```

Run the same file in the installed Android app:

```bash
pnpm nx run trinity-e2e-android:e2e -- browser/journeys/conversations/stickers-custom-emoji.spec.mts
```

The Android prerequisites and `TRINITY_ANDROID_SERIAL` rules are the same as for the full suite
above.

Run the manager journey in the built Electron shell (use `xvfb-run` on headless Linux):

```bash
xvfb-run -a pnpm electron:e2e image-pack-management.electron.spec.mts
```

## `e2e:media` — encrypted media send round-trip

`protocol/send-media.spec.mjs` creates an **E2EE room** via the CS API, logs into the app as that
user, sets up encryption, opens the room, and picks a 1×1 PNG through the composer's
hidden `<input type="file">` (`[data-testid=composer-file-input]`, driven with
Playwright `setInputFiles` — no native dialog). It then asserts the app renders its
**own** sent attachment: `[data-testid=media-bubble]` reaches `data-media-state="ready"`,
which only happens once the client has uploaded the ciphertext and **downloaded +
decrypted it back** into an `<img>`. One context suffices — a device decrypts the media
it sent itself. The `trinity-e2e-protocol:media` target (run by `pnpm e2e:media`) joins the
support-owned bundled Synapse invocation and relies on its bounded teardown.

## `e2e:verify` — two-client emoji SAS

`protocol/verify-sas.spec.mjs` opens **two browser contexts in one Chromium**. Isolated IndexedDB
⇒ two crypto stores ⇒ two devices of the **same** Matrix user. It then:

1. **Device A** logs in (fresh account, crypto `needs-setup`), goes to
   `/encryption/setup`, sets up encryption (UIA password alert → recovery key →
   "I've saved" → Continue), bootstrapping cross-signing + recovery.
2. **Device B** logs in as the same user (new context ⇒ new device ⇒ `needs-recovery`).
3. **B** starts an SAS verification at `/encryption/verify` (`[data-testid=verify-start]`).
4. **A** auto-pops the incoming-request modal (`VerificationHostComponent`); the runner
   clicks `[data-testid=verify-accept]`.
5. One side clicks `[data-testid=verify-start-sas]`.
6. Both reach `[data-testid=verify-page][data-stage="sas-shown"]`; the runner reads
   `.emoji__name` on **both** contexts and **asserts the seven emoji are identical**,
   then clicks `[data-testid=sas-match]` on **A only**.
7. **A now waits on B** — the runner asserts A shows `[data-testid=sas-waiting]` (spinner +
   `aria-live`), that A's `sas-match`/`sas-mismatch` are gone and its emoji are not, and
   that **B is still asking** (its `sas-match` visible, no `sas-waiting`). This is the
   half-confirmed window; only a two-device run can observe it. Then B clicks
   `[data-testid=sas-match]`.
8. Both reach `[data-testid=verify-page][data-stage="done"]`, with `sas-waiting` gone
   → `RESULT: PASS`.

The runner synchronises the two contexts off the live `data-stage` attribute
(`idle|requested|ready|waiting|sas-shown|done|cancelled`) via `waitForFunction` —
no fixed sleeps.

### Run it (bundled Synapse harness)

Requires **Docker** able to pull `matrixdotorg/synapse`, `caddy` and `ghcr.io/dexidp/dex`.

```bash
pnpm e2e:verify
```

This builds the dev bundle and runs the ordinary Playwright Test spec through
`trinity-e2e-protocol:verify-sas`. The support owner starts `e2e/support/synapse/`, the fixture
registers an attempt-scoped test user, and the invocation performs bounded teardown even on failure.

Debugging:

```bash
HEADED=1 SLOWMO=100 pnpm e2e:verify        # watch it run
pnpm e2e:verify:up                          # leave the HS up
pnpm e2e:verify:down                         # tear down
```

Direct spec execution is unsupported because it would bypass dynamic endpoint, lock,
cancellation and teardown ownership. Use the Nx/package target, including for remote mode.

## `e2e:verify:qr` — two-client QR reciprocation

`protocol/verify-qr.spec.mjs` performs the same two-context account and encryption setup, then has
Device A explicitly reveal the SDK's binary QR payload. Device B scans that exact image
through the production camera component and decoder. The camera input is a canvas-backed
`MediaStream`, so the run needs no physical hardware while still exercising QR rendering,
raw-byte decoding, `scanQRCode()`, reciprocation confirmation, and both clients reaching
`done`. It also asserts that scanning alone does not claim success and that the displayed
code is removed once consumed.

```bash
pnpm e2e:verify:qr
```

The QR and SAS targets request the same support-owned disposable Synapse resource and therefore
run sequentially.

### Homeserver-free self-check

```bash
pnpm nx run trinity-e2e-protocol:verify-sas-selfcheck
```

Validates everything that does **not** need a homeserver: the build serves, the SPA
boots, `/login` renders the homeserver input + Continue, the form reacts (real
matrix.org discovery surfaces an authentication path), and the guarded
`/encryption/verify` route resolves. Does **not** assert the SAS flow.

## The Synapse harness (`e2e/support/synapse/`)

Disposable, self-contained:

- **`docker-compose.yml`** — Synapse (HTTP `:8008`) + Caddy (TLS `:8448`) + Dex
  (OIDC, HTTP `:5556`).
- **`Caddyfile`** — terminates TLS with Caddy's **internal self-signed CA**, serves
  `/.well-known/matrix/client` pointing `m.homeserver.base_url` at
  `https://localhost:8448`, and reverse-proxies the Matrix API to Synapse.
- **`dex.yaml`** — a throwaway identity provider, wired into Synapse as an
  `oidc_provider` so the suite can hold accounts with **no Matrix password**. That is
  the only way to drive the paths Trinity takes when a homeserver refuses a password for
  a privileged action; see docs/contributing/testing.md for why it is legacy SSO and not MSC3861.
  It declares **two** static identities (`sso-e2e`, `sso-reset-e2e`) — one per spec file,
  because the list is fixed at container start (no per-test identity is possible) and the
  reset spec seeds state on its account that cannot be undone.
- **`start.mjs`** — generates + patches `homeserver.yaml` (registration shared
  secret, `public_baseurl`, relaxed rate limits, the Dex provider + SSO redirect
  whitelist), brings the stack up, **restarts Synapse when the config it is already
  running with is not the one just rendered** (the config is a bind mount, so
  `compose up -d` alone would leave a warm stack serving the previous run's OIDC block),
  registers the test user via `register_new_matrix_user`, and waits for the TLS
  well-known, Dex's discovery document and Synapse's own `m.login.sso` flow.
- **`stop.mjs`** — `docker compose down -v` and removes generated `./data`.

**Why TLS + well-known:** the shipped `apps/trinity/src/index.html` CSP allows only
`https:`/`wss:` for `connect-src`, and matrix-js-sdk `AutoDiscovery.findClientConfig`
fetches `https://<domain>/.well-known/matrix/client`. The contexts launch with
`ignoreHTTPSErrors: true` to accept Caddy's self-signed cert. **No change to
`index.html` was needed.**

`e2e/support/synapse/data/` and `e2e/.artifacts/` (failure screenshots) are git-ignored.

## Verification status

The full live `e2e:verify` round-trip has been **run to PASS** (2026-06-27) against
the bundled harness — `matrixdotorg/synapse:v1.119.0` + `caddy:2.8-alpine` under
Docker. Both contexts logged in, Device A bootstrapped encryption, the two devices
showed the **same seven emoji** (asserted identical across both contexts), both
confirmed the match and reached `data-stage="done"`, and the harness tore itself
down. The other harnesses also pass in the same 2026-06-27 environment (each run on
its own) — `smoke:login`, `spike:chromium`, `spike:webkit`, the homeserver-free
`verify-sas-selfcheck`, and **`e2e:media`** (the encrypted media send round-trip:
upload → decrypt own echo) each print `RESULT: PASS` — and `pnpm test` (Vitest) is
green across all projects.

`e2e:verify` **requires Docker** able to run those images. Where Docker or registry
access is unavailable, fall back to the homeserver-free self-check
(`pnpm nx run trinity-e2e-protocol:verify-sas-selfcheck` → `RESULT: PASS`), which still covers the dev
build serving, the SPA booting, `/login` + discovery + an authentication path, and the
guarded `/encryption/verify` route — everything except the live SAS exchange.

The live `e2e:verify:qr` round-trip was run to **PASS** on 2026-08-26. The synthetic
camera decoded Device A's production GIF, Device A withheld reciprocation until the
explicit confirmation, and both devices then reached `done`.
