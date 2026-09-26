# Android Who Reacted Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for both applicable canonical
who-reacted definitions while retaining every Playwright predecessor and
excluding the desktop-only, synthetic-resize and mutation stages from the
Android claim.

**Architecture:** A focused Vitest guard pins the predecessor and shared login,
account, navigation and theme-observation sources, exact applicable branches,
two-stage/191-identity ownership and every browser-only exclusion. One serial
Node/Maestro journey uses a fresh 17-account public Room and 36 real reaction
events for each stage. Native input owns Room/Settings navigation, reaction-
surface opening, group selection, scrolling, close and host Back; read-only
renderer observations prove exact counts, semantics, classes, geometry and
real overflow without resizing or mutating the WebView.

**Issue:** #759, blocked on #758 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned reactions-who predecessor, application-login, account,
  Android Settings navigation and theme-observation sources unchanged.
- Record exactly 191 globally unique identities across two stages. The general
  stage owns 88: 16 direct, 71 real-API fixture and one Room readiness record.
  The mobile stage owns 103: 19 applicable direct, 71 real-API fixture, three
  Room readiness and ten Settings open/close records.
- For each stage create one fresh reader plus exactly 16 other members, a
  public Room, one target message and exactly 36 real `m.reaction` events in 20
  emoji groups. The thumbs-up group has all 17 members; celebration and each of
  18 further keys have one event. Honor Synapse `429` retry delays within the
  exact bounded five-attempt policy and prove every API boundary.
- Maestro/native device input owns every reachable product action: login,
  Room and Settings navigation, appearance-mode selection, who-reacted open,
  directory/detail gestures, reaction-key selection, close and host Back.
- Renderer inspection is read-only. It may observe exact count/text/aria/class,
  geometry/style/overflow and resulting scroll position but may not click,
  focus, fill, submit, navigate, invoke handlers, assign scroll positions,
  resize the WebView, rewrite text/styles or dispatch synthetic events.
- General-stage Android scope excludes desktop hover tooltips, keyboard/focus
  traversal, paint/theme comparison, desktop pane geometry and compact
  breakpoint resizing while retaining them unchanged in the predecessor.
- Mobile-stage Android scope excludes the Playwright Pixel definition at lines
  723-729 and helper lines 647-700: synthetic 900/320 px viewports, fake count
  text, root-font mutation and their geometry assertions.
- Theme proof must use the real native Settings route for Light then Dark and
  return to the same exact Room after each change. Default preference or direct
  storage/theme mutation is invalid.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device/settings teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact every password plus all 17 access tokens per stage.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/who-reacted-migration.spec.mjs`.

- [ ] Pin the predecessor hash, exact fixture/Room/general/mobile spans,
      Android branches and call counts plus all four shared-source hashes.
- [ ] Prove exact direct assertion ownership: 16 general and 19 mobile after
      excluding every desktop-only/synthetic stage.
- [ ] Prove exact helper expansion: 71 API + one Room record for general and 71
      API + three Room + ten Settings records for mobile, yielding stage totals
      `88 + 103 = 191` with global identity uniqueness.
- [ ] Require two independent exact fixtures with 17 Accounts, one public Room,
      one target, 36 real reactions, 20 keys, thumbs-up count 17, one long
      reactor and bounded join-rate-limit handling.
- [ ] Require native general-stage open, heart selection, detail scroll and
      host-Back dismissal plus all exact pill/dialog/group/reactor/ellipsis/
      overflow semantics.
- [ ] Require native mobile Light/Dark Settings round trips, real production-
      device sheet class/bounds/bottom attachment, horizontal and vertical
      overflow, last-key reach/selection, actual horizontal movement, host-
      Back dismissal and Room-composer recovery.
- [ ] Reject mocked reaction snapshots, DOM click/focus/fill/submit/navigation,
      synthetic pointer/keyboard dispatch, handler invocation, renderer scroll
      assignment, WebView resize, text/style mutation, retries, unbounded waits
      and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and all predecessor/
      exclusion retention.
- [ ] Add effective mutation controls for Account/member/event/key counts,
      join retry policy, long reactor, pill summary, dialog total/list/
      ellipsis/overflow, native heart/last-key selection, native scrolling,
      Light/Dark route, sheet geometry, host Back, Room recovery, exclusions,
      cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/who-reacted-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and real-reaction fixture

**Files:**

- Create `e2e/android/who-reacted-contract.mts`.
- Create `e2e/android/who-reacted-fixtures.mts`, reusing exact lower-level
  Account/Room operations where possible.

- [ ] Export exact source mappings, two stage ids/counts, all 191 identities
      and explicit browser-only exclusions; assert totals and global uniqueness
      at module load.
- [ ] For each stage register/login a fresh reader and exactly 16 others, with
      the first other localpart retaining the exact 36-character suffix needed
      for genuine name overflow.
- [ ] Create the public Room as the reader, join all 16 other members with the
      pinned bounded `429` policy, and send exactly one run-scoped target as the
      reader.
- [ ] Publish exactly 17 thumbs-up reactions, one celebration and one of each
      exact 18 remaining keys through real Matrix endpoints, spread across the
      joined users as the predecessor does.
- [ ] Validate and record every 17-login, 16-join, one-room, one-message and
      36-reaction boundary exactly once per fixture, totaling 71 fixture
      records per stage.
- [ ] Return only sanitized exact Room/message/member/group/count/long-reactor
      facts while keeping all passwords and 17 access tokens closure-private.
- [ ] Aggregate cleanup must handle partial registration/join/reaction setup,
      restore settings as applicable and release both fixtures through bounded
      real-server operations.
- [ ] Extend the focused guard so wrong user count/name, Room preset, target,
      key/event cardinality, sender distribution, retry bound, ambiguous event,
      unbounded Matrix work or leaked secret fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the general who-reacted stage

**Files:**

- Create `e2e/android/who-reacted-journeys.mts`.

- [ ] Sign in/open the exact general Room natively and record its one expanded
      Room-readiness identity.
- [ ] Scope the exact target by ready event id/body and prove its thumbs-up
      count is 17, it has 20 reaction groups and its accessible summary matches
      `👍 reacted by You, … and N others`.
- [ ] Open the target's who-reacted control natively and prove the surface is
      visible, total is exactly `36 total`, close control is visible and all 20
      exact keys exist.
- [ ] Prove the thumbs-up detail contains the long reactor, exactly 17 reactor
      rows, CSS ellipsis, genuine name overflow and genuine vertical detail
      overflow. Swipe the detail natively and observe resulting movement rather
      than assigning a renderer scroll offset.
- [ ] Reach/select the exact heart group through native touch; prove its
      selected semantics and exactly one reactor.
- [ ] Dismiss through Android host Back and prove the surface closes. Record all
      88 general-stage identities exactly once.

## Task 4: Implement the mobile Settings and sheet stage

- [ ] Sign in/open the exact mobile Room natively, record initial Room readiness
      and prove target visibility, thumbs-up count 17 and 20 groups.
- [ ] Navigate through the real native Settings route, select Light, prove the
      observed production theme is light, close Settings and reopen the same
      exact Room; record the exact helper-expanded Settings and Room identities.
- [ ] Open the who-reacted surface natively and prove its sheet class, non-
      negative left edge, right edge within the real viewport and bottom edge
      attached to the real viewport. Close it through the native close control
      and prove hidden.
- [ ] Repeat the real Settings route for Dark, prove the observed production
      theme is dark, close Settings and return to the same Room for the third
      Room-readiness record.
- [ ] Reopen the surface natively; prove it remains usable with real horizontal
      directory and vertical detail overflow without any synthetic viewport,
      count or root-style mutation.
- [ ] Swipe the directory natively until the exact last key is reachable, tap
      it natively, and prove selected semantics, positive actual horizontal
      scroll movement and exactly one reactor.
- [ ] Dismiss through Android host Back, prove the surface closes and the same
      Room composer is visible. Record all 103 mobile-stage identities exactly
      once.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting and fixture/join/reaction/native-action/theme/
      geometry/overflow/scroll/dismissal receipts.
- [ ] Scan aggregate diagnostics for every password and all 34 stage tokens;
      always clear application data, close the client, restore settings and
      release Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 5: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `who-reacted` target with the Android APK build, a
      bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.who-reacted` as required current hosted Android coverage
      and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after quote-notification with a bounded
      wrapper and started marker; add started-only `android-who-reacted`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout, artifact path
      and every browser-only exclusion.
- [ ] Document pinned ownership, 191 identities/two stages, exact fixture,
      native group/scroll/Back actions, real Settings Light/Dark round trips,
      production-device sheet geometry, exclusions, secrets and teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 6: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:who-reacted --skipNxCache` three
      times sequentially on unchanged inputs; require 2/2 stages, 191/191
      identities, attempt 1 and retries 0 each time.
- [ ] Audit both 71-record fixtures, native actions, exact counts/semantics,
      name/detail/directory overflow, actual scroll movement, Light/Dark helper
      expansions, real sheet geometry, host Back and Room-recovery receipts;
      require no raster artifacts and clean Matrix/settings/application/device
      teardown.
- [ ] Run the complete unchanged reactions-who browser predecessor with one
      worker and `--retries=0`; require both canonical definitions to pass,
      reassert every browser-only stage remains excluded from Android and
      recheck all five pinned source hashes.
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
      exact browser predecessor and dedicated Android artifact; require 2/2
      stages, 191/191 identities, attempt 1/retries 0, exact fixture/count/
      semantics/native selection/scroll/Settings/theme/geometry/Back/Room-
      recovery receipts, exclusions, redaction, teardown and clean worktree.
- [ ] Post evidence to #759, #660, #653 and PR #677; close #759 only after all
      acceptance evidence is complete, then continue with #760.
