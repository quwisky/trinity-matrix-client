# Android Jump To Latest Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical
jump-to-latest definition while preserving its complete Playwright predecessor.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, their exact assertion expansion and every forbidden shortcut. One
serial Node/Maestro stage arranges a disposable Matrix Account and Room with 20
ordered long messages plus a fully-read marker. Maestro owns login, Room
navigation, a geometry-derived native swipe over the real timeline and native
pill activation. Read-only renderer observations prove initial bottom
settlement, real overflow, movement away from the bottom, pill visibility,
return to the bottom bound and final pill dismissal.

**Issue:** #738, blocked on #737 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned jump-to-latest predecessor, application-login and
  account sources unchanged.
- Record exactly seven unique identities in one stage: six direct assertions
  and one Room helper scroll-container-readiness expansion.
- Matrix REST may arrange the Account, Room, exactly 20 ordered long messages
  and the fully-read marker. Maestro owns every product action: login, Room
  navigation, timeline swipe and pill activation.
- Renderer access is read-only and may observe exact visibility and geometry.
  It may not assign `scrollTop`, call `scrollBy`/`scrollTo`, dispatch events,
  invoke handlers, focus, fill, submit or navigate.
- Replace the predecessor Android DOM-scroll workaround with a real Maestro
  swipe whose points are derived from the visible `.scroll` rectangle and
  transformed through the active device profile.
- Require more than 300 px of actual scrollable range and prove geometry both
  before and after each action; pill visibility or absence alone is
  insufficient.
- Use one attempt, zero retries, finite observation and bounded
  Matrix/application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access tokens and long message bodies.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/jump-to-latest-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact constants/API-login/busy-Room/Room
      helper and definition spans, plus application-login and account hashes.
- [ ] Prove six direct assertion sites and one Room helper expansion for seven
      unique parity identities.
- [ ] Require the exact stage ID, seven contract identities, an exact message
      count of 20, the long-body shape, sequential send completion and newest
      event read-marker ownership.
- [ ] Require initial bottom distance below 50 px, hidden pill and scrollable
      range above 300 px; require a native timeline swipe, positive movement
      away from the bottom, visible pill, native pill tap, restored bottom
      distance below 50 px and hidden pill.
- [ ] Require a reusable bounded native-swipe seam with measured CSS points,
      device-profile transformation, materialized Maestro coordinates and
      offset-change proof.
- [ ] Reject DOM/mouse scrolling, `scrollBy`, `scrollTo`, scroll-offset
      assignment, dispatched events, DOM click/focus/fill/submit/navigation,
      retries, unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for message count/order, read-marker
      event, initial settlement, overflow range, swipe direction/distance,
      offset change, pill transitions, final bottom bound, native ownership,
      cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/jump-to-latest-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and native swipe seam

**Files:**

- Create `e2e/android/jump-to-latest-contract.mts`.
- Modify `e2e/android/account-workspace-client.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if exact ordered
  message/read-marker operations are not already composable.

- [ ] Export exact source mappings and the seven-identity assertion map; assert
      count and uniqueness at module load.
- [ ] Add a bounded `swipeCurrent`-style client operation that reads exactly
      one visible target rectangle, derives safe in-rectangle start/end points,
      transforms both through the active profile, writes exact integer points
      to an ignored Maestro flow, executes one duration-bounded native swipe
      and restores the viewport owner.
- [ ] Require the caller to provide an expected scroll-direction observation;
      prove `.scroll.scrollTop` changed in that direction after the gesture
      without mutating it.
- [ ] Arrange exactly 20 long messages sequentially, retain every event id and
      mark both `m.fully_read` and `m.read` at the newest exact event.
- [ ] Keep credentials/tokens inside the fixture closure and return only
      sanitized Room and event facts.
- [ ] Extend the focused guard so wrong points/direction/duration, a gesture
      outside the target, missing profile transformation, offset mutation,
      incomplete sends or wrong read marker fail.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native jump stage

**Files:**

- Create `e2e/android/jump-to-latest-journeys.mts`.

- [ ] Arrange the fresh Account/Room, 20 ordered wrapping messages and exact
      newest-event read markers; sign into the installed app and open the Room
      through native actions.
- [ ] Prove the scroll container is visible, wait for bottom distance below 50
      px, prove the pill hidden and record a scrollable range above 300 px.
- [ ] Swipe natively from the upper portion toward the lower portion inside the
      real timeline to move toward older messages; prove `scrollTop` decreased,
      bottom distance increased materially and the pill became visible.
- [ ] Tap `[data-testid="jump-to-latest"]` through native touch; prove bottom
      distance returned below 50 px and the pill became hidden again.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, ordered-event/read-marker receipts, native-swipe
      point/direction receipts and aggregate cleanup and redaction scans.
- [ ] Always close the client, clear installed application data and release
      Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `jump-to-latest` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.jump-to-latest` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after jump-to-date with a bounded
      wrapper and started marker; add started-only `android-jump-to-latest`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, seven identities, the native-swipe replacement
      boundary, ordered messages/read marker, native/REST/renderer boundaries,
      geometry proof, secrets, teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:jump-to-latest --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 7/7
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens, bearer patterns and exact long message bodies;
      require no raster artifacts and clean emulator/application teardown.
- [ ] Run the complete unchanged jump-to-latest browser predecessor with one
      worker and `--retries=0`; require the exact definition to pass and recheck
      all three pinned source hashes.
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
      7/7 identities, attempt 1/retries 0, ordered-event/read-marker and native
      swipe receipts, geometry transitions, redaction, teardown and clean
      worktree.
- [ ] Post evidence to #738, #660, #653 and PR #677; close #738 only after all
      acceptance evidence is complete, then continue with #739.
