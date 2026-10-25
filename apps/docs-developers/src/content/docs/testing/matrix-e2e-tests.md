---
title: Matrix E2E tests
description: Run disposable-homeserver journeys for protocol, encryption, and multi-client behavior.
audience: developer
contentChannel: develop
canonicalTopic: testing-matrix-e2e
pageType: how-to
platforms: [web]
---

Use Matrix E2E tests when the claim depends on a real homeserver, `/sync`, event ordering, encryption, device verification, or interaction between accounts and clients.

## Prepare the environment {#prepare-environment}

Docker must be available to the current user, and the selected Playwright browsers must be installed:

```bash
pnpm exec playwright install chromium webkit
pnpm e2e:browser
```

The suite owns disposable homeserver state, test users, browser contexts, and teardown. Do not point it at a personal or shared homeserver.

## Choose the homeserver {#choose-homeserver}

The suites run against [Tuwunel](https://github.com/matrix-construct/tuwunel) by default. Set `TRINITY_E2E_HOMESERVER=synapse` to run the same suites against Synapse:

```bash
TRINITY_E2E_HOMESERVER=synapse pnpm e2e:browser
TRINITY_E2E_HOMESERVER=synapse pnpm e2e:protocol
```

Only `tuwunel`, `synapse` and `tuwunel-oauth` are accepted; any other value fails before Docker starts. `tuwunel-oauth` is Tuwunel with its built-in OAuth server and QR sign-in (MSC4108) instead of Dex SSO, so its session lists `sso` as unavailable. The MAS stack also serves QR sign-in. `TRINITY_E2E_QR_PROBE=1 pnpm exec vitest run --config e2e/support/vitest.config.mts homeserver/qr-sign-in-capability` checks both servers; run it after changing homeserver configuration. The stack lives in `e2e/support/homeserver/`: Dex, Mailpit, Caddy and the driver are shared, and each server has an adapter directory with its compose services and configuration. Tuwunel is pinned by version and image digest in `tuwunel/docker-compose.yml`; update both together and never use `latest`. Stopping the stack deletes every homeserver database, because a Tuwunel database is bound to its server name for life. Synapse sends its email-validation links to Mailpit, whose API on `127.0.0.1:8025` the email journeys read; Tuwunel sends no email, so its session lists `mail` as unavailable and those journeys skip. The Synapse stack also runs Sydent as its identity server at `https://localhost:8452` (`IDENTITY_SERVER_URL`), sending its validation mail to Mailpit; Tuwunel's session lists `identity` as unavailable.

Set `TRINITY_E2E_HOMESERVER_RUNTIME=native` (with `TRINITY_E2E_HOMESERVER=synapse`) on a host without Docker. The harness then installs the pinned Synapse into a `native-venv` under the state directory (default `e2e/support/homeserver/native-venv`, or under `TRINITY_E2E_STATE_DIR` when set) with the host's `python3` (new enough for the pinned Synapse; the system Python 3.9 on macOS is too old) and runs it and `caddy` from `PATH` as background processes, recorded in a PID file that `pnpm e2e:verify:down` uses. The native runtime serves only the primary server, so the federated secondary server is unavailable and the session descriptor lists it under `unavailable`. SSO is available when a `dex` binary is on `PATH` (`brew install dexidp` on macOS): the harness then runs Dex from the shared `dex.yaml` on `127.0.0.1:5556` and installs Synapse with its `oidc` extra. Without Dex, `sso` is listed as unavailable too and the SSO journeys skip. Likewise, mail is available when a `mailpit` binary is on `PATH` (`brew install mailpit`), which the harness runs on `127.0.0.1:8025` (HTTP) and `127.0.0.1:1025` (SMTP); without it `mail` is listed as unavailable and the email journeys skip. With mail, the harness also installs the pinned Sydent into its own `native-sydent-venv` beside `native-venv` and runs it on `127.0.0.1:8090` behind Caddy; if it does not install or become ready, `identity` is listed as unavailable and the rest of the stack still starts. The iOS suite uses it because the macOS runner has no Docker; with `TRINITY_E2E_SSO_PROVIDER=mock`, which the iOS nightly sets, Dex adds its form-free `mockCallback` connector and the iOS SSO spec signs in as Dex's fixed mock identity. Without it the iOS SSO spec skips, and browser journeys always fill Dex's password form, so don't set it for a run shared with them. Android's SSO spec only checks that the sign-in page explains legacy SSO isn't offered in the app. Caddy 2.11.4 must be on `PATH`. On Debian/Ubuntu, `python3 -m venv` needs the `python3-venv` package (ensurepip), or create the venv with `uv`. Delete `native-venv` to force a reinstall of Synapse.

Pull requests run against Tuwunel. The `E2E (Synapse nightly)` workflow runs the browser, Electron full and protocol suites against Synapse every day at 02:47 UTC and on demand.

When the two servers legitimately differ, branch the expectation on `homeserverSession().kind` and keep both expectations. Never delete the Synapse expectation to make Tuwunel pass.

Tuwunel 1.9.3 can wake a waiting `/sync` that has a new state event in its timeline but still has the previous state in MSC4222 `state_after`. The SDK follows `state_after`, so the app keeps the old state. A spec that changes room state while the app is syncing must not let a waiting sync see the write. Wrap such a write in `withSyncFence` from `e2e/support/sync-fence.mts`.

## Run the MAS journeys {#mas-journeys}

`e2e/browser/journeys/accounts/mas-session.spec.mts` signs in, refreshes and signs out against a real [Matrix Authentication Service](https://element-hq.github.io/matrix-authentication-service/) (MAS). It needs the opt-in MAS stack, which `TRINITY_E2E_MAS=1` adds to the disposable stack. Without it the tests skip.

```bash
TRINITY_E2E_MAS=1 pnpm nx run trinity-e2e-browser:e2e -- accounts/mas-session.spec.mts
```

The stack (`e2e/support/homeserver/mas/`) runs MAS 1.26.0, its PostgreSQL and a third Synapse that delegates authentication to MAS, behind Caddy on `https://localhost:8450` (homeserver) and `https://localhost:8451` (MAS). Delegation turns password login off for the whole server, so it cannot replace the primary homeserver. MAS issues 60-second access tokens, the minimum its configuration schema allows, so the refresh test waits through two real expiries and takes about three minutes; the whole file takes about six minutes on two workers. MAS always rotates refresh tokens, so a provider that does not is covered only by the unit tests in `matrix-client.oauth-refresh.spec.ts`. The stack needs Docker with published ports: the native runtime and `TRINITY_E2E_NETWORK_CONTAINER` refuse it.

CI runs the journeys in two places. The `E2E (Synapse nightly)` workflow runs them every night in its `Browser E2E (MAS)` job. A pull request runs them in its `E2E browser journeys (MAS)` job when it changes sign-in code (`libs/data-access/auth`, `libs/data-access/matrix-client`, `libs/data-access/accounts`, `libs/feature/auth`, the session and secure storage services, the session model or the factory reset's capability wiring), the `matrix-js-sdk` version or its patch, or the MAS stack and journeys; every other pull request skips that job.

## The new-device check in journeys {#new-device-check}

A sign-in that creates a new device for an account with a cross-signing identity opens the new-device check (`/encryption/confirm`) before Rooms. Browser and protocol journeys run the development build, whose check offers "Skip for now (debug build)". `login()`, `addAccountViaUi()`, `ssoLogin()`, `signInWithMas()` and the protocol suite's sign-in call `settleSignIn()`, which takes that skip by default, so a journey that signs a second device into such an account continues with an unverified device. Pass `'expect'` to stop on the check, or `'forbid'` to fail if it appears. `publishIdentityWithoutRecovery()` in `e2e/support/cross-signing.mts` gives a throwaway account an identity with no recovery, and `setUpEncryption()` in `e2e/browser/support/encryption-journey.mts` sets up recovery from the app. The shared harness account has no identity, so journeys that sign it in never meet the check. The production renderer suite runs the release build, which never offers the skip; its accounts have no identity.

## Focus a journey {#focus-journey}

```bash
pnpm nx run trinity-e2e-browser:e2e -- conversations/message-links.spec.mts
pnpm nx run trinity-e2e-browser:e2e -- --grep "message link"
pnpm e2e:verify
```

Prefer a registered focused target when one exists. Test through public Matrix behavior and user-visible results; avoid replacing the protocol interaction with a mock when interoperability is the claim.

## Protect shared resources {#shared-resources}

Homeserver-backed targets share fixed ports and state. Run them sequentially. Use the aggregate targets when several suites are required because the aggregate owns safe ordering and cleanup.

Each test owns its generated users, rooms, devices, and events. Use unique identifiers supplied by the fixture layer and clean resources through suite teardown. Never log access tokens, recovery keys, private messages, or raw secret-bearing responses.

A server, browser, or Docker preflight failure is not a passing skipped test. Record it as failed or unavailable and inspect retained diagnostics before retrying.

Read [Matrix features](../../development/matrix-features/) and [diagnose failures](../diagnose-failures/).
