---
name: sas-verification-e2e
description: Two-client emoji-SAS device verification e2e — flow, selectors, and the Synapse harness
metadata:
  type: project
---

The two-device emoji-SAS verification e2e lives in `e2e/verify-sas.mjs`
(orchestrated by `e2e/verify-sas-run.mjs`, script `pnpm e2e:verify`). A homeserver-free
selftest is `e2e/verify-sas-selfcheck.mjs`. See [[e2e-conventions]] for the raw-playwright style.

**Two devices = two `browser.newContext()`** in one Chromium (isolated IndexedDB ⇒
two crypto stores ⇒ two device IDs of the SAME Matrix user).

**Flow & selectors (verified against templates):**
- Login: `/login`, fill `ion-input[label="Homeserver"]`, click `getByText('Continue',{exact:true})`,
  fill Username + Password ion-inputs, `getByRole('button',{name:'Sign in'})` → navigates to **`/rooms`**
  (login does NOT auto-route to setup).
- Encryption setup: navigate to `/encryption/setup`; `getByRole('button',{name:'Set up encryption'})`;
  UIA `ion-alert` password → fill `input[type=password]` + `Confirm`; recovery key at `code.key`;
  tick `getByRole('checkbox',{name:/I've saved my recovery key/})`; `Continue to Trinity`.
- Verify: `[data-testid=verify-start]`, `verify-accept`, `verify-start-sas`, `sas-match`,
  `sas-mismatch`. Stage attribute lives on `<ion-content data-testid="verify-page" data-stage>`
  with values `idle|requested|ready|waiting|sas-shown|done|cancelled` — sync the two contexts off it
  via `waitForFunction`. The 7 emoji names are `.emoji__name`.
- Incoming request auto-pops a modal on the OTHER device via `VerificationHostComponent`
  (reuses `DeviceVerificationPage` as modal content, same testids, same DOM — not an iframe).

**Homeserver requirement (the hard part):** app CSP (`apps/trinity/src/index.html`) only allows
`https:`/`wss:` for `connect-src`, and `AutoDiscovery.findClientConfig` fetches
`https://<domain>/.well-known/matrix/client`. The harness (`e2e/synapse/`) runs Synapse on HTTP
`:8008` behind **Caddy** TLS `:8448` (Caddy `tls internal` self-signed CA) which serves the
well-known and reverse-proxies the API. Contexts launch with `ignoreHTTPSErrors: true`.
**No `index.html` change was needed.** Test user registered via `register_new_matrix_user`
(shared secret). Runner is env-parameterised: `TRINITY_HS`/`TRINITY_USER`/`TRINITY_PASS`.

**Environment caveat:** Running `pnpm e2e:verify` needs Docker able to PULL
`matrixdotorg/synapse` + `caddy` images. In a sandbox where registry pulls are denied,
the live round-trip can't run — fall back to `node e2e/verify-sas-selfcheck.mjs` (passes
without a homeserver) and/or point `TRINITY_HS` at an existing https homeserver.
