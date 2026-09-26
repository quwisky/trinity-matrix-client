# Android Seen By Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical seen-by/read-
receipt-cluster definition while preserving its Playwright predecessor and
proving that an independent reader's real Matrix receipt drives the expanded
reader list.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
and account sources, the exact one-stage/five-identity ownership and every
forbidden shortcut. One serial Node/Maestro journey arranges fresh author and
reader Accounts plus a private Room through Synapse, sends the target through
the author's native composer, resolves its authoritative event id, submits the
reader's real public receipt, and expands the resulting cluster through native
touch. Renderer inspection is read-only and diagnostics redact credentials,
tokens and event identifiers as required.

**Issue:** #761, blocked on #760 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned seen-by predecessor, application-login and account
  sources unchanged.
- Record exactly five globally unique identities in one stage: four direct
  predecessor assertions plus one Room-readiness expansion.
- Arrange fresh author/reader Accounts and one private Room through real
  Synapse. Give the reader the exact run-scoped `Reader ${runId}` display name,
  invite and join them before the author's installed session opens the Room.
- The author must enter and send the unique target body through native Android
  composer/keyboard actions. REST may not seed the author's owned message.
- Poll real Room history until exactly one authoritative event resolves for the
  authored body/sender, then submit the independent reader's public `m.read`
  receipt against that exact event through the Matrix API.
- Maestro/native device input owns every reachable product action: author
  login, Room navigation, composer entry/send and receipt-cluster expansion.
- Renderer inspection is read-only. It may observe exact text/visibility and
  scope rows by ready event id but may not click, focus, fill, submit, navigate,
  invoke composer/cluster handlers or inject a local reader name.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, both access tokens and event identifiers
  from external diagnostics where required.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/seen-by-migration.spec.mjs`.

- [ ] Pin the predecessor hash, exact definition/API-login/Room-helper spans,
      four direct assertions, helper call count and both shared-source hashes.
- [ ] Require exactly one stage with five globally unique identities for Room
      readiness, sent-row visibility, authoritative event-id resolution,
      receipt-cluster visibility and exact reader-name expansion.
- [ ] Require fresh author/reader Accounts, exact run-scoped display name,
      private Room invite/join, native author send, unique server event
      resolution and independent reader receipt submission.
- [ ] Require the real receipt-driven cluster to become visible before native
      expansion and the resulting seen-by list to contain the exact reader
      display name.
- [ ] Reject REST-seeded author messages, fake/local receipt clusters, locally
      injected reader names, ambiguous/wrong event ids, DOM click/focus/fill/
      submit/navigation, handler invocation, retries, unbounded waits and weak
      cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for Account roles, display name, Room
      preset/invite, native target input/send, event sender/body/type/id,
      receipt user/type/target, cluster target, expansion text, cleanup and
      redaction.
- [ ] Run `pnpm exec vitest run scripts/seen-by-migration.spec.mjs` and preserve
      the expected RED result.

## Task 2: Add the exact contract and receipt fixture

**Files:**

- Create `e2e/android/seen-by-contract.mts`.
- Create `e2e/android/seen-by-fixtures.mts`, reusing exact lower-level Account/
  Room operations where possible.

- [ ] Export the exact source mapping, single stage id/count and all five
      identities; assert the total and global uniqueness at module load.
- [ ] Create/login fresh author and reader Accounts, set the reader's exact
      run-scoped display name, create one private Room as author and invite/join
      the reader without sending the owned target.
- [ ] Retain sanitized exact Account/Room/display-name facts while keeping
      passwords and both access tokens closure-private.
- [ ] Provide a finite Room-history observer that accepts only one exact
      `m.room.message` from the author with the run-scoped target body, and
      returns its event id only after the native timeline send is visible.
- [ ] Submit the reader's public `m.read` receipt against that exact event and
      retain a sanitized authoritative receipt acknowledgment without faking or
      locally projecting cluster state.
- [ ] Aggregate cleanup must handle partial setup and release both Accounts plus
      the Room through bounded real-server operations.
- [ ] Extend the focused guard so wrong sender/body/type, duplicate/ambiguous
      event match, wrong receipt user/type/event, premature receipt, unbounded
      Matrix work or leaked secrets fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native send and expansion journey

**Files:**

- Create `e2e/android/seen-by-journeys.mts`.

- [ ] Sign in as the author and open the exact private Room through native
      Maestro actions, recording the expanded Room-readiness identity.
- [ ] Enter the exact run-scoped target body through native composer input and
      send it through the native keyboard/device action.
- [ ] Prove the real timeline row appears, then resolve its exact authoritative
      event id through the bounded fixture observer.
- [ ] Submit the independent reader's real public receipt only after event-id
      resolution and wait finitely for the target row's receipt cluster to
      become visible.
- [ ] Tap that exact cluster through native touch and prove the expanded seen-by
      list contains the reader's exact run-scoped display name.
- [ ] Record all five identities exactly once and write started-stage reports,
      pass/failure secret-safe captures, exact assertion accounting and native-
      action/message/event/receipt/cluster/reader receipts.
- [ ] Scan aggregate diagnostics for credentials, both access tokens and raw
      event identifiers where prohibited; always clear application data, close
      the client and release Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `seen-by` target with the Android APK build, a
      bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.seen-by` as required current hosted Android coverage and
      add exact command metadata.
- [ ] Invoke it on shard 2 immediately after read-receipt-privacy with a bounded
      wrapper and started marker; add started-only `android-seen-by`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, five identities/one stage, native author send,
      authoritative event resolution, independent reader receipt, native
      cluster expansion, secrets/event-id handling and teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:seen-by --skipNxCache` three times
      sequentially on unchanged inputs; require 1/1 stage, 5/5 identities,
      attempt 1 and retries 0 each time.
- [ ] Audit native Room/composer/send/cluster actions, exact timeline/event,
      independent receipt and expanded-reader receipts; require no raster
      artifacts and clean Matrix/application/device teardown.
- [ ] Run the unchanged seen-by browser predecessor with one worker and
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
      stage, 5/5 identities, attempt 1/retries 0, native send/event/independent-
      receipt/cluster/reader receipts, redaction, teardown and clean worktree.
- [ ] Post evidence to #761, #660, #653 and PR #677; close #761 only after all
      acceptance evidence is complete, then continue with #762.
