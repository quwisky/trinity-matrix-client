# Android Thread Composer Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for both canonical thread-
composer definitions while preserving their Playwright predecessors and
proving native root/thread actions plus the real idle footer layout.

**Architecture:** A focused Vitest guard pins the predecessor and shared login,
action-sheet, remote-echo and account sources, the exact two-stage/21-identity
ownership and every forbidden shortcut. One serial Node/Maestro journey uses a
fresh creator/private Room per stage, sends each root through the native Room
composer, waits for its authoritative remote id, and opens the thread through
the real Android action sheet. Read-only renderer observations prove thread
semantics/actions/emote/styles and measure the actual idle typing-indicator host
without mutating layout.

**Issue:** #764, blocked on #763 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned thread-composer predecessor, application-login/action-
  sheet/remote-echo and account sources unchanged.
- Record exactly 21 globally unique identities across two stages. The behavior
  stage owns 14: eleven direct plus one Room readiness, one remote echo and one
  action-sheet readiness. The idle-layout stage owns seven: four direct plus
  the same three helper expansions.
- For each stage arrange a fresh creator Account and private Room through real
  Synapse without seeding the owned root or thread message.
- Enter/send the exact unique root through native Android composer/keyboard
  input and accept only an authoritative remote event id; an unsent local
  `~txnId` echo cannot be a thread root.
- Maestro/native device input owns every reachable product action: login, Room
  navigation, root/thread text entry/send, exact-row long press and Reply in
  thread selection.
- Renderer inspection is read-only. It may observe exact attributes/count/
  text/style/geometry/visibility and ready event ids but may not click, focus,
  fill, submit, navigate, invoke thread/send handlers, assign values or mutate
  styles/layout.
- Layout proof must measure the actual idle `trn-typing-indicator` host inside
  the non-flex thread footer and require height above 20 px; measuring only its
  child typing slot or inferring from classes is invalid.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device/keyboard teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials plus access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/thread-composer-migration.spec.mjs`.

- [ ] Pin the predecessor hash, exact two definition/Room-helper spans, direct
      assertion counts, helper call counts and both shared-source hashes.
- [ ] Prove exact stage totals `14 + 7 = 21`, every source-to-record mapping and
      global identity uniqueness.
- [ ] Require fresh per-stage fixtures, native root input/send, exact timeline
      row, authoritative remote id, native long press/action sheet and native
      Reply in thread ownership.
- [ ] Require exact thread `neutral`/`md`/`fullscreen` semantics, absent Room-
      scoped insert tray, present attach control, native `/me waves` send,
      rendered `waves`, literal-command absence, solid composer top border and
      exact 16 px emitted body text.
- [ ] Require the second stage to measure the actual idle typing-indicator host
      above 20 px and prove zero rendered typing-status elements.
- [ ] Reject seeded root/thread events, local-echo root ids, DOM click/focus/
      fill/submit/navigation, assigned values, handler invocation, class-only
      layout inference, child-slot-only measurement, style mutation, retries,
      unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for stage/direct/helper counts, fixture
      separation, root/thread bodies, remote-id readiness, sheet target/action,
      thread semantics, insert/attach controls, emote positive/negative result,
      styles, host selector/height threshold, status absence, cleanup and
      redaction.
- [ ] Run `pnpm exec vitest run scripts/thread-composer-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and per-stage fixtures

**Files:**

- Create `e2e/android/thread-composer-contract.mts`.
- Create `e2e/android/thread-composer-fixtures.mts`, reusing exact lower-level
  Account/Room operations where possible.

- [ ] Export exact source mappings, two stage ids/counts and all 21 identities;
      assert totals and global uniqueness at module load.
- [ ] Create one fresh creator/private Room per stage without publishing either
      owned root or any thread reply.
- [ ] Retain sanitized exact Account/Room/root facts while keeping passwords and
      access tokens closure-private.
- [ ] Provide a finite Room-history observer accepting exactly one remote
      `m.room.message` from the creator with the stage's root body and rejecting
      local transaction ids, duplicates or ambiguous matches.
- [ ] Return the authoritative root event id only after native timeline
      visibility, preserving a sanitized echo receipt without serializing raw
      event payloads.
- [ ] Aggregate cleanup must handle partial fixtures and release both Accounts/
      Rooms plus keyboard/application/device state within bounds.
- [ ] Extend the focused guard so wrong Room/body/sender/type/id, seeded
      content, shared fixture, unbounded Matrix work or leaked secret fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement shared native root-to-thread opening

**Files:**

- Create `e2e/android/thread-composer-journeys.mts`.

- [ ] For each stage sign in/open the exact Room natively and record its Room-
      readiness identity.
- [ ] Enter/send the exact unique root through native Android input; prove its
      exact row visible and wait for the authoritative remote event id.
- [ ] Long-press that exact ready row natively, record action-sheet readiness
      and select exact Reply in thread through native touch.
- [ ] Prove the real thread surface opens before any stage-specific assertion.

## Task 4: Implement behavior, emote and style stage

- [ ] Prove the thread has exact `data-trn-variant="neutral"`,
      `data-trn-size="md"` and `data-trn-layout="fullscreen"` semantics.
- [ ] Prove the thread contains zero Room-scoped `composer-insert` tray controls
      while the plain `composer-insert-attach` control is visible.
- [ ] Enter exact `/me waves` through the native thread composer and send with
      native keyboard/device input.
- [ ] Prove exact `waves` text appears inside the thread while literal
      `/me waves` is absent.
- [ ] Observe the integrated thread composer field's computed
      `border-top-style` as exact `solid` and the emitted message body's
      computed font size as exact `16px`, without modifying renderer styles.
- [ ] Record all fourteen behavior-stage identities exactly once.

## Task 5: Implement idle typing-row layout stage

- [ ] After shared native root/thread opening, scope the real non-flex thread
      footer and its idle `trn-typing-indicator` host, not `.typing-slot`.
- [ ] Measure the host's real rendered bounding height and require it to exceed
      20 px, preserving the predecessor's regression-separating threshold.
- [ ] Prove the empty state contains zero rendered `typing-status` elements and
      record all seven layout-stage identities exactly once.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting and fixture/native-action/root/remote-echo/sheet/
      thread/emote/style/layout receipts.
- [ ] Scan aggregate diagnostics for credentials/access tokens; always dismiss
      the keyboard, clear application data, close the client and release both
      Matrix fixtures/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 6: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `thread-composer` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.thread-composer` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after image-pack-lifecycle with a bounded
      wrapper and started marker; add started-only `android-thread-composer`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, 21 identities/two stages, native root/thread/
      sheet actions, remote-id requirement, thread semantics/actions/emote/
      styles, actual host layout proof, secrets and teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 7: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:thread-composer --skipNxCache` three
      times sequentially on unchanged inputs; require 2/2 stages, 21/21
      identities, attempt 1 and retries 0 each time.
- [ ] Audit both fixture/native root/remote echo/sheet/thread receipts, behavior
      semantics/actions/emote/style and layout host/status evidence; require no
      raster artifacts and clean Matrix/keyboard/application/device teardown.
- [ ] Run the complete unchanged thread-composer browser predecessor with one
      worker and `--retries=0`; require both definitions to pass, then recheck
      all three pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls and artifacts in the ledger.

## Task 8: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor and dedicated Android artifact; require 2/2
      stages, 21/21 identities, attempt 1/retries 0, native root/echo/sheet/
      thread/emote/style/layout receipts, redaction, teardown and clean
      worktree.
- [ ] Post evidence to #764, #660, #653 and PR #677; close #764 only after all
      acceptance evidence is complete, then continue with #765.
