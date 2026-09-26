# Android Read Receipt Privacy Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical read-receipt
privacy definition while preserving its Playwright predecessor and proving
that disabling public receipts still acknowledges the exact message privately.

**Architecture:** A focused Vitest guard pins the predecessor and shared login,
account and Settings-navigation sources, the exact one-stage/eight-identity
ownership and every forbidden shortcut. One serial Node/Maestro journey
arranges fresh sender/reader Accounts and a private Room through Synapse,
disables read receipts through the native Privacy UI before opening the Room,
then proves the reader has an `m.read.private` receipt while the sender has no
public `m.read` receipt from that reader. Renderer/preference inspection is
read-only, and the native route replaces the predecessor's browser `goto`.

**Issue:** #760, blocked on #759 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned read-receipts-privacy predecessor, application-login,
  account and Android Settings-navigation sources unchanged.
- Record exactly eight globally unique identities in one stage: four direct
  predecessor assertions, one Room-readiness expansion and three
  `openSettingsSection` navigation/detail expansions.
- Arrange fresh reader/sender Accounts and one private Room through real
  Synapse. The sender must invite the reader and publish the exact
  `Did you read this?` message before the reader opens the Room.
- Maestro/native device input owns every reachable product action: reader
  login, Settings → Privacy navigation, toggle activation, return to Rooms and
  target-Room opening.
- Replace the predecessor's browser `page.goto('/rooms')` with Android Back or
  a real production navigation control; DOM/browser navigation is forbidden.
- Renderer/native-preference inspection is read-only. It may observe exact
  control/value/text/visibility and persisted preference state but may not
  click, focus, fill, submit, navigate, invoke the toggle handler or mutate
  settings storage.
- A missing sender-visible public receipt is invalid without a positive private
  receipt from the same reader after the exact message becomes visible. Local
  UI disappearance or unread state alone is not privacy proof.
- Do not seed any receipt event. REST may arrange Accounts/Room/message and
  observe the real Synapse receipt views only.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device/settings teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials plus both access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/read-receipt-privacy-migration.spec.mjs`.

- [ ] Pin the predecessor hash, exact definition/API-login/receipt/Room-helper
      spans, four direct assertions, helper call counts and all three shared-
      source hashes.
- [ ] Require exactly one stage with eight globally unique identities for the
      three Settings expansions, visible toggle, Room readiness, exact timeline
      row, positive private receipt and absent public receipt according to the
      pinned source-to-record mapping; preserve persisted-off state as a
      required supporting receipt without inventing a ninth parity identity.
- [ ] Require fresh sender/reader Accounts, exact private Room invite/join and
      sender-authored exact message before any reader Room open.
- [ ] Require native Settings/toggle/return/Room ownership and explicitly reject
      browser `goto`, direct URL navigation and preference mutation.
- [ ] Require bounded real-server receipt observation where the private reader
      receipt becomes positive before the sender-view public-receipt absence is
      accepted.
- [ ] Reject seeded receipts, UI-only privacy inference, receipt checks for a
      different reader/Room/message, DOM click/focus/fill/submit/navigation,
      handler invocation, retries, unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for Account roles, Room preset/invite,
      message body/sender/order, toggle target/state, Settings/Back/Room route,
      timeline scoping, private/public receipt types and ordering, cleanup and
      redaction.
- [ ] Run
      `pnpm exec vitest run scripts/read-receipt-privacy-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and receipt fixture

**Files:**

- Create `e2e/android/read-receipt-privacy-contract.mts`.
- Create `e2e/android/read-receipt-privacy-fixtures.mts`, reusing exact
  lower-level Account/Room operations where possible.

- [ ] Export the exact source mapping, single stage id/count and all eight
      identities; assert the total and global uniqueness at module load.
- [ ] Create and login fresh reader/sender Accounts, create one private Room as
      sender, invite/join the reader and publish the exact message as sender
      before returning the fixture.
- [ ] Retain sanitized exact Room/message/sender/reader facts, including the
      exact message event id, while keeping passwords and both access tokens
      closure-private.
- [ ] Provide finite receipt observers over each real Account's Synapse view,
      scoped to the exact Room/reader and preserving receipt type plus event-id
      evidence without serializing raw sync payloads.
- [ ] Poll only the reader view until a real `m.read.private` receipt from that
      reader covers the exact message, then inspect the sender view and prove no
      public `m.read` from that reader exists.
- [ ] Aggregate cleanup must handle partial setup and restore the reader's
      setting before bounded Account/Room/application teardown.
- [ ] Extend the focused guard so wrong receipt user/type/event/Room, public-
      absence-before-private-positive ordering, unbounded sync work or leaked
      secrets fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native privacy and Room journey

**Files:**

- Create `e2e/android/read-receipt-privacy-journeys.mts`.

- [ ] Sign in as the reader and navigate natively from Rooms to Settings →
      Privacy, recording the exact three expanded Settings identities.
- [ ] Prove the send-read-receipts control is visible, activate it natively to
      turn it off before opening the Room, and observe the exact persisted off
      state without mutating preference storage.
- [ ] Return to Rooms through Android Back or the exact production control,
      never through browser navigation, then open the exact target Room
      natively and record Room readiness.
- [ ] Scope the installed timeline to the exact message event id/body and prove
      `Did you read this?` is visible in a message row rather than only in the
      Room-list preview.
- [ ] Invoke the receipt fixture only after timeline visibility; prove the
      reader's positive private receipt first and then the sender's absence of a
      public receipt from that reader.
- [ ] Record all eight identities exactly once and write started-stage reports,
      pass/failure secret-safe captures, exact assertion accounting and fixture/
      native-action/preference/Room/message/receipt-order receipts.
- [ ] Scan aggregate diagnostics for credentials and both access tokens; always
      restore settings, clear application data, close the client and release
      Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `read-receipt-privacy` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.read-receipt-privacy` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after who-reacted with a bounded wrapper
      and started marker; add started-only `android-read-receipt-privacy`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, eight identities/one stage, native Privacy
      toggle and Room return, exact message row, positive private/absent public
      receipt proof, secrets, settings restoration and teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run
      `pnpm nx run trinity-e2e-android:read-receipt-privacy --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 8/8
      identities, attempt 1 and retries 0 each time.
- [ ] Audit fixture/native Settings/toggle/Back/Room/timeline/private/public-
      receipt receipts; require no raster artifacts and clean Matrix/settings/
      application/device teardown.
- [ ] Run the unchanged read-receipts-privacy browser predecessor with one
      worker and `--retries=0`; require its sole definition to pass, then
      recheck all four pinned source hashes.
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
      stage, 8/8 identities, attempt 1/retries 0, native Settings/toggle/Back/
      Room/message receipts, positive-private-before-absent-public evidence,
      redaction, settings restoration, teardown and clean worktree.
- [ ] Post evidence to #760, #660, #653 and PR #677; close #760 only after all
      acceptance evidence is complete, then continue with #761.
