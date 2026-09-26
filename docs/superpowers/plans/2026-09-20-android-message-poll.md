# Android Message Poll Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical poll create,
vote and end definition while preserving its Playwright predecessor and
proving every state transition against authoritative Matrix poll events.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, the exact ten-identity ownership and every forbidden shortcut. One
serial Node/Maestro stage arranges only a disposable Account and Room. Maestro
owns login, insert-tray/dialog navigation, field input, poll creation, voting
and ending. A bounded Matrix observer proves the ready poll, response and end
event chain; read-only renderer observations prove the exact question, options,
tallies, final state and disabled voting.

**Issue:** #749, blocked on #748 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-poll predecessor, application-login and account
  sources unchanged.
- Record exactly ten unique identities in one stage: eight direct plus expanded
  Room readiness and real-server poll readiness.
- Arrange only the Account and Room through REST. Never seed the poll, vote or
  end event under test through REST.
- Maestro owns every reachable product action: login, Room/tray/dialog
  navigation, poll field input/create, Apple vote and poll end.
- Renderer inspection is read-only. It may observe exact readiness, fields,
  tallies and disabled/final state but may not invoke handlers, focus, fill,
  submit, scroll or navigate.
- Vote only after the poll has a real server event id. Accept no tally without
  exact response relation/answer evidence, and no final state without an exact
  end relation and disabled voting.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access/authorization tokens and event ids
  outside the dedicated structured evidence receipt.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-poll-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact definition/helper/poll-field spans
      plus application-login and account source hashes.
- [ ] Prove exactly eight direct assertions plus one Room-readiness and one
      real-server-echo identity, and require exactly ten globally unique
      contract identities in one stage.
- [ ] Require the phone insert tray with no obsolete inline Poll control, native
      dialog input/create, exact run-scoped question and Apple/Pear options,
      ready poll id, exact response relation/answer, exact tally, exact end
      relation, final state and disabled voting.
- [ ] Reject REST-seeded poll/vote/end events, pending-local-echo votes,
      unrelated response/end ids, tally-only evidence, final-text-only evidence,
      enabled post-end options, DOM click/focus/fill/submit/navigation, retries,
      unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for tray/no-inline state, exact question/
      options, ready poll id, response relation/Apple answer, both tally texts,
      end relation/final/disabled state, event-id scoping, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/message-poll-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and poll-event observer

**Files:**

- Create `e2e/android/message-poll-contract.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if bounded MSC3381
  event observation cannot be composed from existing fixture operations.

- [ ] Export exact source mappings and all ten identities; assert count and
      uniqueness at module load.
- [ ] Arrange one fresh Account/private Room without any poll events and keep
      credentials/tokens closure-private.
- [ ] Observe the Room timeline with a finite deadline and decode the exact
      supported poll-start, response and end event shapes without accepting
      unknown or ambiguous fallbacks.
- [ ] Require the start event's exact sender, question and ordered Apple/Pear
      answers, retaining the real poll event id only in a structured sanitized
      evidence object.
- [ ] Require exactly one response from the test Account whose relation targets
      that poll and whose selected answer id maps exactly to Apple.
- [ ] Require exactly one poll-end event whose relation targets the same poll;
      reject response/end events created before the owned native actions.
- [ ] Extend the focused guard so wrong event type/sender/order/question/answer,
      mismatched relation, duplicate ambiguity, unbounded polling or secret/id
      leakage outside the receipt fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement native poll creation and readiness

**Files:**

- Create `e2e/android/message-poll-journeys.mts`.

- [ ] Sign in and open the exact Room natively; record expanded Room readiness.
- [ ] Prove the phone composer exposes the insert tray and has zero obsolete
      inline Poll controls.
- [ ] Open the tray and Poll dialog natively; fill the exact run-scoped question
      plus `Apple` and `Pear` through native input and create through native
      touch.
- [ ] Scope to the exact rendered poll and prove it visible with exact question
      and `0 votes`.
- [ ] Wait for and validate its authoritative start event before enabling the
      next action; record the ready event identity and structured receipt.

## Task 4: Implement native vote and end transitions

- [ ] Tap the exact first/Apple option natively only after server readiness.
- [ ] Observe and validate the exact response relation and Apple answer id,
      then prove the same installed poll updates to exact `1 vote` and
      `1 (100%)`.
- [ ] Tap the exact End control natively, observe the exact poll-end relation
      and prove the same poll shows `Final results`.
- [ ] Prove every voting option/control is disabled or absent from the enabled
      interaction model after the authoritative end event.
- [ ] Record all ten identities exactly once and write started-stage reports,
      pass/failure secret-safe captures, exact assertion accounting and
      structured start/response/end receipts.
- [ ] Scan aggregate diagnostics for secrets, authorization and event ids
      outside the allowed receipt; always clear application data, close the
      client and release Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 5: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-poll` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-poll` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-markdown with a bounded
      wrapper and started marker; add started-only `android-message-poll`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, ten identities, native create/vote/end,
      authoritative event chain, native/REST/renderer boundaries, event-id
      evidence scoping, secrets, teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 6: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-poll --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 10/10
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens, bearer/authorization patterns and event ids outside
      the structured receipt; require no raster artifacts and clean Matrix/
      application/device teardown.
- [ ] Run the complete unchanged message-poll browser predecessor with one
      worker and `--retries=0`; require the exact definition to pass and recheck
      all three pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls and artifacts in the ledger.

## Task 7: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor, dedicated Android artifact, 1/1 stage, 10/10
      identities, attempt 1/retries 0, native action/start-response-end/tally/
      final-disable receipts, redaction, teardown and clean worktree.
- [ ] Post evidence to #749, #660, #653 and PR #677; close #749 only after all
      acceptance evidence is complete, then continue with #750.
