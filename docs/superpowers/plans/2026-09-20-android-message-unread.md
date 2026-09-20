# Android Message Unread Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical unread
divider/jump definition while preserving its Playwright predecessor and
replacing every browser-only control with the production Android viewport,
native actions, real reduced-motion settings and observation-only trajectory
evidence.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, the exact fourteen-identity ownership and every forbidden shortcut. A
fixture layer creates reader/member Accounts, the exact read boundary,
fourteen unread events and one thread relation. One serial Node/Maestro stage
proves divider geometry/style and default/reduced-motion jump trajectories. A
read-only frame sampler observes real scroll positions without patching methods
or assigning offsets; a fail-closed Android settings controller snapshots,
applies and restores the device animation configuration behind a hard
`prefers-reduced-motion` feasibility gate.

**Issue:** #755, blocked on #754 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-unread predecessor, application-login and account
  sources unchanged.
- Record exactly fourteen unique identities in one stage: thirteen direct plus
  expanded Room readiness.
- Arrange exact Matrix state: reader/member Accounts, one `seen already` event,
  both reader markers bound to it, exactly fourteen later unread events and one
  exact thread relation rooted at unread event index 2.
- Use the production Android viewport. Never resize the WebView.
- Maestro/native device input owns every product action: login, Room
  navigation, both jump activations and return-to-latest movement.
- Renderer inspection may only observe exact style, geometry, media query and
  frame-by-frame scroll offsets. Never patch `scrollIntoView`, scrolling
  methods or globals, invoke handlers, assign/call scrolling, focus, fill,
  submit or navigate.
- Configure reduced motion only through real Android device settings, cold
  relaunch as required and restore the exact prior settings in bounded teardown.
  Require `matchMedia('(prefers-reduced-motion: reduce)').matches === true`
  behind a hard feasibility gate; never emulate media through DevTools.
- Infer smooth versus automatic behavior only from non-vacuous observed frame
  trajectories, never requested options or CSS.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device/settings teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials/access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-unread-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact definition/API-token/send/Room-helper
      spans plus application-login and account source hashes.
- [ ] Prove exactly thirteen direct assertions plus one expanded Room-readiness
      identity and require fourteen globally unique contract identities.
- [ ] Require exact read boundary, fourteen unread events and event-2 thread
      relation; exact divider text/connector/style/geometry; initial jump
      gating; default multi-frame smooth trajectory; real reduced-motion query;
      and automatic/no-smooth trajectory.
- [ ] Require native replacements for viewport mutation, `scrollIntoView`
      monkey-patching, media emulation and direct `scrollTo`/offset assignment.
- [ ] Reject WebView resize, prototype/global patching, recorded-call globals,
      DevTools media emulation, renderer scroll calls/assignment, requested-
      option/CSS-only trajectory inference, DOM click/focus/fill/submit/
      navigation, retries, unbounded waits and weak settings cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics, hard feasibility/exclusion
      artifact and predecessor retention.
- [ ] Add effective mutation controls for event counts/order/relations/markers,
      connector edges/tolerance, every computed style, jump visibility, sampler
      frame/timestamp/offset classification, media query, native action
      ownership, settings snapshot/restore and cleanup/redaction.
- [ ] Run `pnpm exec vitest run scripts/message-unread-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and unread fixture

**Files:**

- Create `e2e/android/message-unread-contract.mts`.
- Create `e2e/android/message-unread-fixtures.mts`, reusing lower-level account
  operations where their exact semantics already match.

- [ ] Export exact source mappings and all fourteen identities; assert count and
      uniqueness at module load.
- [ ] Register fresh reader/member Accounts, create the exact invited Room and
      join the member.
- [ ] Send exact `seen already`, bind both `m.fully_read` and `m.read` for the
      reader to its ready event id, then send exactly fourteen ordered member
      events named `unread message 0` through `unread message 13`.
- [ ] Send exact `Thread after the unread marker` as a real `m.thread` relation
      whose `event_id` and `m.in_reply_to.event_id` both equal unread event index 2.
- [ ] Independently observe the ready event order, both reader markers and exact
      thread relation before app launch; return only sanitized fixture facts
      while keeping credentials/tokens closure-private.
- [ ] Extend the focused guard so wrong event count/order/sender/body, marker,
      root/reply relation, unbounded setup or incomplete cleanup fails.
- [ ] Run the focused guard to the sampler/settings-only RED boundary and run
      Android typecheck.

## Task 3: Add observation-only frame sampling

**Files:**

- Create `e2e/android/scroll-trajectory-observer.mts`.

- [ ] Start a bounded observation against one exact timeline scroll element and
      sample timestamp plus current offset once per animation frame without
      modifying the element, prototypes, product globals or scroll behavior.
- [ ] Stop after a real native action reaches a stable terminal offset for a
      bounded number of frames, or fail on deadline/removal/navigation.
- [ ] Require non-zero movement and classify smooth only when there are multiple
      distinct monotonic intermediate offsets across multiple frames between
      start and end.
- [ ] Classify automatic/no-smooth only when movement reaches the terminal
      offset without any intermediate trajectory; retain raw bounded samples so
      classification is independently auditable.
- [ ] Reject synthetic/reordered timestamps, duplicate-only evidence, offset
      writes, scroll API calls, method patches and requested-behavior inference.
- [ ] Add focused unit mutation controls for every classification boundary and
      run Android typecheck.

## Task 4: Add real Android reduced-motion control and hard gate

**Files:**

- Create `e2e/android/android-reduced-motion.mts`.

- [ ] Snapshot the exact relevant Android global animation-scale settings and
      their absent/present representation before any mutation.
- [ ] Apply the platform's real remove-animation configuration through device
      settings APIs, verify readback, cold-stop/relaunch the app and reopen the
      exact Room through native actions.
- [ ] Read only the installed WebView media query and require reduced motion to
      become true; emit a machine-readable feasible receipt with before/applied/
      query/provenance facts.
- [ ] If the real device cannot propagate reduced motion, emit a reviewed
      fail-closed exclusion with exact setting readbacks, relaunch and false
      query evidence. Do not emulate media or weaken the trajectory assertion.
- [ ] Restore every setting to its exact prior value/absence in `finally`, read
      back restoration and cold-relaunch to prevent leakage into later suites.
- [ ] Extend the focused guard so missing settings, partial restore, media
      emulation, relaunch omission or timeout-only exclusion fails.
- [ ] Run the real emulator feasibility probe and retain its ignored evidence.

## Task 5: Implement divider and default smooth-jump proof

**Files:**

- Create `e2e/android/message-unread-journeys.mts`.

- [ ] Sign in and open the exact Room natively on the production profile;
      record expanded Room readiness and wait for true bottom settlement.
- [ ] Prove the exact divider says `New messages`, contains one thread connector
      and that connector extends at least 7.99 px above and below its divider
      using boxes read in one renderer turn.
- [ ] Prove exact computed `display: flex`, `align-items: center`,
      `font-weight: 600` and `::before flex-grow: 1`.
- [ ] Prove the unread jump is visible at initial bottom settlement, start the
      observation-only sampler, tap the exact jump natively and prove it hides
      while the divider enters view.
- [ ] Require the default samples to form a non-vacuous multi-frame smooth
      monotonic trajectory and retain the exact sample/classification receipt.

## Task 6: Implement reduced-motion automatic-jump proof

- [ ] Return to the newest message through a native vertical gesture or exact
      product control and prove the jump reappears; never call renderer scroll
      APIs.
- [ ] Apply real reduced motion through the settings controller, cold-relaunch/
      reopen as required and pass the hard media-query feasibility gate.
- [ ] At exact bottom settlement, start a fresh observation-only sampler, tap
      the exact jump natively and prove it hides while the divider enters view.
- [ ] Require one non-zero automatic/no-smooth trajectory with no intermediate
      samples; reject any smooth multi-frame sequence.
- [ ] Record all fourteen identities exactly once and write started-stage
      reports, pass/failure secret-safe captures, exact assertion accounting and
      fixture/divider/style/sampler/settings/feasibility receipts.
- [ ] Always stop samplers, restore Android settings exactly, clear application
      data and release Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 7: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-unread` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-unread` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-swipe with a bounded
      wrapper and started marker; add started-only `android-message-unread`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout, artifact path
      and settings/feasibility receipt.
- [ ] Document pinned ownership, fourteen identities, exact Matrix boundary,
      production viewport, native actions, observation-only trajectory rules,
      real reduced-motion gate/restore, secrets and teardown.
- [ ] Run focused migration, observer/settings tests, registry and workflow
      tests GREEN, then the full scripts test target.

## Task 8: Local runtime and repository acceptance

- [ ] Run the focused guard, observer/settings tests, real feasibility probe and
      all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-unread --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 14/14
      identities, attempt 1 and retries 0, or the identical reviewed platform
      exclusion only when the real reduced-motion gate is infeasible.
- [ ] Audit raw default/reduced frame samples and classifications, settings
      snapshot/apply/readback/restore, fixture/style/geometry/native-action
      receipts; require no raster artifacts and clean Matrix/application/device
      teardown.
- [ ] Run the complete unchanged message-unread browser predecessor with one
      worker and `--retries=0`; require the exact definition to pass and recheck
      all three pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls and artifacts in the ledger.

## Task 9: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, native/settings integrity, test quality and
      recoverability; resolve every finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes and restored device settings.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor, dedicated Android artifact, 1/1 stage, 14/14
      identities, attempt 1/retries 0, fixture/divider/style/native-action/
      default-reduced trajectory/settings/feasibility receipts, redaction,
      teardown and clean worktree.
- [ ] Post evidence to #755, #660, #653 and PR #677; close #755 only after all
      acceptance evidence is complete, then continue with #756.
