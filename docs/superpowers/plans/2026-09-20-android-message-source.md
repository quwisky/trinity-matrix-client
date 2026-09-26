# Android Message Source Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical message View
source definition while preserving its Playwright predecessor and comparing
the parsed dialog JSON to the exact authoritative Matrix event.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, the exact ten-identity ownership and every forbidden shortcut. One
serial Node/Maestro stage arranges only a disposable Account and Room, then
sends the owned text through the native composer. Matrix observation supplies
the authoritative ready event. Maestro opens the exact row's Android action
sheet and View source dialog; read-only renderer inspection parses the JSON and
measures the dialog's computed opaque paint surface.

**Issue:** #752, blocked on #751 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-source predecessor, application-login and
  account sources unchanged.
- Record exactly ten unique identities in one stage: seven direct plus expanded
  Room readiness, real-server echo and action-sheet readiness.
- Arrange only the Account and Room through REST. Enter/send the exact owned
  text through native product input; never seed it through REST.
- Maestro owns every reachable product action: login, Room navigation,
  composer input/send, exact-row long press and View source selection.
- Renderer inspection is read-only. It may parse exact dialog JSON and observe
  computed paint state but may not invoke handlers, focus, fill, submit, scroll
  or navigate.
- Open only a server-ready event row. Compare parsed fields exactly to the
  authoritative event id, type, sender, Room id and body; substring-only JSON
  evidence is insufficient.
- Prove actual computed opacity, border and shadow on a non-zero installed
  dialog surface. CSS classes or screenshots do not prove paint.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials/tokens while preserving the event fields
  under test in structured evidence.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-source-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact definition/Room-helper spans, Android
      action-sheet branch plus application-login and account source hashes.
- [ ] Prove exactly seven direct assertions plus one Room, one real-server echo
      and one action-sheet readiness identity, and require ten globally unique
      contract identities.
- [ ] Require native exact-text send, ready event id, exact-row native sheet/
      View source, one visible dialog, strict JSON parse and exact comparison of
      event id/type/sender/Room id/body.
- [ ] Require non-zero dialog geometry, fully opaque computed background,
      non-zero border and non-`none` computed shadow over the conversation.
- [ ] Reject REST-seeded owned text, pending local echoes, desktop hover menu,
      substring-only JSON, wrong/unscoped events, CSS/screenshot paint proof,
      DOM click/focus/fill/submit/navigation, retries, unbounded waits and weak
      cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for sent body, event readiness and every
      compared JSON field, sheet/View-source ownership, dialog count/
      visibility, background alpha parsing, dimensions, border width, shadow,
      cleanup and selective redaction.
- [ ] Run `pnpm exec vitest run scripts/message-source-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and authoritative event observer

**Files:**

- Create `e2e/android/message-source-contract.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if bounded exact
  sent-event observation cannot be composed from existing fixture operations.

- [ ] Export exact source mappings and all ten identities; assert count and
      uniqueness at module load.
- [ ] Arrange one fresh Account/private Room without any owned message and keep
      credentials/tokens closure-private.
- [ ] Add a finite Room-timeline observer that selects exactly one ready
      `m.room.message` by exact sender/body and returns a sanitized authoritative
      receipt containing event id, type, sender, Room id and body.
- [ ] Reject duplicate/ambiguous matches and any event lacking a real server id
      or exact Room association.
- [ ] Define structured-evidence allowlisting so the five event fields survive
      capture while credentials, access/authorization/session data and unrelated
      raw event content remain redacted.
- [ ] Extend the focused guard so REST-seeded text, wrong event selection,
      unbounded polling, over-retained event content or leaked secrets fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native View source stage

**Files:**

- Create `e2e/android/message-source-journeys.mts`.

- [ ] Sign in and open the exact Room natively; record expanded Room readiness.
- [ ] Enter and send the exact run-scoped `inspect me …` body through native
      composer input, prove its row visible and wait for the authoritative event
      id before any long press.
- [ ] Long-press that exact event-id row natively, record action-sheet readiness
      and choose the exact View source action through native touch.
- [ ] Prove exactly one message-source dialog is visible, extract only its JSON
      text and require strict parsing as one object.
- [ ] Compare parsed `event_id`, `type`, `sender`, `room_id` and
      `content.body` exactly to the authoritative receipt; reject missing,
      mismatched or merely substring-matching fields.
- [ ] Read the dialog surface's non-zero rectangle and computed background,
      border widths and box shadow. Parse CSS Color 3/4 alpha safely and require
      alpha exactly one, at least one non-zero border edge and shadow not
      `none`.
- [ ] Record all ten identities exactly once and write started-stage reports,
      pass/failure secret-safe captures, exact assertion accounting and
      structured event/dialog/paint receipts.
- [ ] Scan aggregate diagnostics with the event-field allowlist; always clear
      application data, close the client and release Matrix/device resources,
      including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-source` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-source` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-receipts with a bounded
      wrapper and started marker; add started-only `android-message-source`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, ten identities, native send/sheet/View source,
      authoritative parsed-event comparison, selective evidence redaction,
      computed paint proof, teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-source --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 10/10
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session/authorization tokens and unrelated event content while
      confirming only the five allowed event fields remain; require no raster
      artifacts and clean Matrix/application/device teardown.
- [ ] Run the complete unchanged message-source browser predecessor with one
      worker and `--retries=0`; require the exact definition to pass, separately
      prove its Android action-sheet branch in the installed journey and recheck
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
      exact browser predecessor, dedicated Android artifact, 1/1 stage, 10/10
      identities, attempt 1/retries 0, native-send/sheet/parsed-event/opaque-
      paint receipts, selective redaction, teardown and clean worktree.
- [ ] Post evidence to #752, #660, #653 and PR #677; close #752 only after all
      acceptance evidence is complete, then continue with #753.
