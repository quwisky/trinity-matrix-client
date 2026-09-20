# Android Thread Preview Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the three applicable
canonical thread-preview definitions while retaining every Playwright
predecessor and excluding desktop/synthetic-browser behavior from the Android
claim.

**Architecture:** A focused Vitest guard pins the predecessor and shared login,
action-sheet, account and touch sources, exact fixture/helper expansions, the
three-stage/86-identity ownership and every exclusion. One serial Node/Maestro
journey arranges real long/short text and PNG-root thread fixtures through
Synapse. Native input owns summary/reply-preview taps, long press, Reply and
explicit composer send; read-only renderer observations prove content,
truncation, styling and geometry. A real-device dark-mode gate and native-jump
trajectory/viewport/flash evidence replace media emulation and method/scroll
interception.

**Issue:** #765, blocked on #764 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned thread-preview predecessor, application-login/action-
  sheet, account and touch-semantics sources unchanged.
- Record exactly 86 globally unique identities across three stages. Explicit
  quote owns 34: eleven direct + 21 long-preview + one Room + one action-sheet.
  Pixel long-preview owns 25: three direct + 21 preview + one Room. Mobile short
  preview owns 27: seven direct + eight text-preview + eleven image-preview +
  one Room.
- Explicitly retain and exclude the desktop keyboard definition, desktop loop
  branch, density mutation, viewport resizing, media emulation,
  `scrollIntoView` interception and renderer scroll assignment.
- Arrange fresh reader/author Accounts, exact display names, private Rooms,
  Matrix thread relations, two-reply summaries, read markers and, for short
  previews, exactly three intervening rows plus the exact real PNG image root.
- Maestro/native device input owns every reachable product action: login, Room/
  thread navigation, summary/reply-preview taps, ordinary-reply long press,
  action-sheet Reply, explicit composer input/send and any scroll/swipe needed
  to reach targets.
- Renderer inspection is read-only. It may observe exact text/attributes/style/
  geometry/visibility/viewport/trajectory and ready event ids but may not click,
  focus, fill, submit, navigate, invoke handlers, intercept methods, assign
  scrolling, resize the WebView or emulate media.
- Configure real Android dark mode only through device APIs behind a hard
  preflight/state/restore gate. If state cannot be established or restored,
  fail with a machine-readable hard-gate artifact; never substitute a renderer
  class, media emulation or local preference.
- Native quote-preview jump proof must identify the exact ordinary-reply event,
  observe action-relative movement/viewport entry and production flash state;
  the predecessor's intercepted `scrollIntoView` call is not Android evidence.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device/dark-mode teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access tokens, media and event ids.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/thread-preview-migration.spec.mjs`.

- [ ] Pin the predecessor hash, exact fixture/helper/applicable-definition
      spans, PNG bytes, cardinalities/call counts and all three shared-source
      hashes.
- [ ] Prove exact stage totals `34 + 25 + 27 = 86`, source-to-record mappings
      and global identity uniqueness.
- [ ] Require long-preview helper's exact 21 records for content, styling,
      actual truncation/container fit, author allowance and nonzero avatar-
      centered connector geometry.
- [ ] Require explicit fallback suppression/grouping, native thread open,
      ordinary-reply sheet/Reply, native explicit send, visible quote and exact
      native target jump with trajectory/viewport/flash evidence.
- [ ] Require production-device 44×44 px long-summary target and native thread
      opening in the Pixel stage.
- [ ] Require real Android dark state/restore, loaded real PNG, exact text/image
      short-preview content/placement/viewport/connectors, five-row connected
      geometry, equal author widths, equal connector/reply-token colours and
      native text-summary open.
- [ ] Reject desktop keyboard/density claims, DOM actions, assigned values,
      handler/method interception, renderer scroll/offset assignment, WebView
      resizing, media emulation, classes-only geometry, retries, unbounded waits
      and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics, hard-gate artifacts and
      all predecessor/exclusion retention.
- [ ] Add effective mutation controls for every fixture count/relation/body/
      display/media field, all helper/direct totals, long content/truncation/
      connector measures, fallback/explicit-reply state, native jump target/
      movement/flash, target size, dark-state gate, short/image/group/colour
      geometry, native ownership, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/thread-preview-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and thread/media fixtures

**Files:**

- Create `e2e/android/thread-preview-contract.mts`.
- Create `e2e/android/thread-preview-fixtures.mts`, reusing exact lower-level
  Account/Room/media operations where possible.

- [ ] Export exact source mappings, three stage ids/counts, all 86 identities
      and every browser-only exclusion; assert totals/global uniqueness at
      module load.
- [ ] For each stage create fresh reader/author Accounts and a private Room, set
      the exact stage display name, invite/join the author and preserve sanitized
      exact event ids internally.
- [ ] Long fixture: publish the exact root plus two author replies with proper
      `m.thread`, fallback and `m.in_reply_to` relations; preserve exact long
      latest body/prefix, display name and read marker.
- [ ] Short fixture: publish exact `Short text root` plus two replies, then
      exactly three intervening reader rows, upload the pinned 1×1 PNG as
      `short-root.png` with exact metadata, publish the image root and its two
      replies with the exact long image-preview latest body.
- [ ] Retain sanitized Account/Room/body/display/count/order/media/relation facts
      while keeping passwords, access tokens, MXC and event ids closure-private.
- [ ] Provide finite event observers for explicit reply and exact jump target;
      aggregate cleanup must handle partial fixtures and bounded media/Room/
      Account/application/device cleanup.
- [ ] Extend the focused guard so wrong root/reply order/count/relation/fallback,
      read marker, intervening rows, PNG bytes/type/name/metadata, display/body,
      ambiguous target, unbounded work or leaked secret fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement shared long-preview observations

**Files:**

- Create `e2e/android/thread-preview-journeys.mts`.

- [ ] Sign in/open each exact long-preview Room natively and record the stage's
      Room-readiness identity.
- [ ] Scope the exact root by ready event id/body and prove root plus summary
      visible, `2 replies`, exact author, exact latest prefix, time token and
      badge `2`.
- [ ] Prove preview text and author visible; text styles exact `nowrap`, hidden
      overflow and ellipsis.
- [ ] Measure and prove preview/container fit, text/preview fit, genuine
      truncation, nonzero text width, author-width ratio at least 0.3 and within
      40% allowance, avatar-centered connector within 0.5 px and non-none/
      nonzero connector geometry. Record the exact 21 helper identities per
      long stage.

## Task 4: Implement explicit reply and real native jump stage

- [ ] Before opening the thread, prove Room-timeline fallback reply previews
      have zero matches.
- [ ] Tap the exact long summary natively and prove the real thread opens;
      prove ordinary `first reply` visible without quote preview and the latest
      ordinary reply continuation-grouped with no avatar.
- [ ] Long-press the exact ordinary reply natively, record action-sheet
      readiness and choose exact Reply through native touch; prove the thread
      composer banner says `Replying to`.
- [ ] Enter/send the exact run-scoped explicit quote through native Android
      input, prove its row and reply preview visible, and prove the preview
      contains exact `first reply`.
- [ ] Capture the exact ordinary target's pre-action viewport position, tap the
      explicit reply preview natively, then use bounded read-only frame samples
      to prove production movement toward the same event id, viewport entry and
      real flash state after the action. Do not call or intercept scrolling.
- [ ] Record all 34 stage identities exactly once and retain sanitized native-
      jump timing/trajectory/target/flash receipts.

## Task 5: Implement production-device touch-target stage

- [ ] Using a fresh long fixture on the unchanged production device profile,
      prove the exact summary's rendered width and height are each at least
      44 px without resizing the WebView.
- [ ] Tap that exact summary through native input and prove the thread opens;
      record all 25 stage identities exactly once.

## Task 6: Implement real-dark short text/image layout stage

- [ ] Read and retain the exact pre-test Android night-mode state, set real dark
      mode through the device API, prove both system and installed WebView
      effective dark state, and register unconditional exact restoration.
- [ ] Sign in/open the exact short-preview Room natively and record Room
      readiness. Use native swipes only as needed to bring text/image targets
      into view.
- [ ] Text helper: prove exact root visible; summary has two replies, exact
      `Quwisky Example` author and `OK`; and prove below-body, root-left,
      avatar-centered connector and right-edge-in-viewport geometry for eight
      identities.
- [ ] Image helper: first prove media state ready, exact `short-root.png` image
      visible and positive natural width; then prove the same eight records with
      exact long image reply text for eleven identities.
- [ ] Across the actual text/intervening/image connected group, prove at least
      five rows, largest connector gap at most 1 px, connector extent reaches
      the image target and every segment remains avatar-centered within 0.5 px.
- [ ] Prove text/image author widths differ by at most 1 px and text connector
      colour equals the reply-time token colour.
- [ ] Tap the text summary natively and prove the thread opens. Record all 27
      identities exactly once, then restore and verify the exact prior dark-mode
      state even on failure.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting and fixture/native-action/preview/geometry/jump/
      media/dark-state receipts.
- [ ] Scan aggregate diagnostics for credentials/tokens/media/event ids; always
      restore dark mode, clear application data, close the client and release
      all Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 7: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `thread-preview` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.thread-preview` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after thread-composer with a bounded
      wrapper and started marker; add started-only `android-thread-preview`
      diagnostics including jump/dark hard-gate artifacts.
- [ ] Extend registry/workflow guards for exact ordering, timeout, artifact path
      and desktop/synthetic exclusion plus dark-state restoration.
- [ ] Document pinned ownership, 86 identities/three stages, fixtures, native
      explicit reply/jump/summary actions, production target size, real-dark
      short/media/group geometry, hard gates, secrets and teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 8: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:thread-preview --skipNxCache` three
      times sequentially on unchanged inputs; require 3/3 stages, 86/86
      identities, attempt 1 and retries 0 each time.
- [ ] Audit fixtures, every native action, long/short/media/helper expansion,
      actual truncation/connectors, explicit quote and exact native jump,
      production touch target, real-dark state/restore and connected-group/
      colour receipts; require no raster artifacts and clean Matrix/dark-mode/
      application/device teardown.
- [ ] Run the complete unchanged thread-preview browser predecessor with one
      worker and `--retries=0`; require all five definitions to pass, reassert
      the two desktop branches remain excluded from Android and recheck all four
      pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls and artifacts in the ledger.

## Task 9: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor and dedicated Android artifact; require 3/3
      stages, 86/86 identities, attempt 1/retries 0, exact fixture/preview/
      native-explicit-reply/jump/touch-target/dark/media/group-geometry receipts,
      exclusions, redaction, restoration, teardown and clean worktree.
- [ ] Post evidence to #765, #660, #653 and PR #677; close #765 only after all
      acceptance evidence is complete, then continue with #766.
