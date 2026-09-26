# Android Message Action Sheet Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for all five canonical phone
message-action-sheet definitions while preserving their complete Playwright
predecessor.

**Architecture:** A focused Vitest guard pins the predecessor, touch gesture
source and shared login sources, all direct/helper assertion expansions and
every forbidden shortcut. Five serial Node/Maestro stages arrange disposable
Matrix Accounts, Rooms and exact ready text events. They use the proven native
long-press and native-swipe seams for message, timeline and sheet actions.
Read-only renderer observations prove the single named phone surface, no-hover
state, target/sheet geometry, virtualization and exact position restoration;
closure-private Matrix observation proves the quick reaction is a real server
event.

**Issue:** #742. Local installed acceptance is complete; publication and
original-attempt hosted acceptance remain pending. Keep #742 open and #743
blocked until the hosted artifact audit and evidence posting complete.

## Global constraints

- Preserve the pinned message-action-sheet predecessor, touch-platform,
  application-login and account sources unchanged.
- Record exactly 54 unique identities grouped 18 + 4 + 4 + 18 + 10 across
  `reply`, `quick-reaction`, `backdrop-dismiss`, `virtualized-latest` and
  `thread-target` stages.
- Those records preserve 35 direct assertions, five Room-readiness expansions,
  three four-record sheet-clearance expansions and two one-record position-
  restoration expansions.
- Matrix REST may arrange Accounts/Rooms/events and observe reaction state.
  Maestro owns every product action: login, Room opening, long presses,
  timeline/sheet swipes, Reply/reaction/Thread/jump actions and backdrop taps.
- Renderer access is read-only and may observe exact identity, geometry,
  virtualization, copy and visibility. It may not synthesize pointer/backdrop/
  scroll events, assign scroll offsets, call scroll methods or invoke handlers,
  click, focus, fill, submit or navigate.
- Every long press must use native input beyond Trinity's 500 ms threshold.
  Every target must stay connected inside its timeline and at least eight CSS
  pixels clear of the named sheet.
- Use one attempt, zero retries, finite observation and bounded
  Matrix/application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials/access tokens.
- Reuse #741's `installWithAndroidRuntimeProvenance` before any stage. An APK
  build log or renderer manifest alone does not identify the installed binary.
  Keep the requested WebView profile distinct from the observed Android API/model.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-action-sheet-migration.spec.mjs`.

- [x] Pin the predecessor hash and exact long-press, Room fixture,
      sheet-clearance, restoration helper and five definition spans; pin touch,
      application-login and account source hashes.
- [x] Prove 35 direct assertions plus exact helper expansions and require the
      five stage IDs with 18 + 4 + 4 + 18 + 10 unique identities.
- [x] Require native >500 ms long press, one named `Message actions` dialog,
      no toolbar/revealed state, in-scroller target bounds, eight-pixel gap,
      sheet viewport bounds and native sheet scrolling to reachable Cancel.
- [x] Require exact Reply/banner, quick `👍` plus real relation-event,
      action-free backdrop dismissal, 81-event virtualization/native oldest-
      history/latest restoration and Thread target position restoration.
- [x] Reject synthesized pointer/backdrop/scroll events, hover controls,
      `scrollTop` assignment, `scrollIntoView`/scroll methods, DOM click/focus/
      fill/submit/navigation, retries, unbounded waits and weak cleanup/
      redaction.
- [x] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [x] Add effective mutation controls for long-press duration/trust, named
      surface/no-hover state, every geometry bound, Reply/reaction/backdrop
      semantics, exact 81 messages, virtual row cap, native scroll ownership,
      latest/Thread position restoration, cleanup and redaction.
- [x] Run
      `pnpm nx test scripts --skipNxCache -- message-action-sheet-migration.spec.mjs`
      and preserve the expected RED result.

## Task 2: Add the exact contract and observation seams

**Files:**

- Create `e2e/android/message-action-sheet-contract.mts`.
- Create `e2e/android/message-action-sheet-observer.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts`.
- Modify `e2e/android/account-workspace-client.mts` only if the previously
  planned generic native swipe/backdrop point seam needs a bounded extension.
  Native validation also requires an opt-in measured blank-padding long-press
  path for grouped rows with no non-selectable avatar. Preserve the existing
  default, trusted duration and app selection behavior; require glyph/control
  clearance, exact-row hit testing, transformed/observed path bounds and no
  selected text. Add `scripts/native-long-press-padding.spec.mjs` and extend
  the existing moderation guard for the backward-compatible optional argument.

- [x] Export exact source mappings and explicit per-stage assertion maps;
      assert 54 identities, 18 + 4 + 4 + 18 + 10 grouping and global uniqueness
      at module load.
- [x] Arrange one fresh Account/private Room per stage, send exact ready target
      events and retain stable event-id selectors; for virtualization, send
      exactly 80 ordered fillers followed by one newest target.
- [x] Add closure-private reaction observation for a ready `m.reaction` sent by
      the exact Account with `m.relates_to.event_id` equal to the target and key
      exactly `👍`; return only sanitized event facts.
- [x] Add read-only target/sheet geometry observation: target connection,
      scroller bounds, sheet bounds, viewport bounds, eight-pixel clearance and
      scroller-relative top.
- [x] Reuse/extend native swipe to prove direction/offset changes inside the
      timeline or sheet, and add native exposed-backdrop tapping whose measured
      point is outside the sheet but inside the visible overlay.
- [x] Keep credentials/tokens inside fixture closures and return only sanitized
      Room/event/geometry/relation receipts.
- [x] Extend the focused guard so wrong message count/order, unstable selector,
      weak relation identity, vacuous/disconnected geometry, untransformed
      points, wrong swipe/backdrop region or leaked secrets fail.
- [x] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement Reply, reaction and backdrop stages

**Files:**

- Create `e2e/android/message-action-sheet-journeys.mts`.
- Reuse `e2e/android/runtime-provenance.mts` unchanged.

**Provenance interface:** After acquiring the invocation-owned device and
registering cleanup, call the existing helper once before stage execution:

```ts
await installWithAndroidRuntimeProvenance({
  device,
  applicationId,
  apk,
  rendererManifest,
  profile,
  output: join(reportRoot, 'runtime-provenance.json'),
});
```

Here `device` is the invocation's `MaestroDevice`; `applicationId` is
`eu.qwky.trinity`; `apk` and `rendererManifest` are the verified production
build paths; `profile` is the exact `AccountViewportProfile` used by this suite;
and `reportRoot` is its ignored artifact directory. Import the helper from
`./runtime-provenance.mts` and `join` from `node:path`. The helper owns stale
receipt invalidation, pre-install hashing, installation and installed-package
hash comparison. Do not install first and manufacture a receipt afterward.

- [x] Require the helper before the five stages and a non-secret
      `runtime-provenance.json` in the dedicated artifact. Extend the migration
      guard to reject a missing helper/receipt or an unverified install path;
      reuse `scripts/android-runtime-provenance.spec.mjs` for its behavioral
      failure cases rather than duplicating the implementation.

- [x] Implement `reply` (18 records): open the exact Room/target, prove no
      toolbar and body width above 200 px, long-press natively, prove the single
      named surface/no revealed row/all target-sheet/viewport bounds, scroll the
      sheet natively until Cancel is reachable, choose Reply natively, prove
      sheet closure and exact Replying-to banner.
- [x] Implement `quick-reaction` (4 records): open/long-press the exact target,
      prove the action sheet, tap only exact `sheet-react-👍` natively, prove
      closure and a ready visible reaction backed by the exact Matrix relation
      event/sender/key.
- [x] Implement `backdrop-dismiss` (4 records): open/long-press the exact target,
      tap a measured exposed backdrop point natively, prove sheet closure,
      absence of reply banner and absence of a new reaction/action event.
- [x] Keep stage fixtures isolated so reaction or composer state from one stage
      cannot satisfy another.

## Task 4: Implement virtualization and Thread stages

**Files:**

- Continue `e2e/android/message-action-sheet-journeys.mts`.

- [x] Implement `virtualized-latest` (18 records): prove the virtual list,
      repeatedly native-swipe toward older history until exact filler 0 renders,
      prove jump-to-latest visible, activate it natively, prove the single newest
      target visible, jump hidden and fewer than 80 rendered rows.
- [x] Record the target's scroller-relative top, long-press it natively, prove
      named sheet, one connected target, full clearance and latest state, then
      backdrop-dismiss natively and prove sheet gone, target visible, relative
      top restored within two pixels and latest state preserved.
- [x] Implement `thread-target` (10 records): open target actions, choose Thread
      natively, prove Thread view and exact row, record its relative top,
      long-press that row, prove named sheet and full clearance, then native
      backdrop-dismiss and prove closure plus position restored within two
      pixels.
- [x] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, event/native-input/geometry receipts and aggregate
      cleanup and redaction scans for all five stages.
- [x] Always close any sheet/Thread, clear installed application data, close
      clients and release Matrix/device resources, including on failure.
- [x] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 5: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [x] Add an uncached serial `message-action-sheet` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [x] Register `android.message-action-sheet` as required current hosted
      Android coverage and add exact command metadata.
- [x] Invoke it on shard 2 immediately after media-retention with a bounded
      wrapper and started marker; add started-only
      `android-message-action-sheet` diagnostics.
- [x] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [x] Document pinned ownership, 54 identities/grouping, native gesture/
      action boundaries, exact surface/geometry/reaction/virtualization/Thread
      proof, secrets, teardown and predecessor coexistence.
- [x] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 6: Local runtime, review, publication and hosted acceptance

**Approved native-discovered product correction (2026-09-22):** Fix the Thread
drawer capturing a default-off message's touch before its long press can fire.
Scope: `libs/feature/rooms/src/lib/rooms/drawer-swipe.directive.ts`, its adjacent
spec, and a new composed `message-row/message-row.drawer-swipe.spec.ts`.
Keep edge opening unchanged; delay closing capture beyond ten CSS pixels,
preserve vertical scroll and primary-pointer ownership, and cancel pending
drawer input when an actual action sheet opens. Cover outside release and
destroy cleanup. Require failing-then-passing composed and directive tests,
Rooms project tests/typecheck/lint, unchanged drawer/message-swipe browser
regressions, a rebuilt production renderer/APK and the full native acceptance
below. Do not change gesture preferences or any pinned predecessor.

### Local acceptance evidence (2026-09-22)

The candidate at base `264f3f3e3e54f546581beb83f327bd08e0dd47bd` plus the
25 task-owned files passed three consecutive fresh installed runs with unchanged
inputs. Each normal `pnpm nx run trinity-e2e-android:message-action-sheet
--skipNxCache` invocation exited 0 with 5/5 stages, 54/54 unique physical records,
attempt 1 and retries 0:

| Invocation                                      | Nx target duration |
| ----------------------------------------------- | ------------------ |
| `mucu0lge-47f72f0c-ee0d-4089-93c4-fad539d2d558` | 10m 59s            |
| `mucueqmy-ac888006-b974-4503-9148-467f1ab94a19` | 11m 8s             |
| `mucut2w3-d7d2913d-29e6-4a68-878b-9780063147db` | 11m 4s             |

Post-cleanup coordinator and independent audits accepted exact stage semantics,
six trusted target-matched native long presses per run, real history/sheet
scrolling, connected-row geometry, zero-pixel latest/Thread restoration,
redaction, raster absence and Matrix/application/device teardown. The runtime
receipts are byte-identical: production renderer manifest
`92adf61a41d30a8fa686ed1d7edd6d9d8dec66ff83fd6c40cb3a262d9f309118`;
built and installed APK
`41b5476044ee265dda142e2af4284682446cf1404dd4ed800019e8a22490f705`;
requested profile
`3bacc567648982dd6b92b0e62b085908ad33cdced196ac6776d397a3a5d65157`
(393×727, touch/mobile, DPR 2.75); observed API 36,
`sdk_gphone64_x86_64`. Requested emulation is distinct from native geometry.

Supporting exit-0 checks: Rooms unit tests 116 files/1,610 tests; exact
25-file publication-snapshot scripts 146 files/1,131 tests; selected
Rooms/Android/registry/scripts typecheck and lint; scoped formatting;
architecture; Android host contract; documentation checks. The unchanged
browser sheet/drawer/message-swipe files passed 21/21 with one worker and
zero retries, including all five pinned sheet definitions. All four source
hashes still match. The final production-renderer check passed nine applicable
tests with nine intentional project skips, after rebuilding the browser
target's development bundle back to production. Product and migration reviews
have no unresolved Critical or Important findings.

The earlier full run `muct28se-e1b357c4-c44e-499a-8fc6-d2c7fa77e27c`
also passed. Preserve the intervening infrastructure failure
`muctgn79-ff2a8067-4cb3-4a01-a5a8-e106c5f89d09`: Maestro stalled at
configuration before requesting backdrop-stage rail-tap coordinates, exhausted
its 300-second timeout, and exited 1. The test-owned emulator and lock were
released; the exact runner owner's supported shutdown completed remaining
Node-process and Synapse teardown. No failed attempt is counted as acceptance
or hidden by a retry. An unrelated untracked future plan still fails the main
worktree's documentation command guard; the exact publication snapshot excludes
all ten unrelated drafts and passes the full scripts target.

Raw local logs and RED/GREEN evidence remain under ignored
`.superpowers/sdd/2026-09-20-android-message-action-sheet/`; native records are
under each invocation's `dist/.playwright/trinity-e2e-android/` directory.
The ignored `dist/742-diagnostics/drawer-fix-acceptance.md` records command,
snapshot and negative-control details. This is local evidence only: PR #677
remains draft/open and #742 remains open pending original-attempt hosted
acceptance. No iOS-device validation is claimed.

- [x] Run all focused/source-selected static gates and run
      `pnpm nx run trinity-e2e-android:message-action-sheet --skipNxCache`
      three times sequentially on unchanged inputs; require 5/5 stages, 54/54
      identities, attempt 1 and retries 0 each time.
- [x] Scan all retained diagnostics for credentials, access/session tokens and
      bearer patterns; require no raster artifacts and clean Matrix/
      application/device teardown.
- [x] Run the complete unchanged message-action-sheet browser predecessor with
      one worker and `--retries=0`; require all five definitions to pass and
      recheck all four pinned hashes.
- [x] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Review the complete feature diff; resolve every finding, re-run
      publication checks, commit task-owned files and push the consolidated
      branch while keeping PR #677 draft/open and unmerged.
- [ ] Audit first hosted merge SHA, renderer/APK/profile, five browser
      predecessors, dedicated Android artifact, 5/5 stages, 54/54 identities,
      attempt 1/retries 0, native-input/geometry/reaction receipts, redaction,
      teardown and clean worktree.
- [ ] Read the hosted runtime receipt itself: require equal nonempty
      pre-install/installed APK digests, exact renderer manifest digest and
      commit/configuration, requested profile digest, and observed API/model.
      Missing hosted APK provenance leaves #742 open even if all 54 records pass.
- [ ] Post evidence to #742, #660, #653 and PR #677; close #742 only after all
      acceptance evidence is complete, then continue with #743.
