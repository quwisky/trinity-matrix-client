# Android Jump To Date Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the Android-applicable
canonical jump-to-date definition while preserving both Playwright definitions
and their deliberate browser-only boundary.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, the exact applicable/excluded spans and all forbidden shortcuts. One
serial Node/Maestro stage arranges a disposable Matrix Account and private Room,
sends an exact marker followed by 120 later messages, and retains the marker
event id inside a closure-private fixture. Maestro owns login, Room/overflow
navigation and dialog confirmation. Read-only renderer and bounded CDP Network
observations prove the marker is outside the initial window, the production
date default is used, `/timestamp_to_event` is requested, and the exact marker
event is rendered only after real pagination.

**Issue:** #737, blocked on #736 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned jump-to-date predecessor, application-login and account
  sources unchanged, including both canonical definitions.
- Record exactly five unique identities in one Android stage: four direct
  assertions and one Room helper composer-readiness expansion.
- Keep `reports a date with nothing on it instead of jumping` browser-only. Do
  not remove the production input maximum, inject a future date or dispatch an
  input event in the installed journey.
- Matrix REST may arrange the Account, Room and ordered messages. Maestro owns
  every product action: login, Room/overflow/dialog navigation and Jump.
- Renderer/CDP access is read-only. It may observe exact text, input value,
  event identity and sanitized Network request facts, but may not invoke
  handlers, focus, fill, submit or navigate.
- Require 120 successfully sent filler events after the awaited marker event,
  newest-filler visibility and exact marker-event absence before opening the
  dialog.
- Use one attempt, zero retries, finite observation and bounded Network,
  Matrix/application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access tokens and message secrets.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/jump-to-date-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact Room helper, Android-applicable
      definition and browser-only definition spans, plus application-login and
      account source hashes.
- [ ] Prove four direct assertion sites and one Room helper expansion for five
      unique Android parity identities.
- [ ] Require the exact stage ID, all five contract identities and the explicit
      browser-only exclusion metadata.
- [ ] Require awaited marker creation followed by exactly 120 filler sends,
      retained exact event ids and proof all filler sends completed.
- [ ] Require newest-filler visibility, marker-event absence from the initial
      DOM, exact device-local current-date value, native overflow/dialog/Jump
      actions, a bounded exact `/timestamp_to_event` Network observation and
      rendered `data-mid` equality with the marker event id.
- [ ] Reject DOM click/focus/fill/submit/navigation, `removeAttribute('max')`,
      input-event injection, future-date synthesis, renderer mutation, request
      interception, retries, unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and both predecessors.
- [ ] Add effective mutation controls for send ordering/count, initial-window
      exclusion, exact current date, Network path/method/direction, marker
      event identity, native ownership, observer close, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/jump-to-date-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and bounded fixture seams

**Files:**

- Create `e2e/android/jump-to-date-contract.mts`.
- Create `e2e/android/jump-to-date-network-observer.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts`.

- [ ] Export exact source mappings, the five-identity assertion map and the
      browser-only exclusion; assert count and uniqueness at module load.
- [ ] Add a closure-private fixture that creates the Account and Room, awaits
      the marker send, captures its exact event id, sends all 120 fillers only
      afterward in bounded batches and proves every response supplied a unique
      event id.
- [ ] Return sanitized room/name/body/event facts only; keep credentials and
      access token inside the fixture closure.
- [ ] Add a bounded Network observer that records only sanitized
      `/timestamp_to_event` request facts for the exact Room, proves a GET with
      `dir=f` and finite timestamp, and always disables Network/unsubscribes.
- [ ] Compute expected `YYYY-MM-DD` from the emulator/device-local calendar and
      expose only that non-secret value for read-only comparison.
- [ ] Extend the focused guard so wrong ordering/count, duplicate/missing event
      ids, broad Network capture, interception, wrong Room/direction/date or
      leaked secrets fail.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native backfill stage

**Files:**

- Create `e2e/android/jump-to-date-journeys.mts`.

- [ ] Arrange the marker and 120 later fillers, sign into the installed app and
      open the Room through native actions.
- [ ] Prove composer readiness, exact newest-filler visibility and zero
      renderer matches for `.scroll .msg[data-mid=<marker-event-id>]` before
      the jump.
- [ ] Start the scoped Network observer, open Room overflow and Jump to date
      through native touch, prove the date input is visible, enabled and already
      equal to the device-local current date, and tap the exact Jump control
      without filling or mutating the input.
- [ ] Prove the observer captured the exact Room timestamp lookup with forward
      direction and that the bounded pagination path eventually rendered a
      visible `.scroll .msg` whose `data-mid` equals the marker event id and
      whose text equals the marker body.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, ordered event receipts, sanitized Network facts
      and aggregate cleanup and redaction scans.
- [ ] Always close the Network observer before the client/device, clear
      installed application data and release Matrix/device resources,
      including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `jump-to-date` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.jump-to-date` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after hide-system-messages with a
      bounded wrapper and started marker; add started-only
      `android-jump-to-date` diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, five identities, the retained browser-only
      definition, 120-message ordering, native/REST/renderer/Network
      boundaries, exact event proof, secrets, teardown and predecessor
      coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:jump-to-date --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 5/5
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens, bearer patterns and exact message secrets; require
      no raster artifacts, no live Network observer and clean
      emulator/application teardown.
- [ ] Run the complete unchanged jump-to-date browser predecessor with one
      worker and `--retries=0`; require both definitions to pass and recheck all
      three pinned source hashes.
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
      both browser predecessors, dedicated Android artifact, 1/1 stage, 5/5
      identities, attempt 1/retries 0, ordered-event/Network receipts, exact
      marker-event proof, redaction, teardown and clean worktree.
- [ ] Post evidence to #737, #660, #653 and PR #677; close #737 only after all
      acceptance evidence is complete, then continue with #738.
