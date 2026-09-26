# Android Message Linkify Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical bare-URL
linkification definition while preserving its complete Playwright predecessor
and never activating the rendered link.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, the exact two-identity assertion ownership and every forbidden
shortcut. One serial Node/Maestro stage arranges a disposable Matrix Account
and private Room. Maestro owns login, Room navigation, composer input and send.
Matrix REST observes the resulting server event, while a bounded read-only
renderer observation proves that the exact plaintext URL substring alone
became one visible anchor with the exact text and destination and that the
surrounding copy remained plain content.

**Issue:** #746, blocked on #745 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-linkify predecessor, application-login and
  account sources unchanged.
- Record exactly two unique identities in one stage: expanded Room readiness
  and exact bare-URL linkification.
- Matrix REST may arrange the Account and Room and observe the sent event.
  Maestro owns every product action: login, Room navigation, composer input and
  send.
- Renderer access is read-only. It may observe the exact sent event row,
  element/text-node structure, visibility and literal `href` attribute, but
  may not invoke the link or any handler, focus, fill, submit, scroll or
  navigate.
- Send exact plaintext `look at https://example.com`; never seed formatted
  HTML, intercept rendering, open an external browser or contact the public
  destination.
- Prove one server-ready `m.room.message` event retains the exact plaintext
  body and that exactly the URL substring—not the surrounding `look at ` copy—
  is represented by one anchor with exact text and destination.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials and access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-linkify-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact definition/helper/message spans plus
      application-login and account source hashes.
- [ ] Prove one direct assertion plus one helper-expanded readiness assertion
      and require exactly two globally unique contract identities in one
      stage.
- [ ] Require a fresh Account/private Room and exact plaintext composer send,
      followed by one exact server-ready event id/type/body observation.
- [ ] Require native login/Room/composer actions and a read-only observation of
      the exact event row containing one visible anchor with literal text and
      `href` both exactly `https://example.com` plus plain surrounding copy.
- [ ] Reject fixture-seeded formatted content, duplicate/non-exact anchors,
      Room-list preview evidence, DOM/native link activation, public URL
      navigation, external-browser assertions, interception, DOM click/focus/
      fill/submit/navigation, retries, unbounded waits and weak cleanup/
      redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for readiness, exact sent body/event id,
      anchor count/visibility/text/literal destination/subrange, surrounding
      text-node retention, native ownership, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/message-linkify-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and sent-event observer

**Files:**

- Create `e2e/android/message-linkify-contract.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if an exact bounded
  sent-message observer cannot be composed from existing fixture operations.

- [ ] Export exact source mappings and the two-identity assertion map; assert
      count and uniqueness at module load.
- [ ] Arrange only the fresh Account and private Room before product actions;
      do not seed the owned message through Matrix REST.
- [ ] Poll the Room timeline with a finite deadline for exactly one ready
      `m.room.message` from the test Account whose body is exactly
      `look at https://example.com`; retain its event id and sanitized body/type
      receipt.
- [ ] Keep credentials and access tokens closure-private and return only
      sanitized Account/Room/event facts.
- [ ] Extend the focused guard so pre-seeded messages, wrong/duplicate event
      bodies, missing ready event ids, unbounded polling or leaked credentials/
      tokens fail.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native linkification stage

**Files:**

- Create `e2e/android/message-linkify-journeys.mts`.

- [ ] Arrange the Account/Room, sign into the installed app and open the exact
      Room through native actions; prove composer visibility as the expanded
      readiness identity.
- [ ] Focus and fill the native composer with exact plaintext
      `look at https://example.com`, send it through the production control and
      obtain the resulting exact ready event id/body from Synapse.
- [ ] Scope renderer observation to that exact event-id row and its real
      message body. Prove exactly one visible anchor, literal anchor text and
      `href` both exactly `https://example.com`, full body text exactly the sent
      plaintext, and a direct non-anchor text node retaining exact surrounding
      copy `look at `.
- [ ] Prove the anchor covers only the URL substring and record all server and
      renderer facts atomically as the one direct linkification identity.
- [ ] Never dispatch a link event, click/tap the anchor, observe a browser,
      navigate, fetch the public destination or use renderer mutation/input.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, sent-event/link-structure receipts and aggregate
      cleanup and redaction scans.
- [ ] Always clear installed application data, close the client and release
      Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-linkify` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-linkify` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-grouping with a bounded
      wrapper and started marker; add started-only `android-message-linkify`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, two identities, exact native send and
      server-event proof, native/REST/renderer boundaries, non-activation,
      exact anchor/text-node semantics, secrets, teardown and predecessor
      coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-linkify --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 2/2
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens and bearer patterns; require no raster artifacts,
      no destination-network evidence and clean Matrix/application/device
      teardown.
- [ ] Run the complete unchanged message-linkify browser predecessor with one
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
      2/2 identities, attempt 1/retries 0, exact sent-event/link-structure
      receipts, non-activation, redaction, teardown and clean worktree.
- [ ] Post evidence to #746, #660, #653 and PR #677; close #746 only after all
      acceptance evidence is complete, then continue with #747.
