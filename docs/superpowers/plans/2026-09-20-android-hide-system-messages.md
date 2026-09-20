# Android Hide System Messages Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical
hide-system-messages definition while preserving its complete Playwright
predecessor.

**Architecture:** A focused Vitest guard pins the predecessor, navigation and
shared login sources, their exact assertion expansion and every forbidden
shortcut. One serial Node/Maestro stage arranges two disposable Matrix
accounts, a private Room, a distinctive membership event and a later text
message through closure-private REST fixtures. Maestro owns login, Room and
Settings navigation and the membership-toggle action. Read-only renderer
observations prove exact timeline behavior, while a native SharedPreferences
observer proves the durable production preference before and after a real
installed-host cold relaunch.

**Issue:** #736, blocked on #735 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned hide-system-messages predecessor, Android navigation
  helper, application-login and account sources unchanged.
- Record exactly 13 unique identities in one stage: seven direct predecessor
  assertions, three Room helper readiness expansions and three inherited
  Android Settings-navigation identities.
- Matrix REST may arrange Accounts, Room membership and the later message.
  Maestro owns every product action: login, Room and Settings navigation,
  toggle use, post-toggle return and post-relaunch reopening.
- Renderer access is read-only and may prove exact text visibility/count only.
  Native storage access may observe the exact persisted preference but may not
  invoke the application Preferences bridge or mutate application state.
- Treat the filtering result as valid only when the distinctive join line is
  absent and the exact later message remains visible in the timeline, not only
  in the Room-list preview.
- Use one attempt, zero retries, finite observations, a real force-stop/relaunch
  and bounded Matrix/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access tokens and message secrets.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/hide-system-messages-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact helper/definition spans, plus the
      navigation, application-login and account source hashes.
- [ ] Prove seven direct assertion sites, exactly three `openRoom` expansions
      and exactly three inherited Android Settings-navigation identities.
- [ ] Require the single exact stage ID and all 13 contract identities with
      global uniqueness.
- [ ] Require native login, Room/Settings navigation, toggle action, Room
      return, force-stop/relaunch and post-relaunch reopening.
- [ ] Require exact `trinity.timeline.show-membership` native-preference
      observation with default-enabled and persisted-false proof.
- [ ] Require the distinctive join line and later exact message to be visible
      before the toggle, then require exact message survival plus join-line
      absence after the toggle and after cold relaunch.
- [ ] Reject DOM click/focus/fill/submit/navigation, renderer mutation,
      WebView-local storage proof, soft reloads, retries, unbounded waits, weak
      cleanup and missing redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for default state, toggle target,
      preference key/value, timeline scoping, message survival, join
      suppression, cold relaunch, native ownership, cleanup and redaction.
- [ ] Run
      `pnpm exec vitest run scripts/hide-system-messages-migration.spec.mjs`
      and preserve the expected RED result.

## Task 2: Add the exact contract and native preference observer

**Files:**

- Create `e2e/android/hide-system-messages-contract.mts`.
- Create `e2e/android/timeline-membership-preference.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if an exact missing
  closure-private Matrix operation cannot be composed from existing helpers.

- [ ] Export exact source mappings and the single grouped assertion map;
      assert 13 identities and uniqueness at module load.
- [ ] Parse only the exact `trinity.timeline.show-membership` entry from
      `shared_prefs/CapacitorStorage.xml`, decode XML safely and fail closed on
      duplicate or malformed values.
- [ ] Observe native default absence/enabled semantics and persisted `false`
      through `run-as` plus a bounded native-shell poll without returning raw
      Preferences XML.
- [ ] Arrange two fresh Accounts, exact display name, private Room, join event
      and later `m.text` event with tokens retained inside fixture closures.
- [ ] Return only sanitized Account/Room/event identities needed for the
      journey; never use REST responses as renderer assertion proof.
- [ ] Extend the focused guard so wrong preference file/key/value, ambiguous
      membership event, wrong sender/message ordering or leaked secrets fail.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native filtering stage

**Files:**

- Create `e2e/android/hide-system-messages-journeys.mts`.

- [ ] Arrange a disposable host and joiner, assign the joiner a distinctive
      display name, create/invite/join a private Room and send the exact later
      message after the join event.
- [ ] Sign the host into the installed app and open the Room through native
      actions; prove composer readiness, exact join-line visibility and the
      exact later message in a `trn-message-row`.
- [ ] Navigate natively to Settings → Appearance, prove the visible and enabled
      `Show joins and leaves` control, tap the exact switch through native touch,
      and prove native `trinity.timeline.show-membership` persisted `false`.
- [ ] Return to the same Room through native actions; prove the exact message
      remains in the timeline and the distinctive join line has count zero.
- [ ] Force-stop and relaunch the installed host without clearing data,
      reopen the same Room natively, re-prove composer readiness, persisted
      native `false`, message survival and join-line absence.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, native-preference receipts and aggregate cleanup
      and redaction scans.
- [ ] Always close the client, clear installed application data, remove
      disposable Matrix state where supported and close the device, including
      on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `hide-system-messages` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.hide-system-messages` as required current hosted
      Android coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after GIF picker with a bounded wrapper
      and started marker; add started-only `android-hide-system-messages`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, 13 identities, native/REST/renderer
      boundaries, durable preference proof, survivor requirement, cold
      relaunch, secrets, teardown and retained predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run
      `pnpm nx run trinity-e2e-android:hide-system-messages --skipNxCache`
      three times sequentially on unchanged inputs; require 1/1 stage, 13/13
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens, bearer patterns and exact message secrets; require
      no raster artifacts, no raw Preferences XML and clean
      emulator/application teardown.
- [ ] Run the complete unchanged hide-system-messages browser predecessor with
      one worker and `--retries=0`; require the exact test to pass and recheck
      all five pinned source hashes.
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
      13/13 identities, attempt 1/retries 0, native-preference receipt,
      message-survival/join-suppression proof, redaction, teardown and clean
      worktree.
- [ ] Post evidence to #736, #660, #653 and PR #677; close #736 only after all
      acceptance evidence is complete, then continue with #737.
