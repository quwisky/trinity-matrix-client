# Android Timeline Events Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for both canonical timeline
system-event definitions while preserving their Playwright predecessors and
exact fixture-event ordering.

**Architecture:** A focused Vitest guard pins the predecessor and shared login/
account sources, the exact two-stage/three-identity ownership and every
forbidden shortcut. One serial Node/Maestro journey arranges independent rename
and member-join Rooms through real Synapse with the system event latest, then
opens each Room natively. Read-only renderer observations scope only real
timeline-event rows and prove the exact rename action/quoted name or joiner
display-name text.

**Issue:** #767, blocked on #766 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned timeline-events predecessor, application-login and
  account sources unchanged.
- Record exactly three globally unique identities across two stages: two for
  Room rename and one for member join.
- Rename fixture ordering is creator/Room → lead `hello` message → unique Room
  name state as the latest event. Membership ordering is owner/joiner/display
  name/public Room → lead `hi` message → join membership as the latest event.
- Stop fixture mutation once the latest system event is confirmed; do not
  reorder or append events after observation begins.
- Maestro/native device input owns every reachable product action: login and
  exact Room navigation.
- Renderer inspection is read-only and scoped to `timeline-event` rows. It may
  observe exact text/visibility but may not click, focus, fill, submit,
  navigate, invoke handlers or inject rendered system lines.
- Room-list names and member counts are navigation aids only and cannot satisfy
  either timeline-event identity.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials plus all access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/timeline-events-migration.spec.mjs`.

- [ ] Pin the predecessor hash, exact two definition spans, three assertion
      sites and both shared-source hashes.
- [ ] Require exact rename/member stage ids and counts `2 + 1 = 3` with global
      identity uniqueness.
- [ ] Require fresh exact fixtures with lead-before-latest state/membership
      ordering and an immutable observation boundary after server confirmation.
- [ ] Require native Room ownership and timeline-row-scoped exact rename action,
      quoted new name and joiner-display-name join text.
- [ ] Reject DOM click/focus/fill/submit/navigation, injected system rows, Room-
      list/member-count proof, wrong/unquoted text, event reordering/appending,
      retries, unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for Account roles, Room presets/names,
      lead bodies, display name, state/membership type/content/order, renderer
      row scope/text/quotes, native navigation, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/timeline-events-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and ordered event fixtures

**Files:**

- Create `e2e/android/timeline-events-contract.mts`.
- Create `e2e/android/timeline-events-fixtures.mts`, reusing exact lower-level
  Account/Room operations where possible.

- [ ] Export exact source mappings, rename/member stage ids/counts and all three
      identities; assert totals and global uniqueness at module load.
- [ ] Rename fixture: create/login a fresh creator, create the initial private
      Room, send exact `hello`, then publish exact unique `Renamed ${runId}`
      `m.room.name` state last.
- [ ] Member fixture: create/login fresh owner/joiner Accounts, set exact unique
      `Joiner ${runId}` display name, create the public Room, send exact `hi` as
      owner, then join as that member last.
- [ ] Observe real Room history/state to prove the expected system event is the
      latest fixture event before closing mutation access and launching the
      installed observation.
- [ ] Retain sanitized exact Account/Room/text/type/order facts while keeping
      passwords, access tokens, Room and event ids closure-private.
- [ ] Aggregate cleanup must handle partial setup and release all Accounts/
      Rooms plus application/device state within bounds.
- [ ] Extend the focused guard so wrong role/preset/body/display/state content,
      non-latest event, mutation after seal, unbounded Matrix work or leaked
      secret fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement native rename and member-join stages

**Files:**

- Create `e2e/android/timeline-events-journeys.mts`.

- [ ] Rename stage: sign in as creator and open the exact renamed Room through
      native Maestro actions.
- [ ] Scope the real timeline-event row containing
      `changed the room name to`, prove it visible and separately prove it
      contains the exact quoted unique name `"Renamed ${runId}"`. Record both
      rename identities exactly once.
- [ ] Member stage: sign in as owner and open the exact public Room through
      native Maestro actions.
- [ ] Scope the real timeline-event row and prove it visibly contains exact
      `Joiner ${runId} joined the room`. Record the sole member identity exactly
      once.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting and fixture-order/native-navigation/timeline-row/
      exact-text receipts.
- [ ] Scan aggregate diagnostics for credentials/tokens/Room/event ids; always
      clear application data, close the client and release both Matrix fixtures/
      device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `timeline-events` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.timeline-events` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after timeline-anchoring with a bounded
      wrapper and started marker; add started-only `android-timeline-events`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, three identities/two stages, exact sealed
      event ordering, native navigation, timeline-row text, secrets and
      teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:timeline-events --skipNxCache` three
      times sequentially on unchanged inputs; require 2/2 stages, 3/3
      identities, attempt 1 and retries 0 each time.
- [ ] Audit both sealed fixture orders, native Room actions and exact timeline-
      row action/quoted-name/join-text receipts; require no raster artifacts and
      clean Matrix/application/device teardown.
- [ ] Run the complete unchanged timeline-events browser predecessor with one
      worker and `--retries=0`; require both definitions to pass, then recheck
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
      exact browser predecessor and dedicated Android artifact; require 2/2
      stages, 3/3 identities, attempt 1/retries 0, exact order/native-navigation/
      timeline-text receipts, redaction, teardown and clean worktree.
- [ ] Post evidence to #767, #660, #653 and PR #677; close #767 only after all
      acceptance evidence is complete, then continue with #768.
