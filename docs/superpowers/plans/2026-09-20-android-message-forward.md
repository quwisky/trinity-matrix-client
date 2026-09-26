# Android Message Forward Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical
message-forward definition while preserving its complete Playwright
predecessor.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, their exact assertion expansion and every forbidden shortcut. One
serial Node/Maestro stage arranges a disposable Matrix Account plus exact
source and target Rooms. Maestro owns login, Room navigation, composer send,
ready-row long press, Forward action, picker search/selection and target-Room
opening. Closure-private Matrix observation proves distinct ready source and
target events with exact sender/body and no stale source relation; read-only
renderer observation proves the corresponding exact rows and picker state.

**Issue:** #744, blocked on #743 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-forward predecessor, application/helper and
  account sources unchanged.
- Record exactly seven unique identities in one stage: three direct assertions,
  two Room-readiness expansions, one real-server-echo expansion and one
  action-sheet-readiness expansion.
- Matrix REST may arrange Accounts/Rooms and observe exact source/target
  events. Maestro owns every product action: login, Room navigation, composer
  fill/send, long press, Forward, picker fill/selection and target opening.
- Renderer access is read-only and may observe exact readiness, picker and row
  state. It may not invoke handlers, click, focus, fill, submit or navigate.
- Act only on the ready source event id, select the exact target Room identity
  rather than a fuzzy first result, and prove a distinct ready target event
  with exact active sender/body and no `m.relates_to` carry-over.
- Use one attempt, zero retries, finite observation and bounded
  Matrix/application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials/access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-forward-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact Room helper/definition spans, plus
      application/helper and account source hashes.
- [ ] Prove three direct assertions plus exact two Room-readiness,
      server-echo and action-sheet expansions; require seven globally unique
      identities in the exact stage.
- [ ] Require two exact fresh Rooms, native exact source send, ready source
      event-id proof, native long press/sheet/Forward, visible picker, native
      exact search and exact target selection, native target opening and exact
      target row visibility.
- [ ] Require an independently observed distinct target-Room event with exact
      active sender/body and absent `m.relates_to`/source relation.
- [ ] Reject pending local-echo forwarding, desktop hover menus, fuzzy/first
      target selection, manufactured target events, Room-list preview proof,
      DOM click/focus/fill/submit/navigation, retries, unbounded waits and weak
      cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for source readiness/id, native sheet,
      picker ownership, exact search/target id, distinct target event,
      sender/body/no-relation proof, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/message-forward-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and Matrix observation seam

**Files:**

- Create `e2e/android/message-forward-contract.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts`.

- [ ] Export exact source mappings and the seven-identity assertion map; assert
      count and uniqueness at module load.
- [ ] Arrange one Account plus distinct source/target private Rooms and retain
      exact sanitized Room ids/names while keeping credentials/token inside the
      fixture closure.
- [ ] Add bounded source-event observation that returns only a ready exact
      `m.room.message`/`m.text` event id, sender, Room id and body equality.
- [ ] Add bounded target-event observation that requires a new event id
      different from the source, exact target Room, sender/body equality and
      absence of `m.relates_to` plus any source event-id relation.
- [ ] Ensure observation starts from a pre-forward target timeline boundary so
      a preexisting matching body cannot satisfy the result.
- [ ] Extend the focused guard so wrong Room identity, stale/preexisting event,
      source-id reuse, arbitrary sender/body, relation carry-over or leaked
      credentials/token fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native forwarding stage

**Files:**

- Create `e2e/android/message-forward-journeys.mts`.

- [ ] Arrange the fresh source/target Rooms, sign into the installed app and
      open the exact source Room through native actions; record the first Room
      readiness identity.
- [ ] Fill the exact run-scoped source text through native composer input and
      submit with native keyboard input; prove its exact row visible and wait
      for a ready exact source event id from Synapse.
- [ ] Long-press the event-id-scoped source row through native input, prove the
      Android message-action sheet is open and choose Forward natively.
- [ ] Prove the production Room picker visible, fill the exact target Room name
      natively, require exactly one result whose Room identity/name match and
      select it through native touch.
- [ ] Wait for the independent distinct target event receipt, open the exact
      target Room natively, record the second Room readiness identity and prove
      the event-id-scoped forwarded row visible in the timeline.
- [ ] Prove the target receipt has exact sender/body and no relation fields or
      source event id; do not count Room-list preview text as evidence.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, sanitized source/target/picker receipts and
      aggregate cleanup and redaction scans.
- [ ] Always close sheet/picker, clear installed application data, close client
      and release Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-forward` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-forward` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after edit-history with a bounded wrapper
      and started marker; add started-only `android-message-forward`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, seven identities, native sheet/picker/action
      boundaries, exact source/target event/no-relation proof, secrets,
      teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-forward --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 7/7
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens and bearer patterns; require no raster artifacts
      and clean Matrix/application/device teardown.
- [ ] Run the complete unchanged message-forward browser predecessor with one
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
      7/7 identities, attempt 1/retries 0, source/target/picker/no-relation
      receipts, redaction, teardown and clean worktree.
- [ ] Post evidence to #744, #660, #653 and PR #677; close #744 only after all
      acceptance evidence is complete, then continue with #745.
