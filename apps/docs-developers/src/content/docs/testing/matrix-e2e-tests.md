---
title: Matrix E2E tests
description: Run disposable-Synapse journeys for protocol, encryption, and multi-client behavior.
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

The suite owns disposable Synapse state, test users, browser contexts, and teardown. Do not point it at a personal or shared homeserver.

## Focus a journey {#focus-journey}

```bash
pnpm nx run trinity-e2e-browser:e2e -- conversations/message-links.spec.mts
pnpm nx run trinity-e2e-browser:e2e -- --grep "message link"
pnpm e2e:verify
```

Prefer a registered focused target when one exists. Test through public Matrix behavior and user-visible results; avoid replacing the protocol interaction with a mock when interoperability is the claim.

## Protect shared resources {#shared-resources}

Synapse-backed targets share fixed ports and state. Run them sequentially. Use the aggregate targets when several suites are required because the aggregate owns safe ordering and cleanup.

Each test owns its generated users, rooms, devices, and events. Use unique identifiers supplied by the fixture layer and clean resources through suite teardown. Never log access tokens, recovery keys, private messages, or raw secret-bearing responses.

A server, browser, or Docker preflight failure is not a passing skipped test. Record it as failed or unavailable and inspect retained diagnostics before retrying.

Read [Matrix features](../../development/matrix-features/) and [diagnose failures](../diagnose-failures/).
