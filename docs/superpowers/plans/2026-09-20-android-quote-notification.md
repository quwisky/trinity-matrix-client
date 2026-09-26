# Android Quote Notification Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical quoted-
display-name notification definition while preserving its Playwright
predecessor and proving that quoted display-name text does not create a
highlight when ordinary Room notifications remain active.

**Architecture:** A focused Vitest guard pins the predecessor, application and
account sources, the exact one-stage/seven-identity ownership and every
forbidden shortcut. One serial Node/Maestro journey arranges fresh writer and
reader Accounts plus a private Room through Synapse, drives the writer's quote
and answer through native Android controls, then uses one reader incremental-
sync window and a plain REST probe to prove positive ordinary notification
count with exactly zero highlights. Renderer inspection is read-only and all
credentials plus both access tokens remain redacted.

**Issue:** #758, blocked on #757 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned quote-mentions predecessor, application/action-sheet and
  account sources unchanged.
- Record exactly seven globally unique identities in one stage: six direct
  predecessor assertions plus one Android action-sheet readiness expansion.
- Arrange fresh writer/reader Accounts, the private Room, reader display name,
  membership and reader-authored source message through real Synapse. The
  display name must remain exactly `Zephyrine`; the source must be that reader's
  exact self-authored `Zephyrine, can you look at this?` message.
- Maestro/native device input owns every reachable product action: writer
  login, Room navigation, source-row long press, Quote selection, answer entry
  and send.
- Renderer inspection is read-only. It may observe exact value, text and
  visibility but may not click, focus, fill, submit, navigate, invoke quote or
  send handlers, or synthesize pointer/keyboard events.
- Preserve the predecessor's ordering: after the answer is visibly sent,
  establish the reader's incremental-sync token, send one plain non-highlight
  probe through REST, and poll that same incremental window until ordinary
  notification count is positive and highlight count is exactly zero.
- A zero-highlight observation is invalid without the positive ordinary-
  notification control from the same incremental-sync result. Do not infer the
  decision from push-rule configuration JSON.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials plus both access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/quote-notification-migration.spec.mjs`.

- [ ] Pin the predecessor hash, exact definition/display-name/API-login spans,
      six direct assertion sites, single Android action-sheet expansion and
      application/account source hashes.
- [ ] Require exactly one stage with seven globally unique identities for
      composer readiness, named source visibility, action-sheet readiness,
      exact quote value, sent-answer visibility, positive notification count
      and zero highlight count.
- [ ] Require fresh writer/reader Accounts, exact reader display name, private
      Room invite/join, reader-authored exact source text and writer-native
      quote/answer ownership.
- [ ] Require an incremental reader sync token established after answer
      visibility, one plain writer REST probe, bounded polling of the same
      window, a positive `notification_count` and exact zero
      `highlight_count` from the accepted unread-notification result.
- [ ] Reject REST-seeded writer answers, quoted-message shortcuts, push-rule
      inference, full-sync-only or zero/zero notification evidence, DOM
      click/focus/fill/submit/navigation, handler invocation, retries,
      unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for display name, source/answer/probe
      bodies, source author, action-sheet target, exact quote value and blank
      line, sync ordering/token reuse, notification/highlight predicates,
      native ownership, cleanup and redaction.
- [ ] Run
      `pnpm exec vitest run scripts/quote-notification-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and notification fixture

**Files:**

- Create `e2e/android/quote-notification-contract.mts`.
- Create `e2e/android/quote-notification-fixtures.mts`, reusing exact
  lower-level Account/Room operations where possible.

- [ ] Export the exact source mapping, single stage id/count and all seven
      identities; assert the total and global uniqueness at module load.
- [ ] Create fresh writer and reader Accounts, log both into real Synapse, set
      the reader display name to exactly `Zephyrine`, create a private Room as
      the writer, invite/join the reader and publish the exact source as the
      reader.
- [ ] Retain sanitized writer/reader/Room/source facts while keeping passwords
      and both access tokens closure-private.
- [ ] Provide a finite reader notification observer that obtains its initial
      `next_batch` only after the journey confirms answer visibility, sends the
      exact plain probe as the writer, and polls the same `since` token until a
      single accepted unread-notification result has positive ordinary count
      and zero highlights.
- [ ] Preserve enough sanitized timing, probe event and count receipts to prove
      ordering and same-window ownership without serializing credentials,
      tokens or raw sync payloads.
- [ ] Aggregate cleanup must handle partial setup and remove both Accounts plus
      the Room through bounded real-server operations.
- [ ] Extend the focused guard so wrong display/source author/body, stale or
      regenerated sync token, missing/mention-like probe, separate count
      observations, unbounded polling or leaked secrets fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native quote and answer journey

**Files:**

- Create `e2e/android/quote-notification-journeys.mts`.

- [ ] Sign in as the writer and open the exact private Room through native
      Maestro actions.
- [ ] Prove the composer is visible and scope the exact reader-authored source
      row by its ready event id/body.
- [ ] Long-press that row natively, record native action-sheet readiness and tap
      the exact Quote control through native touch.
- [ ] Observe the composer value exactly as
      `> Zephyrine, can you look at this?\n\n`, including the trailing blank
      line.
- [ ] Enter the run-scoped exact answer through native Android input and send
      it through the native keyboard/device action; prove that exact answer is
      visible in the real timeline.
- [ ] Only after answer visibility, invoke the notification fixture and require
      the accepted same-window counts to satisfy `notification_count > 0` and
      `highlight_count === 0`.
- [ ] Record all seven identities exactly once and write started-stage reports,
      pass/failure secret-safe captures, exact assertion accounting and native-
      action/source/quote/answer/sync/probe/count receipts.
- [ ] Scan aggregate diagnostics for credentials and both access tokens; always
      clear application data, close the client and release Matrix/device
      resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `quote-notification` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.quote-notification` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after pinned-message-workflows with a
      bounded wrapper and started marker; add started-only
      `android-quote-notification` diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, seven identities/one stage, native quote/send,
      reader-authored source, incremental-sync ordering, positive ordinary-
      notification control, exact zero-highlight decision, secrets, teardown
      and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run
      `pnpm nx run trinity-e2e-android:quote-notification --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 7/7
      identities, attempt 1 and retries 0 each time.
- [ ] Audit native action, source/answer, exact quote, sync ordering/token,
      probe/count and positive-control receipts; require no raster artifacts and
      clean Matrix/application/device teardown.
- [ ] Run the unchanged quote-mentions browser predecessor with one worker and
      `--retries=0`; require its sole definition to pass, then recheck all three
      pinned source hashes.
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
      exact browser predecessor and dedicated Android artifact; require 1/1
      stage, 7/7 identities, attempt 1/retries 0, native quote/answer receipts,
      same-window positive-notification/zero-highlight evidence, redaction,
      teardown and clean worktree.
- [ ] Post evidence to #758, #660, #653 and PR #677; close #758 only after all
      acceptance evidence is complete, then continue with #759.
