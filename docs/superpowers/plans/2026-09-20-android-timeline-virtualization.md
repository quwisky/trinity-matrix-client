# Android Timeline Virtualization Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical 200-message
timeline-virtualization definition while preserving its Playwright predecessor,
its bounded rendered window and both reachable ends.

**Architecture:** A focused Vitest guard pins the predecessor and shared
application helper sources, exact 200/80/flag constants, nineteen runtime
identities and every forbidden shortcut. One serial Node/Maestro journey
arranges a fresh 200-event Room through real Synapse, seeds the real Capacitor
Preferences backend before a proven cold launch, and drives login, history
paging, latest-jump and composer growth through native input. Renderer access
is read-only: it observes row cardinality, exact message visibility, scroll
extent and geometry to guide bounded native gestures. A dedicated positioning
helper records whether Android input can physically establish the 1-CSS-pixel
reading offset and emits a reviewed hard-gate exclusion artifact if it cannot.

**Issue:** #768, blocked on #767 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned timeline-virtualization predecessor and application
  helper unchanged.
- Arrange one isolated Account/Room with exactly 200 ordered real Synapse text
  events, `seeded message 0` through `seeded message 199`.
- Seed exact key `trinity.flags.virtual-timeline` to string value `true` through
  the real Capacitor Preferences backend, prove the durable Android value, then
  force-stop and cold-launch a fresh app process/document before login.
- Record exactly nineteen globally unique stage-local identities: initial row,
  virtual-list ownership, simple-list absence, newest-at-open, oldest reach,
  top row bound, large extent, newest eviction, latest-jump return, latest row
  bound, five native position acquisitions, bottom growth gap, bottom growth
  row bound and two exact offset-stability records.
- Maestro/native device input owns every reachable product action: login, Room
  navigation, repeated history paging, latest jump and one-line/six-line
  composer entry.
- Observation-guided native gestures own all timeline positioning. Renderer
  inspection may read rows/text/counts/visibility/geometry and scroll metrics,
  but may not click, focus, fill, submit, navigate, assign scroll state, call a
  scrolling API, dispatch an event or resize the WebView.
- Page to the oldest message with repeated real native swipes. Do not infer
  reachability from gesture count; positively observe message 0, fewer than 80
  rows, an extent greater than three viewports and message 199 windowed out.
- Establish exact bottom, 1 px and 119 px reading positions from measured
  device output. A requested gesture distance is not evidence of the resulting
  CSS offset.
- Run an explicit bounded 1-CSS-pixel Android input-slop preflight. If real
  native input cannot measurably produce that offset, fail the stage into a
  machine-readable reviewed hard-gate exclusion artifact; never substitute a
  renderer assignment or weaken the identity.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device/keyboard/preference teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access tokens, Room/event ids and raw
  preference contents.
- Keep PR #677 draft/open and unmerged.

## Exact runtime identity map

1. `timeline-virtualization.initial-row-visible`
2. `timeline-virtualization.virtual-list-visible`
3. `timeline-virtualization.simple-list-absent`
4. `timeline-virtualization.newest-initially-visible`
5. `timeline-virtualization.oldest-reachable`
6. `timeline-virtualization.top-row-count-bounded`
7. `timeline-virtualization.scroll-extent-large`
8. `timeline-virtualization.newest-windowed-out`
9. `timeline-virtualization.latest-newest-visible`
10. `timeline-virtualization.latest-row-count-bounded`
11. `timeline-virtualization.position-bottom-before-growth`
12. `timeline-virtualization.bottom-growth-pinned`
13. `timeline-virtualization.bottom-growth-row-count-bounded`
14. `timeline-virtualization.position-bottom-before-one-pixel`
15. `timeline-virtualization.position-one-pixel`
16. `timeline-virtualization.one-pixel-offset-stable`
17. `timeline-virtualization.position-bottom-before-119-pixel`
18. `timeline-virtualization.position-119-pixel`
19. `timeline-virtualization.119-pixel-offset-stable`

The five `position-*` identities are the five executions of the predecessor's
positioning helper. The final two identities are the two executions of its
offset-stability assertion. No identity may be collapsed into a shared summary.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/timeline-virtualization-migration.spec.mjs`.

- [ ] Pin the predecessor hash, exact owned definition/constants spans,
      application-helper hash, `SEED = 200`, `MAX_RENDERED = 80`, exact flag
      key, positioning-helper call count and final-loop cardinality.
- [ ] Require the exact nineteen ids above, one stage, exact count/global
      uniqueness and source-to-record mappings for all five position and both
      stability executions.
- [ ] Require one fresh 200-message fixture with exact ordered bodies, real
      Synapse receipts and no synthetic renderer rows.
- [ ] Require native Preferences setup, durable backend observation, a stopped
      process before launch, changed process/document identity after launch and
      exact preference restoration/removal during cleanup.
- [ ] Require native Room ownership, repeated history swipes, latest-jump tap,
      keyboard multiline input and observation-guided native positioning.
- [ ] Require real virtual/simple-list ownership, both reachable ends, bounded
      rows, extent greater than three viewports, eviction/return and stable
      bottom/reading offsets.
- [ ] Reject DOM click/focus/fill/submit/navigation, `scrollTop` assignment,
      `scrollTo`/`scrollIntoView`, event dispatch, WebView resize, synthetic
      messages, requested-distance position claims, retries, unbounded waits
      and weak cleanup/redaction.
- [ ] Require an effective 1 px input-slop feasibility control and a structured
      exclusion artifact that cannot be reported as a passing parity identity.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for message count/order, 80-row bound,
      flag key/value/backend/durability/cold launch, all nineteen identities,
      virtual-list ownership, native gestures/actions/input, target offsets,
      feasibility result, cleanup and redaction.
- [ ] Run
      `pnpm exec vitest run scripts/timeline-virtualization-migration.spec.mjs`
      and preserve the expected RED result.

## Task 2: Add the exact contract and 200-message fixture

**Files:**

- Create `e2e/android/timeline-virtualization-contract.mts`.
- Create `e2e/android/timeline-virtualization-fixtures.mts`, reusing exact
  lower-level Account/Room operations where possible.

- [ ] Export exact source mappings, seed/bound/flag constants, one stage id and
      all nineteen identities; assert totals and global uniqueness at module
      load.
- [ ] Create/login one fresh Account, create one private Room and publish
      exactly 200 sequential real `m.room.message` text events with exact
      bodies `seeded message 0 … seeded message 199`.
- [ ] Observe real Room history to prove exact cardinality and order before
      sealing fixture mutation and launching the installed observation.
- [ ] Retain sanitized Account/Room/message count/order facts while keeping the
      password, access token, Room id and event ids closure-private.
- [ ] Aggregate cleanup must handle partial setup and release the Account/Room
      plus application/device/preference state within bounds.
- [ ] Extend the focused guard so a wrong body/count/order, reused fixture,
      mutation after seal, unbounded Matrix work or leaked secret fails.
- [ ] Run the focused guard to the preference-only RED boundary and run Android
      typecheck.

## Task 3: Seed and prove the real native preference before cold launch

**Files:**

- Create `e2e/android/timeline-virtualization-preference.mts`.

- [ ] Start from cleared application data and prove the exact flag key is
      absent from `shared_prefs/CapacitorStorage.xml` without logging values.
- [ ] In a bounded setup document, call the installed Capacitor Preferences
      plugin for the exact key/value; do not use browser local/session storage
      or write SharedPreferences XML directly.
- [ ] Await the exact durable native preference on disk, record only boolean
      key/value-match facts and force-stop the application.
- [ ] Prove no app process remains, cold-launch a new process/WebView and prove
      changed process/document identities before any login or Room action.
- [ ] Observe that the fresh document selected the virtual list path and retain
      exact renderer/APK/profile provenance linking setup and cold launch.
- [ ] In `finally`, restore the exact prior value or remove the key when it was
      absent, await durable proof, then clear app data and prove no preference
      file/process remains.
- [ ] Redact Preferences method data and raw XML from every aggregate artifact.
- [ ] Extend the focused guard through the journey-only RED boundary and run
      Android typecheck.

## Task 4: Implement initial, oldest and latest native stages

**Files:**

- Create `e2e/android/timeline-virtualization-positioning.mts`.
- Create `e2e/android/timeline-virtualization-journeys.mts`.

- [ ] After the proven cold launch, sign in and open the exact seeded Room
      through native Maestro actions.
- [ ] Through read-only scoped observations, prove at least one real message
      row, visible `trn-virtual-message-list`, zero simple lists and exact
      message 199 visible; record identities 1–4 exactly once.
- [ ] Repeatedly swipe upward natively with bounded observation between swipes
      until exact message 0 is visible. Fail if progress stalls or the deadline
      expires.
- [ ] After virtualizer settlement, prove row count below 80, scroll extent
      greater than three viewports and exact message 199 absent from the
      rendered window; record identities 5–8 exactly once.
- [ ] Tap the production `jump-to-latest` control natively, prove exact message
      199 returns and row count remains below 80; record identities 9–10.
- [ ] Never use row-list/sidebar text as timeline proof and never turn a
      read-only observation into product input.

## Task 5: Implement native positioning, composer growth and hard gate

- [ ] Implement a bounded feedback loop that samples scroll geometry, selects
      the next integer Android device-coordinate gesture, performs it through
      native input and re-samples the measured CSS gap. It may not invoke any
      renderer scrolling primitive.
- [ ] Converge to measured exact bottom before each of the three growth paths;
      record identities 11, 14 and 17 from separate acquisitions.
- [ ] At exact bottom, enter `one line` and then exact six lines through the
      native keyboard. Prove the settled bottom gap is below 1 px and rows stay
      below 80; record identities 12–13.
- [ ] Run a bounded input-slop preflight over real native gesture outputs and
      prove whether measured 1-CSS-pixel positioning is physically reachable
      on the exact hosted/local profile.
- [ ] If reachable, establish a measured exact 1 px reading offset natively,
      capture its `scrollTop`, grow from one to six lines through the native
      keyboard and prove the exact captured value is unchanged; record
      identities 15–16.
- [ ] If unreachable, stop before claiming identities 15–16 and emit a
      machine-readable hard-gate exclusion with attempted device deltas,
      observed sanitized CSS gaps, density/profile/provenance and reviewer
      disposition. It must contain no raster or secret data.
- [ ] Establish measured exact 119 px natively, capture its `scrollTop`, grow
      from one to six lines natively and prove the exact captured value is
      unchanged; record identities 18–19.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting and fixture/preference/cold-launch/native-action/
      row/extent/position/keyboard receipts.
- [ ] Scan aggregate diagnostics for credentials, tokens, Room/event ids and
      raw preference data; always dismiss the keyboard, restore/remove the
      preference, clear application data, close the client and release Matrix/
      device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 6: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `timeline-virtualization` target with the Android
      APK build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.timeline-virtualization` as required current hosted
      Android coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after timeline-events with a bounded
      wrapper and started marker; add started-only
      `android-timeline-virtualization` diagnostics, including a structured
      input-slop hard-gate artifact when applicable.
- [ ] Extend registry/workflow guards for exact ordering, timeout, artifact
      path, no-raster policy, hard-gate semantics and teardown requirements.
- [ ] Document pinned ownership, nineteen identities/one stage, exact 200/80/
      flag contracts, cold native preference seed, both reachable ends, native
      positioning/composer input, 1 px feasibility and prohibited shortcuts.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 7: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run
      `pnpm nx run trinity-e2e-android:timeline-virtualization --skipNxCache`
      three times sequentially on unchanged inputs; require one stage, all
      nineteen feasible identities, attempt 1 and retries 0 each time.
- [ ] If the 1 px hard gate is triggered, require three unchanged matching
      exclusion artifacts and explicit review before accepting that sole
      limitation; no run may silently omit or pass the infeasible identities.
- [ ] Audit exact 200-event order, durable flag/cold launch, native Room/swipe/
      latest/keyboard/position actions, virtual/simple ownership, row bounds,
      extent, both ends, all measured gaps/scroll positions and exact preference/
      Matrix/application/device teardown. Require no raster artifacts.
- [ ] Run the complete unchanged timeline-virtualization browser predecessor
      with one worker and `--retries=0`; require its sole definition to pass,
      then recheck both pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls, feasibility disposition and
      artifacts in the ledger.

## Task 8: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor and dedicated Android artifact; require one
      stage, all feasible identities, attempt 1/retries 0, exact fixture/flag/
      cold-launch/native-action/window/position/composer receipts, reviewed
      feasibility disposition, redaction, teardown and clean worktree.
- [ ] Post evidence to #768, #660, #653 and PR #677; close #768 only after all
      acceptance evidence is complete, then continue with #769.
