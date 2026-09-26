# Android Message Markdown Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for all three canonical message
Markdown definitions while preserving their Playwright predecessors and
proving both renderer semantics and authoritative Matrix wire format.

**Architecture:** A focused Vitest guard pins the predecessor, composer helper
and shared login sources, the exact three-stage/32-identity ownership and every
forbidden shortcut. One serial Node/Maestro journey creates a disposable
Account and Room per stage. Maestro/device input owns login, Room opening,
multiline Markdown entry, send and code-row long press. A bounded Matrix
observer proves ready server events and their exact wire bodies; read-only
renderer observations prove the bold/break, task-glyph and Android code-block
interaction contracts.

**Issue:** #748, blocked on #747 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-markdown predecessor, message-composer helper,
  application-login and account sources unchanged.
- Record exactly 32 globally unique identities across three stages, preserving
  20 direct plus 12 helper-expanded records. Stage totals are 16 formatting/
  wire, 6 task list and 10 code caption/action sheet.
- Arrange only Accounts and Rooms through Matrix REST. Every owned message must
  be entered and sent through real Android composer/device input; never seed it
  through REST or inject editor values/events.
- Maestro/device input owns every reachable product action: login, Room open,
  multiline/Markdown typing, Enter send and code-row long press.
- Renderer inspection is read-only. It may observe exact markup, generated
  content and interaction state but may not invoke handlers, focus, fill,
  submit, scroll or navigate.
- Treat only a ready event id read from the homeserver as authoritative. Local
  echo or visible text alone does not prove wire shape.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials and access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-markdown-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact three definition/event-reader spans,
      composer helper hash/input semantics and application/account hashes.
- [ ] Prove exactly 20 direct assertions plus expansion through three Room
      readiness, five composer-send readiness, three real-server echo and one
      action-sheet readiness identity.
- [ ] Require the exact three stages and 32 unique identities with stage counts
      `16 + 6 + 10`.
- [ ] Require native multiline input for every exact source, server-ready ids,
      exact plain-vs-formatted wire distinctions, source-body retention, task
      glyph/no-input semantics and Android code continuation/caption/sheet
      behavior.
- [ ] Reject REST-seeded owned messages, injected editor events/values,
      local-echo authority, visual wrapping as a `<br>`, task text without
      glyph/input proof, desktop hover-tail migration, DOM click/focus/fill/
      submit/navigation, retries, unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for native input/line breaks, every
      plaintext/formatted event field, bold/`br` structure, task continuation/
      glyph/input state, code continuation/toolbar/caption/sheet state, cleanup
      and redaction.
- [ ] Run `pnpm exec vitest run scripts/message-markdown-migration.spec.mjs`
      and preserve the expected RED result.

## Task 2: Add the exact contract and authoritative event observer

**Files:**

- Create `e2e/android/message-markdown-contract.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if a bounded exact
  Room-event observer cannot be composed from existing fixture operations.

- [ ] Export exact source mappings, three stage ids, stage counts and all 32
      identities; assert totals and global uniqueness at module load.
- [ ] Arrange one fresh Account/private Room per stage without any owned
      message and keep credentials/tokens closure-private.
- [ ] Add a finite Room-timeline observer that selects ready
      `m.room.message` events by exact sender/body/order and returns sanitized
      event id plus only the owned content fields.
- [ ] For the formatting stage, require exact ordered plain and formatted
      events and reject duplicate/missing/ambiguous matches.
- [ ] For task/code stages, require exact source bodies and ready ids without
      normalizing Markdown, newline or fence content.
- [ ] Extend the focused guard so wrong event ordering/sender/type/body,
      premature local echo, missing ready id, unbounded polling or leaked
      credentials/tokens fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement exact formatting and wire-format stage

**Files:**

- Create `e2e/android/message-markdown-journeys.mts`.

- [ ] Sign in and open the exact Room natively; record expanded Room readiness.
- [ ] Enter `plain one`, a real Android newline and `plain two`, then send with
      native Enter and record composer-send readiness.
- [ ] Prove the exact plain row visible, then enter `**bold one**`, a real
      Android newline and `rich two`, send natively and prove exact rich row,
      `<strong>` text and exactly one real `<br>`.
- [ ] Wait for both exact server-ready events. Prove the plain content body is
      exactly `plain one\nplain two` with both `format` and `formatted_body`
      absent.
- [ ] Prove formatted content has exact
      `format = org.matrix.custom.html`, `formatted_body` containing exact
      `<br>` and `<strong>bold one</strong>`, and source `body` exactly
      `**bold one**\nrich two`.
- [ ] Record all 16 stage identities once and retain a sanitized ordered event
      receipt.

## Task 4: Implement task-list and code-block stages

- [ ] Task stage: open its Room natively; type exact first line
      `- [x] shipped`, use real Android continuation input, type only `pending`
      on the second line and send natively.
- [ ] Prove a ready exact server event, visible HTML list, exact `☑ shipped`
      and `☐ pending` glyph text, and zero interactive `input` elements. Record
      all six identities exactly once.
- [ ] Code stage: send exact `setting up`, then enter the exact three-line
      fenced source `['```python', 'x = 1', '```']` through native
      multiline input and send it natively.
- [ ] Prove the code event is server-ready, its row is a continuation, its real
      `pre` is visible, it has zero desktop `.msg__toolbar` elements and its
      generated caption content contains exact `python`.
- [ ] Long-press the exact code row natively and prove the Android message-
      action sheet is visible as the positive interaction-model control. Record
      all ten identities exactly once.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, input/event/markup/generated-content/action-sheet
      receipts and aggregate cleanup/redaction scans.
- [ ] Always clear installed application data, close the client and release
      Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 5: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-markdown` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-markdown` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-links with a bounded
      wrapper and started marker; add started-only `android-message-markdown`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, 32 identities/three stages, native input,
      authoritative wire evidence, plain/formatted/task/code contracts,
      native/REST/renderer boundaries, secrets, teardown and predecessor
      coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 6: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-markdown --skipNxCache`
      three times sequentially on unchanged inputs; require 3/3 stages, 32/32
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens and bearer patterns; require no raster artifacts
      and clean Matrix/application/device teardown.
- [ ] Run the complete unchanged message-markdown browser predecessor with one
      worker and `--retries=0`; require all three definitions to pass, and
      separately require the installed stage to prove the Android early-return
      branch, then recheck all four pinned source hashes.
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
      exact browser predecessor, dedicated Android artifact, 3/3 stages, 32/32
      identities, attempt 1/retries 0, native-input/event/wire/markup/task/code/
      action-sheet receipts, redaction, teardown and clean worktree.
- [ ] Post evidence to #748, #660, #653 and PR #677; close #748 only after all
      acceptance evidence is complete, then continue with #749.
