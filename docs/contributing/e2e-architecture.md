# End-to-end test architecture

Trinity's end-to-end suite is organized by execution environment, then by product
capability. Each journey runs against the host and resources it needs without letting
independently started tests contend for the same application, emulator, or homeserver.

[Commands](commands.md#end-to-end-and-protocol-checks) is the canonical command list.
[`e2e/README.md`](../../e2e/README.md) routes a task to the right environment.

## Executable registry

`e2e/registry/index.mts` is the executable inventory. It describes each suite's Nx
project, prerequisites, CI tier, cache policy, serialization, source entrypoints, and
artifact location. `pnpm architecture:check` validates that registry alongside the
other repository contracts.

| Environment                | Owning project           | What it observes                                                                    |
| -------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| Canonical browser journeys | `trinity-e2e-browser`    | Product workflows in Chromium against disposable Synapse                            |
| Web/PWA                    | `trinity-e2e-web`        | Production routing, manifest, service worker, offline shell, and renderer contracts |
| Components                 | `trinity-e2e-components` | Storybook, styling, accessibility, and scrollbar contracts                          |
| Protocol                   | `trinity-e2e-protocol`   | Verification, crypto, media, rooms, search, and Matrix round trips                  |
| Android                    | `trinity-e2e-android`    | Production Capacitor app in an installed WebView                                    |
| Electron                   | `trinity-e2e-electron`   | Launched desktop shell behavior                                                     |
| Shared support             | `trinity-e2e-support`    | Invocation lifecycle, reports, servers, and disposable services                     |

Do not infer a project target from a directory. Inspect it first with
`pnpm nx show project <name> --json`.

A registry entry declares its stable target, environment/capability/contract annotations,
prerequisites, CI tier, timeout, artifact root, serialization key, cache policy, and source
entrypoint. Validation rejects command drift, unregistered or multiply owned entrypoints,
cacheable E2E results, absent prerequisites or serialization, stale catalog counts, and expired
quarantine. Inspect the selected registry without launching a host:

```bash
node scripts/e2e-suite-registry.mjs list e2e-pr
node scripts/e2e-suite-registry.mjs list e2e-all
node scripts/e2e-suite-registry.mjs check
```

## Lifecycle and resource ownership

A lifecycle target owns the complete invocation: it selects a build, acquires locks,
starts and tears down services, gives children scoped credentials, and writes ignored
diagnostics. Children join that invocation; they do not launch fallback servers or
homeservers.

Synapse-backed browser, protocol, Android, and production-renderer work shares a
fixed-port disposable stack. All E2E aggregates and lifecycle targets are uncached and serialized.
Run Synapse-backed commands strictly sequentially. Aggregate targets coordinate safe ordering;
launching two focused commands at once can make both results unreliable. Nx per-spec atomization
is disabled for this reason.

The support stack includes Synapse, a federation peer, Caddy, and Dex. Docker is a hard
prerequisite for suites that declare it. The owner creates a private ignored session descriptor,
then children validate and join it; they must never start fallback servers or homeservers. Browser
journeys use the development bundle; the production PWA target builds production without Docker.
A development journey therefore does not establish service-worker, native, or Electron behavior.

Both disposable Synapses set `trusted_key_servers: []` and fetch signing keys directly
from the local federation peer. The generated public matrix.org notary would first try to
resolve private harness server names; a slow lookup can exhaust the alias-resolution timeout
and return `502 Failed to fetch alias` before direct key discovery runs. Signature verification
still occurs, using the local Caddy federation endpoints. Startup rewrites the generated notary
list, including configurations left by older harness versions. See Synapse's
[trusted key server configuration](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#trusted_key_servers).

The Android runner validates a dedicated API 36 x86_64 emulator, installs the Capacitor
app, and owns ADB reverse mappings and driver cleanup. It must not select an arbitrary
attached device. Electron needs separately installed shell dependencies and a display
(`xvfb-run -a` may supply one on headless Linux). iOS has static and simulator build
targets but no installed-WebView journey runner. See [Platforms](../platforms/index.md)
for host setup.

## Focus without changing ownership

Forward Playwright selection after `--` to the owning target:

```bash
pnpm nx run trinity-e2e-browser:e2e -- conversations/message-links.spec.mts
pnpm nx run trinity-e2e-browser:e2e -- --grep "message link"
```

These commands remain one serialized browser lifecycle; they are safer than invoking
Playwright directly. Use `pnpm e2e` for the pull-request-classified aggregate and
`pnpm e2e:all` for the full local suite set. Aggregates preflight declared prerequisites
before starting work, stop after an executed suite failure, and treat every current suite as
required. A missing prerequisite is not coverage. On headless Linux, Electron needs Xvfb;
Docker and the Android AVD are required for the full local delivery gate.

## Coverage and artifacts

Every canonical browser spec belongs to one capability and one primary contract type in
`e2e/browser/journey-catalog.mts`. Registry and catalog guards reject missing, duplicate,
stale, or misplaced coverage entries. The [executable browser inventory](../../scripts/e2e-browser-inventory.mjs)
owns the expected source counts. Add or move a journey with its catalog entry and run
the relevant guard. The report groups results by environment, capability, and contract type.

Runs keep traces, screenshots, videos, reports, and suite summaries under ignored
`dist/.playwright/` paths. Teardown failures fail the invocation; they are not best-effort
noise. Inspect retained diagnostics when a run fails and attach selected review proof to the
pull request when useful. Do not commit these artifacts.

## Delivery evidence

For a delivery change, record exact commands and exit statuses in the pull request. A focused
journey proves only its selected host and contract. The full local E2E gate is `pnpm e2e:all`;
run it after the repository quality gates when the delivery scope requires it. Native iOS runtime
evidence requires a macOS/Xcode host. `pnpm ios:verify` runs the static host contract on
other systems too; it does not prove an iOS build or launch. `trinity-ios:verify-native`
requires macOS and Xcode for its simulator build.

## What a result does and does not prove

- A unit or source-shape guard does not prove browser layout or a host integration.
- A browser journey does not prove production service worker, Android WebView, or Electron shell.
- A static native host contract does not prove a native launch.
- An unavailable environment is a recorded limitation, not a skipped success.

Use [Testing](testing.md) to select the narrowest check that observes the changed behavior,
then add the host boundary that the change crosses.
