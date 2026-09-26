# Android Message Quote Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for both canonical message-
quote definitions while preserving their Playwright predecessors and proving
the multiline quote's authoritative event/HTML shape plus the image row's
negative capability contract.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, the exact two-stage/20-identity ownership and every forbidden
shortcut. One serial Node/Maestro journey runs a quote stage and a capability
stage in disposable Rooms. Maestro/device input owns multiline text, sends,
long presses, Quote and Cancel. REST arranges only the pinned PNG image and
observes authoritative events; read-only renderer observations prove exact
composer, blockquote and Android-sheet state.

**Issue:** #750, blocked on #749 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-quote predecessor, application-login and account
  sources unchanged.
- Record exactly 20 globally unique identities across two ten-identity stages,
  preserving 13 direct plus seven helper-expanded records: two Room readiness,
  two real-server echo and three action-sheet readiness identities.
- Arrange Accounts/Rooms and only the pinned `m.image` fixture through REST.
  The quoted source, answer and text control must use real native composer input
  and send.
- Maestro/device input owns every reachable product action: login, Room open,
  multiline entry/send, long presses, Quote selection and Cancel.
- Renderer inspection is read-only. It may observe exact composer/render/sheet
  state but may not invoke handlers, focus, fill, submit, scroll or navigate.
- A quote is Markdown-derived content, not a reply: reject any
  `m.in_reply_to` relation. Require one real blockquote containing both source
  paragraphs and excluding the answer.
- Quote absence for the image is valid only in its opened native sheet with
  Copy visible as the positive per-message capability control.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access tokens and media authorization.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-quote-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact two definition/helper spans, Android
      branches, pinned 1×1 PNG base64/MIME/name and multiline source shape plus
      application-login and account hashes.
- [ ] Prove exactly 13 direct assertions plus expansion through two Room, two
      real-server-echo and three action-sheet readiness identities.
- [ ] Require the exact two stages, ten identities each and 20 globally unique
      identities total.
- [ ] Require native multiline source/answer/control input, ready source and
      quote events, exact inserted quote text, body/HTML/no-reply relation,
      both-paragraph blockquote/answer exclusion, text Quote positive control,
      Cancel closure and image Copy-positive/Quote-negative capability.
- [ ] Reject REST-seeded owned text, desktop hover menus, quoted image filename,
      reply relations, plain quote-looking text without a blockquote, unopened-
      sheet absence, DOM click/focus/fill/submit/navigation, retries, unbounded
      waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for blank-line input, inserted composer
      value, source/answer body, formatted quote HTML, relation absence,
      blockquote containment, text/image row scoping, sheet controls/closure,
      PNG fixture, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/message-quote-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and event/media fixture support

**Files:**

- Create `e2e/android/message-quote-contract.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if exact media upload
  or bounded sent-event observation cannot be composed from existing helpers.

- [ ] Export exact source mappings, two stage ids, ten-record stage counts and
      all 20 identities; assert totals and global uniqueness at module load.
- [ ] Arrange one fresh Account/private Room per stage without owned text and
      keep credentials/tokens closure-private.
- [ ] Add a finite exact event observer that validates sender, ready event id,
      plaintext body, formatted body/format and relation content without
      accepting duplicate or ambiguous matches.
- [ ] Upload the exact pinned 1×1 PNG bytes as `image/png`/`shot.png`, send only
      that `m.image` fixture through REST and retain a sanitized exact image
      event id/URI receipt.
- [ ] Reject any REST operation that sends the quoted source, answer or text
      control, and never expose raw media authorization or access tokens.
- [ ] Extend the focused guard so wrong PNG bytes/type/name, wrong message
      sender/order/type/body/HTML/relation, missing ready id, unbounded polling
      or leaked secrets fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native multiline quote stage

**Files:**

- Create `e2e/android/message-quote-journeys.mts`.

- [ ] Sign in and open the exact Room natively; record expanded Room readiness.
- [ ] Enter the run-scoped first paragraph, a real blank line and second
      paragraph through native Android composer input, then send natively.
- [ ] Wait for the exact source row and authoritative source event id; long-
      press that exact row and select Quote through the native sheet.
- [ ] Prove the composer value is exactly
      `> first\n>\n> second\n\n` with the run-scoped paragraph values substituted,
      including the marked blank line and trailing answer separator.
- [ ] Enter the exact run-scoped answer natively and send; observe the ready
      authoritative event and prove its body and formatted HTML contain both
      source paragraphs while no `m.in_reply_to` relation exists.
- [ ] Scope the installed renderer to that exact quote event and prove exactly
      one blockquote contains both paragraphs and excludes the answer.
- [ ] Record all ten quote-stage identities exactly once and retain sanitized
      source/quote event receipts.

## Task 4: Implement the text/image capability stage

- [ ] Arrange the pinned image fixture, sign in and open the Room natively, then
      enter/send the exact plain-text control through the native composer and
      wait for its real event id.
- [ ] Long-press the exact text event row natively; prove its Android sheet
      shows Quote, tap exact Cancel natively and prove the sheet closes.
- [ ] Long-press the exact image event row, scoped by its event id rather than
      filename alone; prove the same native sheet exposes Copy and contains
      zero Quote controls.
- [ ] Record all ten capability-stage identities exactly once and write
      started-stage reports, pass/failure secret-safe captures, exact assertion
      accounting and input/event/media/sheet receipts.
- [ ] Scan aggregate diagnostics for credentials, access tokens and media
      authorization; always clear application data, close the client and
      release Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 5: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-quote` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-quote` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-poll with a bounded wrapper
      and started marker; add started-only `android-message-quote` diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, 20 identities/two stages, native multiline
      quote semantics, authoritative event/no-reply proof, PNG fixture and
      image capability boundary, secrets, teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 6: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-quote --skipNxCache` three
      times sequentially on unchanged inputs; require 2/2 stages, 20/20
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens, bearer/media authorization and unintended event
      payloads; require no raster artifacts and clean Matrix/application/device
      teardown.
- [ ] Run the complete unchanged message-quote browser predecessor with one
      worker and `--retries=0`; require both definitions to pass, and separately
      require the installed journey to prove both Android sheet branches, then
      recheck all three pinned source hashes.
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
      exact browser predecessor, dedicated Android artifact, 2/2 stages, 20/20
      identities, attempt 1/retries 0, native multiline/source/quote/no-reply/
      blockquote/media/text-image-sheet receipts, redaction, teardown and clean
      worktree.
- [ ] Post evidence to #750, #660, #653 and PR #677; close #750 only after all
      acceptance evidence is complete, then continue with #751.
