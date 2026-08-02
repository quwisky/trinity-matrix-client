# Trinity e2e

> **Two e2e systems, one `e2e/` root.** App-level user journeys (login, settings,
> theme, profile, devices) are **`@nx/playwright` specs** in `e2e/playwright/`
> (web) and `e2e/electron/` (desktop) — run the web suite with
> `pnpm exec nx e2e trinity` (`@playwright/test`, Chromium; it builds the dev
> bundle, serves `www/`, and spins the Synapse harness below up/down via global
> setup, skipping auth specs when Docker is absent locally — under `CI` a missing
> harness fails the run instead, unless `TRINITY_E2E_ALLOW_NO_SYNAPSE=1`) and the desktop suite with
> `pnpm electron:e2e`. The `features/` + `runners/` scripts are specialised
> crypto/protocol drivers (E2EE spike, two-client SAS verification, encrypted
> media, emoji composer) kept as raw `playwright` Node harnesses. All of it reuses
> the same disposable Synapse (`e2e/synapse/`).
>
> The Playwright **configs stay at `apps/trinity/`** (`playwright.config.mts`,
> `playwright.electron.config.mts`) so Nx keeps inferring the `e2e` target on the
> `trinity` project; their `testDir` points back here at `../../e2e/{playwright,electron}`.

Build the dev bundle first (`pnpm nx build trinity --configuration=development`),
which the `pnpm` wrappers below do for you.

> On a **containerised CI runner** (a job container talking to a separate Docker
> daemon), set `TRINITY_E2E_STATE_DIR` and `TRINITY_E2E_NETWORK_CONTAINER` — bind
> mounts and published ports are both resolved by the daemon, not by the job. See
> `e2e/synapse/paths.mjs` and docs/contributing/testing.md.

## Layout

```
e2e/
  features/   raw-playwright test bodies — what each scenario drives in the browser
              (emoji, rooms, search, spaces, threads, send-media, verify-sas, …)
  runners/    Synapse orchestrators — start the harness, spawn one feature body
              with the HS env, tear the harness down (the `pnpm e2e:*` entrypoints)
  playwright/ @nx/playwright web app-journey specs (app, navigation, settings) +
              support/ (global-setup/teardown, serve-www) — `nx e2e trinity`
  electron/   @nx/playwright Electron specs + support/launch — `pnpm electron:e2e`
  support/    shared helpers (e.g. serve.mjs — static file server for www/)
  synapse/    the disposable Synapse + Caddy + Dex harness (docker-compose, start/stop;
              dex.yaml is the throwaway identity provider — see docs/contributing/testing.md)
```

A `features/` body can be run on its own against an already-running homeserver
(set `TRINITY_HS`/`TRINITY_USER`/`TRINITY_PASS`); a runner just wraps it with the
disposable Synapse. Paths are relative to the repo root, so always invoke via the
`pnpm` scripts (or `node e2e/runners/<x>-run.mjs`) from there.

## Scripts

| Command                                       | What it does                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm smoke:login`                            | Unauthenticated → `/login`, real `.well-known` discovery for matrix.org.                                                                   |
| `pnpm spike:chromium` / `pnpm spike:webkit`   | In-app E2EE crypto spike.                                                                                                                  |
| `pnpm e2e:verify`                             | **Two-client device verification (emoji SAS)** — full live flow against a disposable Synapse.                                              |
| `pnpm e2e:media`                              | **Note-to-self encrypted media send** — pick a file → encrypt → upload → decrypt own echo.                                                 |
| `pnpm e2e:reply`                              | **Reply header + preview** — a reply keeps its own author/avatar even as a same-sender continuation, and renders the quoted reply preview. |
| `pnpm e2e:verify:up` / `pnpm e2e:verify:down` | Bring the Synapse+Caddy+Dex harness up / tear it down by hand.                                                                             |

## `e2e:media` — encrypted media send round-trip

`send-media.mjs` creates an **E2EE room** via the CS API, logs into the app as that
user, sets up encryption, opens the room, and picks a 1×1 PNG through the composer's
hidden `<input type="file">` (`[data-testid=composer-file-input]`, driven with
Playwright `setInputFiles` — no native dialog). It then asserts the app renders its
**own** sent attachment: `[data-testid=media-bubble]` reaches `data-media-state="ready"`,
which only happens once the client has uploaded the ciphertext and **downloaded +
decrypted it back** into an `<img>`. One context suffices — a device decrypts the media
it sent itself. `send-media-run.mjs` (run by `pnpm e2e:media`) brings the bundled Synapse
harness up, runs it, and tears it down.

## `e2e:verify` — two-client emoji SAS

`verify-sas.mjs` opens **two browser contexts in one Chromium**. Isolated IndexedDB
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

This builds the dev bundle, runs `verify-sas-run.mjs` which: starts the harness
(`e2e/synapse/`), registers the test user, runs `features/verify-sas.mjs`, and tears the
harness down (`docker compose down -v` + removes `e2e/synapse/data`) — even on failure.

Debugging:

```bash
HEADED=1 SLOWMO=100 pnpm e2e:verify        # watch it run
pnpm e2e:verify:up                          # leave the HS up
TRINITY_HS=https://localhost:8448 TRINITY_USER=verify-e2e TRINITY_PASS=verify-e2e-pass-123 \
  node e2e/features/verify-sas.mjs                    # iterate the runner against it
pnpm e2e:verify:down                         # tear down
```

### Run against your own homeserver

`verify-sas.mjs` is parameterised by env, so it runs against any HS that supports
password login + E2EE and is reachable over **https** (the app CSP only allows
`https:`/`wss:` for `connect-src`):

```bash
TRINITY_HS=https://your.hs \
TRINITY_USER=alice \
TRINITY_PASS=… \
  node e2e/features/verify-sas.mjs
```

The account must be allowed to set up encryption fresh (the runner does the
`/encryption/setup` bootstrap on Device A).

### Homeserver-free self-check

```bash
node e2e/features/verify-sas-selfcheck.mjs
```

Validates everything that does **not** need a homeserver: the build serves, the SPA
boots, `/login` renders the homeserver input + Continue, the form reacts (real
matrix.org discovery surfaces the password form), and the guarded
`/encryption/verify` route resolves. Does **not** assert the SAS flow.

## The Synapse harness (`e2e/synapse/`)

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

`e2e/synapse/data/` and `e2e/.artifacts/` (failure screenshots) are git-ignored.

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
(`node e2e/features/verify-sas-selfcheck.mjs` → `RESULT: PASS`), which still covers the dev
build serving, the SPA booting, `/login` + discovery + the password form, and the
guarded `/encryption/verify` route — everything except the live SAS exchange.
