# Android Timeline Anchoring Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for both canonical timeline-
anchoring positions while preserving their Playwright predecessors and proving
the same physical row stays stable across delayed real-history backfill.

**Architecture:** A focused Vitest guard pins the predecessor and shared login/
account sources, exact 45-message fixtures, two-stage/26-identity ownership and
every forbidden shortcut. One serial Node/Maestro journey routes the installed
app's homeserver traffic through a bounded external harness proxy that delays
only the armed Room-history response outside the WebView. Native swipes trigger
and position the real timeline; read-only frame/geometry samples identify one
intersecting event and prove sub-8 px drift through loading-strip insertion and
released backfill.

**Issue:** #766, blocked on #765 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned timeline-anchoring predecessor, application-login and
  account sources unchanged.
- Record exactly 26 globally unique identities across two stages: twelve
  direct assertions plus one Room-readiness expansion for each exact `top` and
  `near-bottom` position.
- For each stage arrange one fresh Account/Room and exactly 45 ordered text
  messages through real Synapse.
- Gate only the exact armed `/rooms/{roomId}/messages?...` response in an
  external Node/harness transport layer. The app still talks to real Synapse;
  no WebView `page.route`, fetch/XHR interception, patched methods or synthetic
  rows/history are allowed.
- Maestro/native device input owns every reachable product action: login, Room
  navigation, history-triggering swipes and observation-guided positioning.
- Renderer inspection is read-only. It may observe virtual rows, event ids,
  geometry/offsets/counts/visibility and scroll metrics to guide the next
  native swipe but may not click, navigate, dispatch input, call scrolling APIs
  or assign `scrollTop`/offsets.
- Capture the first event row intersecting the actual viewport after position
  convergence and reuse that exact event id for loading and settled offsets;
  measuring a replacement anchor is invalid.
- The top stage must converge at real top. The near-bottom stage must converge
  deliberately around 60 px from bottom while the request remains gated, not
  infer position from cumulative gesture distance or accept the 120 px
  production near-bottom threshold.
- If the external deterministic gate cannot be established/released safely,
  fail preflight with a machine-readable hard-gate artifact; never fall back to
  a renderer interceptor.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device/network-gate teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access tokens, event ids and gated-
  request metadata.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/timeline-anchoring-migration.spec.mjs`.

- [ ] Pin the predecessor hash, generated position/45-message/Room-helper spans,
      exact twelve direct assertions per position and both shared-source hashes.
- [ ] Prove exact stage totals `13 + 13 = 26`, source-to-record mappings and
      global identity uniqueness.
- [ ] Require fresh 45-message fixtures, real virtual scroller/two pads, newest
      settlement and a partial rendered window with more than five rows.
- [ ] Require an external exact-Room history gate with armed/requested/held/
      released lifecycle, native request-triggering movement and positive
      in-flight proof.
- [ ] Require observation-guided native top/approximately-60-px positioning,
      first-intersecting exact anchor capture and same-id loading/settled offset
      measurements.
- [ ] Require delayed strip visible with drift below 8 px; released page with
      increased row count; no chained pagination; strip removal; stable settled
      offset; and final drift below 8 px.
- [ ] Reject browser routing, renderer fetch/XHR/method interception, synthetic
      rows/history, DOM input, renderer scroll calls/assignment, swapped anchor,
      gesture-distance-only position inference, retries, unbounded waits and
      weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only gate diagnostics, hard-gate artifacts
      and predecessor retention.
- [ ] Add effective mutation controls for position ids, 45 bodies/order,
      virtual-window setup, gate filter/lifecycle/request count, native movement,
      position tolerance, anchor id/offset, strip/drift, page landing/no-chain/
      settle, cleanup and redaction.
- [ ] Run
      `pnpm exec vitest run scripts/timeline-anchoring-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and 45-message fixtures

**Files:**

- Create `e2e/android/timeline-anchoring-contract.mts`.
- Create `e2e/android/timeline-anchoring-fixtures.mts`, reusing exact lower-
  level Account/Room operations where possible.

- [ ] Export exact source mappings, `top`/`near-bottom` stage ids/counts and all
      26 identities; assert totals and global uniqueness at module load.
- [ ] For each stage create/login one fresh Account, create one Room and publish
      exactly ordered `line 0 … line 44` run-scoped text events sequentially.
- [ ] Retain sanitized exact Account/Room/message cardinality/order facts while
      keeping password, access token, Room id and event ids closure-private.
- [ ] Expose direct Synapse and installed-app gated homeserver endpoints
      separately so fixture arrangement cannot consume or bypass the armed app
      history gate.
- [ ] Aggregate cleanup must handle partial fixture/gate setup and release any
      held response before bounded Account/Room/proxy/application/device
      teardown.
- [ ] Extend the focused guard so wrong message count/order/body, reused
      fixture, gated fixture traffic, unbounded Matrix work or leaked secrets
      fails.
- [ ] Run the focused guard to the gate-only RED boundary and run Android
      typecheck.

## Task 3: Implement the external bounded history gate

**Files:**

- Create `e2e/android/timeline-history-gate.mts`.

- [ ] Start a bounded harness-owned reverse transport outside the WebView that
      forwards the installed app's normal homeserver traffic to real Synapse.
- [ ] Arm exactly once for the current sanitized Room and the first matching
      client `/messages` history request; forward every other request normally.
- [ ] Buffer/hold only that upstream response within a hard timeout and expose
      finite `requested`, `held`, `release` and `closed` promises plus sanitized
      request-count/timing receipts.
- [ ] Prove the gate is on the app's transport path before launch, the held
      request reached real Synapse, release forwards the unmodified response,
      and cleanup releases/terminates even after journey failure.
- [ ] Emit a hard-gate artifact and fail before product assertions if endpoint
      routing, deterministic hold, exact filtering or cleanup cannot be proven.
- [ ] Reject any browser/WebView injection, response mutation, token/query/body
      serialization or unbounded held socket.
- [ ] Extend the focused guard through the journey-only RED boundary and run
      Android typecheck.

## Task 4: Implement shared native virtual-window setup

**Files:**

- Create `e2e/android/timeline-anchoring-journeys.mts`.

- [ ] For each stage launch/login/open the exact Room natively and record Room
      readiness.
- [ ] Prove the real timeline scroller visible with exactly two direct virtual-
      padding elements.
- [ ] Prove exact newest `line 44` visible as initial settlement and record the
      initial rendered row count greater than five as a partial window.
- [ ] Arm the exact gate and swipe upward natively until the real history
      request is positively held/in flight; no renderer scroll operation may
      trigger it.

## Task 5: Implement top and near-bottom native positioning

- [ ] While the request remains held, use bounded native swipes interleaved with
      observation-only metrics to converge the top stage at real top.
- [ ] For the near-bottom stage, after the history request is held, use native
      reverse swipes and read-only distance samples to converge around 60 px
      from bottom within a pinned tight tolerance and outside exact-bottom pin
      behavior.
- [ ] In one observation-only frame sample after convergence, select the first
      intersecting ready event row and record its sanitized identity plus exact
      rounded viewport-relative top offset.
- [ ] Never select a new anchor after loading begins; all later samples must
      resolve the same underlying event id.

## Task 6: Prove loading-strip and released-page anchoring

- [ ] Keep the request held until the delayed `.load-older` strip is visible;
      measure the same anchor and prove absolute drift from its captured offset
      is below 8 px.
- [ ] Release the external gate once, prove the rendered row count increases
      above the pre-release value and retain the settled count.
- [ ] Through a bounded stability window prove row count stays exactly settled
      with no chained page and the loading strip has zero matches.
- [ ] Measure the same anchor twice after settlement, prove its offset is stable
      and final absolute drift from the original offset remains below 8 px.
- [ ] Record all thirteen identities per stage exactly once and write started-
      stage reports, pass/failure secret-safe captures, exact assertion
      accounting and fixture/gate/native-swipe/position/anchor/strip/page/
      settle receipts.
- [ ] Scan aggregate diagnostics for credentials/tokens/event/request metadata;
      always release/close the gate, clear application data, close the client
      and release Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 7: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `timeline-anchoring` target with the Android APK
      build, bounded Node/gate timeouts and `android-avd` + `synapse` resources.
- [ ] Register `android.timeline-anchoring` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after thread-preview with a bounded
      wrapper and started marker; add started-only
      `android-timeline-anchoring` gate diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout, artifact
      path, gate hard-failure and teardown requirements.
- [ ] Document pinned ownership, 26 identities/two positions, exact fixtures,
      external gate, native positioning, same-anchor strip/backfill stability,
      prohibited renderer shortcuts, secrets and teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 8: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run
      `pnpm nx run trinity-e2e-android:timeline-anchoring --skipNxCache` three
      times sequentially on unchanged inputs; require 2/2 stages, 26/26
      identities, attempt 1 and retries 0 each time.
- [ ] Audit fixture order, external gate path/filter/lifecycle, every native
      swipe, exact top/near-bottom convergence, same-anchor offsets, strip/page/
      no-chain/settle/drift receipts; require no raster artifacts and clean
      gate/Matrix/application/device teardown.
- [ ] Run the complete unchanged timeline-anchoring browser predecessor with
      one worker and `--retries=0`; require both generated positions to pass,
      then recheck all three pinned source hashes.
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
      exact browser predecessor and dedicated Android artifact; require 2/2
      stages, 26/26 identities, attempt 1/retries 0, external-gate/native-
      position/same-anchor/strip/page/no-chain/settle/drift receipts, redaction,
      teardown and clean worktree.
- [ ] Post evidence to #766, #660, #653 and PR #677; close #766 only after all
      acceptance evidence is complete, then continue with #767.
