# Android Message Grouping Migration Implementation Plan

> **Superseded:** Do not execute this preparatory plan. The approved written
> design is implemented by
> `docs/superpowers/plans/2026-09-24-android-message-grouping-maestro.md`,
> which corrects the native density envelope, assertion accounting, and
> Nx-first validation.

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the Android branch of the
canonical message-grouping definition while preserving its Playwright
predecessor and desktop-only tail.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, the exact Android return boundary, all 22 geometry identities and
every forbidden shortcut. One serial Node/Maestro stage arranges a disposable
Matrix Account and Room with three consecutive same-sender text events.
Maestro owns login, Room/Settings navigation and Compact selection. Read-only
renderer observations measure real cosy and compact grouping geometry, while a
native SharedPreferences observer proves the production density choice was
persisted as `compact`.

**Issue:** #745, blocked on #744 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-grouping predecessor, application-login/
  Preferences and account sources unchanged.
- Record exactly 22 unique identities in one stage: Room visibility; three
  exact bodies; avatar/continuation counts; three exact 40 px leads; three
  aligned text edges; cosy start/continuation padding and zero margin; no phone
  toolbar; and six compact geometry comparisons including the 8 px gap.
- Keep every statement after the explicit Android return browser-only. Do not
  migrate desktop hover, top-edge LTR/RTL, desktop compact-density or hybrid-
  pointer behavior as Android coverage.
- Matrix REST may arrange the Account/Room/events. Maestro owns every product
  action: login, Room/Settings navigation and Compact selection.
- Renderer/native Preferences access is read-only. It may observe exact
  persisted/layout state but may not mutate attributes, styles or classes,
  synthesize hover/pointer input, invoke handlers, scroll, focus, fill, submit
  or navigate.
- Measure real used geometry rather than stylesheet declarations or screenshots
  and require non-vacuous cosy-to-compact change.
- Use one attempt, zero retries, finite observation and bounded
  Matrix/application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials/access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-grouping-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact 40 px constant/API-login/Android body
      plus explicit return and desktop-tail spans; pin application-login/
      Preferences and account source hashes.
- [ ] Require the exact single stage and all 22 unique identities matching the
      issue-owned grouping/count/geometry shape.
- [ ] Require three exact consecutive same-sender ready events, Room visibility,
      three bodies, one avatar/two continuations, three 40 px lead widths, three
      left-edge alignments and exact cosy border-box spacing.
- [ ] Require phone no-toolbar state, native Settings → Appearance → Compact
      action, exact native `trinity.appearance.density = compact` persistence,
      same-Room reopening and six exact compact geometry comparisons.
- [ ] Reject the desktop tail, direct `data-density`/style/class mutation,
      synthesized hover/pointer input, stylesheet/screenshot-only geometry,
      DOM click/focus/fill/submit/navigation, retries, unbounded waits and weak
      cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for sender/order/body, avatar/
      continuation counts, every lead/alignment/border-box measure, no-toolbar,
      native density key/value, compact height/gap/padding/margin/trailing edge,
      cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/message-grouping-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and density preference observer

**Files:**

- Create `e2e/android/message-grouping-contract.mts`.
- Create `e2e/android/appearance-density-preference.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if exact ordered
  same-sender event setup is not already composable.

- [ ] Export exact source mappings and an explicit 22-identity assertion map;
      assert count and uniqueness at module load.
- [ ] Arrange one fresh Account/private Room and send the three exact text
      events sequentially from the same sender, retaining sanitized ordered
      event ids/bodies while keeping credentials/token closure-private.
- [ ] Parse only `trinity.appearance.density` from
      `shared_prefs/CapacitorStorage.xml`, decode XML safely and fail closed on
      duplicate/malformed values.
- [ ] Observe default absence/`cosy` semantics and bounded persisted `compact`
      through `run-as` without returning raw XML.
- [ ] Reuse the production native Settings/Appearance control path; never seed
      native preferences or renderer attributes for this journey.
- [ ] Extend the focused guard so wrong event order/sender, preference file/
      key/value, raw XML retention, renderer mutation or leaked credentials/
      token fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native grouping stage

**Files:**

- Create `e2e/android/message-grouping-journeys.mts`.

- [ ] Arrange the ordered events, sign into the installed app and open the
      exact Room natively; prove Room visibility and all three exact bodies.
- [ ] Scope to the three exact event-id rows; prove exactly one avatar and two
      continuation rows, and record each avatar/gutter lead as exactly 40 px.
- [ ] Measure each exact text left edge and require every edge within one pixel
      of the first.
- [ ] Measure cosy group-start and continuation computed geometry; require
      start padding at least 16 px, continuation padding zero and start margin
      zero, then record cosy total row height.
- [ ] Prove zero `.msg__toolbar` elements in the installed phone interaction
      model.
- [ ] Navigate natively to Settings → Appearance, choose Compact through the
      production control, prove native preference exactly `compact`, return to
      the same Room through native actions and re-scope the same three events.
- [ ] Prove exact 8 px column gap, compact total height below cosy, start
      padding exactly 12 px, start margin zero, continuation padding zero and a
      present trailing body gap whose absolute value is at most one pixel.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, event/preference/geometry receipts and aggregate
      cleanup and redaction scans.
- [ ] Always clear installed application data, close client and release Matrix/
      device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-grouping` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-grouping` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-forward with a bounded
      wrapper and started marker; add started-only `android-message-grouping`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, 22 identities, desktop-tail exclusion,
      native density persistence, native/REST/renderer ownership, cosy/compact
      geometry, secrets, teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-grouping --skipNxCache`
      three times sequentially on unchanged inputs; require 1/1 stage, 22/22
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens, bearer patterns and raw Preferences XML; require no
      raster artifacts and clean Matrix/application/device teardown.
- [ ] Run the complete unchanged message-grouping browser predecessor with one
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
      22/22 identities, attempt 1/retries 0, event/preference/cosy-compact
      geometry receipts, redaction, teardown and clean worktree.
- [ ] Post evidence to #745, #660, #653 and PR #677; close #745 only after all
      acceptance evidence is complete, then continue with #746.
