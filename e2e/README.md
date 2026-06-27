# Trinity e2e

Standalone Node ESM e2e scripts (raw `playwright`, **not** `@playwright/test`).
Each script serves the dev build from `www/` with `support/serve.mjs` and drives
Chromium. Build the dev bundle first (`pnpm nx build trinity --configuration=development`),
which the `pnpm` wrappers below do for you.

## Scripts

| Command                                       | What it does                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm smoke:login`                            | Unauthenticated → `/login`, real `.well-known` discovery for matrix.org.                      |
| `pnpm spike:chromium` / `pnpm spike:webkit`   | In-app E2EE crypto spike.                                                                     |
| `pnpm e2e:verify`                             | **Two-client device verification (emoji SAS)** — full live flow against a disposable Synapse. |
| `pnpm e2e:verify:up` / `pnpm e2e:verify:down` | Bring the Synapse+Caddy harness up / tear it down by hand.                                    |

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
   then clicks `[data-testid=sas-match]` on both.
7. Both reach `[data-testid=verify-page][data-stage="done"]` → `RESULT: PASS`.

The runner synchronises the two contexts off the live `data-stage` attribute
(`idle|requested|ready|waiting|sas-shown|done|cancelled`) via `waitForFunction` —
no fixed sleeps.

### Run it (bundled Synapse harness)

Requires **Docker** able to pull `matrixdotorg/synapse` and `caddy`.

```bash
pnpm e2e:verify
```

This builds the dev bundle, runs `verify-sas-run.mjs` which: starts the harness
(`e2e/synapse/`), registers the test user, runs `verify-sas.mjs`, and tears the
harness down (`docker compose down -v` + removes `e2e/synapse/data`) — even on failure.

Debugging:

```bash
HEADED=1 SLOWMO=100 pnpm e2e:verify        # watch it run
pnpm e2e:verify:up                          # leave the HS up
TRINITY_HS=https://localhost:8448 TRINITY_USER=verify-e2e TRINITY_PASS=verify-e2e-pass-123 \
  node e2e/verify-sas.mjs                    # iterate the runner against it
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
  node e2e/verify-sas.mjs
```

The account must be allowed to set up encryption fresh (the runner does the
`/encryption/setup` bootstrap on Device A).

### Homeserver-free self-check

```bash
node e2e/verify-sas-selfcheck.mjs
```

Validates everything that does **not** need a homeserver: the build serves, the SPA
boots, `/login` renders the homeserver input + Continue, the form reacts (real
matrix.org discovery surfaces the password form), and the guarded
`/encryption/verify` route resolves. Does **not** assert the SAS flow.

## The Synapse harness (`e2e/synapse/`)

Disposable, self-contained:

- **`docker-compose.yml`** — Synapse (HTTP `:8008`) + Caddy (TLS `:8448`).
- **`Caddyfile`** — terminates TLS with Caddy's **internal self-signed CA**, serves
  `/.well-known/matrix/client` pointing `m.homeserver.base_url` at
  `https://localhost:8448`, and reverse-proxies the Matrix API to Synapse.
- **`start.mjs`** — generates + patches `homeserver.yaml` (registration shared
  secret, `public_baseurl`, relaxed rate limits), brings the stack up, registers the
  test user via `register_new_matrix_user`, waits for the TLS well-known.
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
its own) — `smoke:login`, `spike:chromium`, `spike:webkit`, and the homeserver-free
`verify-sas-selfcheck` each print `RESULT: PASS` — and `pnpm test` (Vitest) is green
across all projects.

`e2e:verify` **requires Docker** able to run those images. Where Docker or registry
access is unavailable, fall back to the homeserver-free self-check
(`node e2e/verify-sas-selfcheck.mjs` → `RESULT: PASS`), which still covers the dev
build serving, the SPA booting, `/login` + discovery + the password form, and the
guarded `/encryption/verify` route — everything except the live SAS exchange.
