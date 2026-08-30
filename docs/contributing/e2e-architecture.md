# End-to-end test architecture

Trinity's system-level tests use an environment-first execution model. The environment owns
processes, prerequisites, serialization and artifacts; product capabilities classify journeys
inside that lifecycle. This prevents a folder name such as `playwright` from accidentally becoming
the owner of Android, Electron, Synapse or component-browser support.

The migration is intentionally incremental. The typed registry locks both the current executable
surface and its destination before later changes move files or replace raw protocol runners.

## Executable registry

[`e2e/registry/index.mts`](../../e2e/registry/index.mts) is the public registry entrypoint. It
combines lifecycle-specific suite declarations with package-command, CI, serialization, timeout,
artifact and quarantine contracts. `pnpm architecture:check` runs the validator, and the scripts
test project mutation-tests its refusal paths.

Every suite declares:

- a stable id, current Nx target and destination Nx project;
- environment, capability and contract annotations;
- required browsers, Docker, network, Electron, Xvfb or Android AVD;
- pull-request, scheduled or local-only classification;
- non-cacheable runtime policy and any exclusive serialization resources;
- timeout class, canonical package command and current/target artifact roots;
- the source config or runner entrypoints it owns.

The validator fails on missing or multiply-owned entrypoints, unregistered or drifting targets,
command drift, cacheable E2E results, undefined serialization ownership, missing annotations or
prerequisites, stale spec counts, unclassified CI commands and expired quarantine. A quarantine
entry must name its suite, issue, owner, reason, expiry date and excluded tier. Quarantine removes
the suite only from that tier; the exhaustive local `e2e:all` selection continues to run it.

Inspect the current selection without starting browsers or external services:

```bash
node scripts/e2e-suite-registry.mjs list e2e-pr
node scripts/e2e-suite-registry.mjs list e2e-all
node scripts/e2e-suite-registry.mjs check
```

The registry validates Nx's resolved project graph, not only authored `project.json` files. Nx
Playwright atomization is disabled because each inferred per-spec target would otherwise start and
cache work against the same fixed-port Synapse stack. The one resolved canonical target remains
serialized and uncached.

CI tiers have executable meanings:

| Tier           | Contract                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------- |
| `pull-request` | Appears exactly once in the checked-in CI command registry and runs in the current workflow |
| `scheduled`    | Excluded from pull-request CI; included by exhaustive local and future scheduled selection  |
| `local-only`   | Excluded from CI; included by exhaustive local or its environment selection                 |

The current pull-request tier contains the canonical browser and shipped-interface suites,
Storybook, styling, full Electron, QR verification and Android. Production Web/PWA, Electron smoke
and SAS verification remain local-only; the remaining protocol and cross-browser scrollbar suites
are scheduled. Changing a tier without changing its CI command classification fails validation.

## Canonical commands

| Command               | Selection                                                                             |
| --------------------- | ------------------------------------------------------------------------------------- |
| `pnpm e2e`            | Pull-request-classified suites                                                        |
| `pnpm e2e:all`        | Every registered suite available on this host                                         |
| `pnpm e2e:browser`    | Canonical Synapse browser journeys and shipped-interface evidence                     |
| `pnpm e2e:web`        | Production Web/PWA host contract                                                      |
| `pnpm e2e:components` | Storybook, styling and cross-browser scrollbar contracts                              |
| `pnpm e2e:protocol`   | Verification, crypto, media, relation, room, search and emoji protocol/system drivers |
| `pnpm e2e:electron`   | Docker-independent shell smoke plus the full Synapse-backed Electron journey          |
| `pnpm e2e:android`    | Installed API 36 WebView journeys                                                     |

Every canonical aggregate is an uncached, serialized Nx target. It validates the registry and all
selected prerequisites before starting the first suite, then stops at the first failed suite.
Docker and the Android AVD are required for the local delivery gate. On headless Linux the
aggregate wraps Electron targets with `xvfb-run`.

The older focused package commands remain behavior-compatible Nx aliases for one release after
the lifecycle migration completes. Removing an alias requires a released changelog entry, no
repository or CI references, documented replacement and one full release cycle without migration
reports.

## Lifecycle destination

Later tickets split the current mixed `trinity-e2e` project into these owners without changing
assertions:

| Project                  | Owns                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| `trinity-e2e-support`    | Processes, dynamic ports, Synapse session, APIs, resource builders and reporting |
| `trinity-e2e-browser`    | Canonical application journeys, grouped by durable product capability            |
| `trinity-e2e-protocol`   | Verification, crypto and Matrix protocol/system drivers                          |
| `trinity-e2e-web`        | Production Web/PWA host behavior                                                 |
| `trinity-e2e-electron`   | Launched desktop shell and full Electron journeys                                |
| `trinity-e2e-android`    | Installed Capacitor WebView and Android-only journeys                            |
| `trinity-e2e-components` | Storybook component-browser, styling and scrollbar contracts                     |

Environment fixtures may depend on `trinity-e2e-support`; they must not import another
environment's fixture implementation. Playwright configurations stay small and lifecycle-specific
instead of becoming one mega-config.

## Local delivery evidence

Focused checks are appropriate while iterating. Before each migration pull request, and after a
review change affecting behavior or tests, run the repository quality gates plus `pnpm e2e:all`.
Record exact commands and exit statuses in the pull request. The local Linux host must exercise
Docker/Synapse, Web/PWA, Electron and the Android AVD. It can run only static iOS/shared-renderer
verification; absence of an Xcode run is recorded as unavailable, never passed.

Existing GitHub workflows remain declared and their current commands are registry-classified.
Unavailable Actions capacity is not validation evidence and is not a reason to weaken workflow or
branch safeguards.

All reports, traces, screenshots, videos and session descriptors stay in ignored output. Review
proof may be attached to a pull request, but none of those artifacts belongs in version control.
