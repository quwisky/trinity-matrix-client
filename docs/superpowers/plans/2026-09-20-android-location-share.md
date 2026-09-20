# Android Location Share Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical
location-share definition while preserving its complete Playwright predecessor.

**Architecture:** A focused Vitest guard pins the predecessor, existing Android
GPS/permission adapter and shared login sources, their exact assertion
expansion and every forbidden shortcut. One serial Node/Maestro stage arranges
a disposable Matrix Account and Room, configures the emulator native GPS test
provider at the exact coordinates and grants only the production location
permissions. Maestro owns login, Room/tray/location actions and the message
long press. Closure-private Matrix observation proves the ready `m.location`
echo, while read-only renderer observations prove the exact card, map
destination and action-sheet boundary. Bounded teardown removes the provider,
restores mock-location app-op state and revokes the granted permissions.

**Issue:** #740, blocked on #739 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned location-share predecessor, Android fixtures,
  application helper and account sources unchanged.
- Record exactly eight unique identities in one stage: five direct assertions,
  one Room-readiness expansion, one real-server-echo expansion and one
  message-action-sheet-readiness expansion.
- Matrix REST may arrange the Account/Room and observe the exact event. Device
  APIs may configure the emulator native GPS provider and Android permissions.
  Maestro owns every product action: login, Room/tray/location selection,
  production permission confirmation if presented and message long press.
- Renderer access is read-only. It may observe exact message/card/sheet state
  but may not invoke handlers, focus, fill, submit or navigate.
- Require a fully-sent server event from the exact Account with `type`/content
  proving `m.location`, exact legacy `geo:` coordinates and exact MSC3488
  location coordinates. A pending local echo is insufficient.
- Require an opened action sheet with visible Copy link as the positive control
  before accepting Edit absence.
- Use one attempt, zero retries, finite observation and bounded GPS,
  permission, Matrix/application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials/access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/location-share-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact geolocation/Room helper/definition
      spans, Android fixture hash and GPS/permission spans, plus application and
      account source hashes.
- [ ] Prove five direct assertion sites and the exact Room-readiness,
      real-server-echo and action-sheet-readiness expansions for eight unique
      identities.
- [ ] Require exact latitude `40.7128`, longitude `-74.006`, native GPS test
      provider setup/pulse, only coarse/fine app permission grants and bounded
      restoration/removal/revocation.
- [ ] Require native Room/tray/location actions and long press, exact ready
      `m.location` sender/content proof, exact visible coordinate copy, exact
      OpenStreetMap `mlat`, opened-sheet/Copy-link proof and Edit absence.
- [ ] Reject browser geolocation stubs/emulation, injected Matrix events,
      manufactured local echo, generic map URLs, DOM click/focus/fill/submit/
      navigation, retries, unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for coordinates, provider/app-op,
      permission set, pulse lifetime, event type/sender/readiness/content,
      card text/href, action-sheet positive control, Edit absence, native
      ownership, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/location-share-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and native GPS fixture

**Files:**

- Create `e2e/android/location-share-contract.mts`.
- Create `e2e/android/native-geolocation-fixture.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts`.

- [ ] Export exact source mappings and the eight-identity assertion map; assert
      count and uniqueness at module load.
- [ ] Add a one-shot native geolocation fixture that records prior shell
      mock-location app-op and application permission state, allows shell mock
      location, adds/enables the GPS test provider, grants only
      `ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION`, applies the exact
      coordinate and pulses it every second for late listeners.
- [ ] Expose only sanitized provider/permission/coordinate receipts. Never use
      CDP geolocation override, `navigator.geolocation` replacement or app
      preference mutation.
- [ ] On close, stop/await the pulse, remove the GPS test provider, restore the
      prior shell app-op and restore/revoke both application permissions to
      their exact prior state, aggregating cleanup failures.
- [ ] Add closure-private observation for the exact latest ready location event
      from the expected sender; return only sanitized event id/type/sender and
      normalized legacy/MSC3488 coordinate facts.
- [ ] Extend the focused guard so wrong permissions/coordinates, missing pulse,
      provider/app-op/permission leaks, token return, local-echo acceptance or
      weak content checks fail.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native location stage

**Files:**

- Create `e2e/android/location-share-journeys.mts`.

- [ ] Arrange the fresh Account/private Room, open the native geolocation
      fixture, sign into the installed app and open the Room through native
      actions; prove composer readiness.
- [ ] Open the insert tray and choose Location through native touch; handle an
      Android OS permission surface through native input only if the exact
      production prompt remains after deterministic permission setup.
- [ ] Independently wait for the real ready `m.location` server event from the
      exact Account and prove both legacy `geo:40.7128,-74.006` and MSC3488
      coordinates normalize to the exact expected values.
- [ ] Scope to the exact ready event row and prove one visible location card,
      exact `40.71280, -74.00600` text and an OpenStreetMap `href` whose
      `mlat` query equals `40.7128`.
- [ ] Long-press that exact ready row natively, prove the Android message-action
      sheet is open, prove Copy link visible and prove Edit count zero.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, GPS/permission/event receipts and aggregate
      cleanup and redaction scans.
- [ ] Always close the geolocation fixture before clearing/closing the client
      and device; verify the provider is absent, app-op restored and both
      permission states restored even on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `location-share` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.location-share` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after link-preview with a bounded wrapper
      and started marker; add started-only `android-location-share`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, eight identities, native GPS/permission
      lifecycle, native/REST/renderer boundaries, exact Matrix/card/action-sheet
      proof, secrets, teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:location-share --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 8/8
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens and bearer patterns; require no raster artifacts,
      no residual GPS test provider, restored shell app-op/application
      permissions and clean emulator/application teardown.
- [ ] Run the complete unchanged location-share browser predecessor with one
      worker and `--retries=0`; require the exact definition to pass and recheck
      all four pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls and artifacts in the ledger.

## Task 6: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      the exact browser predecessor, dedicated Android artifact, 1/1 stage,
      8/8 identities, attempt 1/retries 0, GPS/permission/event receipts, exact
      card/action-sheet proof, cleanup, redaction and clean worktree.
- [ ] Post evidence to #740, #660, #653 and PR #677; close #740 only after all
      acceptance evidence is complete, then continue with #741.
