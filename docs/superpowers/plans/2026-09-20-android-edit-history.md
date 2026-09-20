# Android Edit History Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the two Android-applicable
canonical edit-history definitions while preserving all three Playwright
definitions and their explicit desktop-only boundary.

**Architecture:** A mandatory installed-WebView feasibility probe first proves
that real Android accessibility/font-scale configuration changes the live
renderer and can be restored. A focused Vitest guard then pins the predecessor
and shared login sources, exact applicable/excluded spans, all 62 identities
and every forbidden shortcut. Two serial Node/Maestro stages arrange exact
Matrix source/edit/redaction chains. Maestro owns Room, marker, dialog, toggle,
scroll, removal, confirmation and close actions. Closure-private Matrix
observation proves authoritative revision repair, while read-only renderer
observations prove ordering, diff markup, formatting, redaction suppression and
Pixel 5 large-text geometry.

**Issue:** #743, blocked on #742 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-edit-history predecessor, application-login and
  account sources unchanged, including all three definitions.
- Record exactly 62 unique identities grouped 46 + 16 across `revision-
lifecycle` and `pixel5-large-text`: 59 applicable direct assertions plus
  three Pixel 5 dialog-opening helper expansions.
- Keep the desktop/settings-frame definition browser-only. Do not resize the
  installed Android viewport, synthesize keyboard focus or mutate the DOM root
  font size/style.
- Matrix REST may arrange and observe exact source/edit/redaction chains.
  Device APIs may apply/restore real Android font-scale configuration. Maestro
  owns every product action: login, Room/marker/dialog navigation, toggles,
  revision scrolling, Remove/confirm and close.
- Renderer access is read-only and may observe exact text, markup, geometry and
  state. It may not invoke handlers, mutate styles, scroll, focus, fill, submit
  or navigate.
- Never accept local dialog mutation as removal proof. Require authoritative
  server relation/redaction state plus repaired dialog and timeline projection.
- Use one attempt, zero retries, finite observation and bounded font-scale,
  Matrix/application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access tokens and event authorization.
- Keep PR #677 draft/open and unmerged.

## Task 0: Prove real installed-WebView large-text feasibility

**Files:**

- Create an ignored probe artifact only; do not alter tracked product/test
  sources during the probe.

- [ ] Save the exact current Android system `font_scale` state, including
      whether the setting is absent, and record the baseline live WebView root
      computed font size at the production Pixel 5 profile.
- [ ] Apply a documented large accessibility scale through Android settings,
      force-stop and relaunch the installed app, and observe the live WebView
      root computed font size plus the edit-history text-scaled breakpoint.
- [ ] Require a non-vacuous increase over baseline and compact/fullscreen
      behavior caused by the real device setting; CDP emulation, application
      preference seeding and DOM/style mutation are forbidden.
- [ ] Restore/delete the exact prior setting and relaunch even on failure;
      require root size and compact state to return to baseline.
- [ ] If the live renderer does not respond, stop #743 implementation and
      record the exact prerequisite against the owning Android text-scaling
      work rather than weakening the definition.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/edit-history-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact edit-chain/dialog helpers, core,
      browser-only desktop and Pixel 5 spans, plus application-login and
      account source hashes.
- [ ] Prove 46 core direct assertions, 13 Pixel 5 direct assertions and three
      dialog-helper expansions; require exact 46 + 16 contract grouping and
      explicit desktop exclusion.
- [ ] Require exact original/edit wire shapes, formatted HTML edit, separately
      edited/redacted event, oldest-first labels, word diffs, formatting,
      highlight toggles, complete/error-free state and native close.
- [ ] Require current and last-edit native removal/confirm flows with exact
      server relation repair, previous/original timeline repair and marker
      persistence/removal, plus redacted-history suppression.
- [ ] Require production Pixel 5/fullscreen/touch/overflow geometry and the
      proven real Android font-scale path with native revision scrolling and
      exact setting restoration.
- [ ] Reject the browser-only definition, root/style mutation, viewport resize,
      synthetic focus, renderer scroll methods/offset assignment, local-only
      removal, DOM click/focus/fill/submit/navigation, retries, unbounded waits
      and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and all predecessors.
- [ ] Add effective mutation controls for ordering/diff/formatting/toggle,
      truncation/error state, edit targets and server repair, redaction,
      fullscreen/touch/overflow/large-text reachability, native ownership,
      setting restoration, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/edit-history-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract, Matrix fixture and font-scale seam

**Files:**

- Create `e2e/android/edit-history-contract.mts`.
- Create `e2e/android/edit-history-fixture.mts`.
- Create `e2e/android/android-font-scale.mts`.

- [ ] Export exact source mappings, browser-only exclusion and explicit 46 + 16
      assertion maps; assert 62 identities and global uniqueness at module
      load.
- [ ] Arrange exact plain three-version, formatted Friday→Monday and separately
      edited-then-redacted chains with retained original/revision/redaction
      event ids, exact `m.replace` targets, fallback bodies, `m.new_content` and
      formatted bodies.
- [ ] Add closure-private bounded observation of server relations/redactions
      after each native removal; return only sanitized event ids, ordering,
      redaction and exact content-summary facts.
- [ ] Add a one-shot font-scale seam that snapshots prior Android state, applies
      only the empirically proven setting, force-stops/relaunches, reports
      sanitized before/after live-renderer scale facts and restores/deletes the
      exact prior setting in aggregate teardown.
- [ ] Keep credentials/tokens and authorization inside fixture closures.
- [ ] Extend the focused guard so malformed edit targets/content, weak relation
      observation, local-only removal, fake font scaling, absent cold relaunch,
      missing restoration or leaked secrets fail.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the 46-record revision lifecycle stage

**Files:**

- Create `e2e/android/edit-history-journeys.mts`.

- [ ] Arrange all three chains, sign into the installed app and open the exact
      Room through native actions; prove latest plain text and visible
      accessible edited marker, then open it natively.
- [ ] Prove one dialog, three revisions, exact Original/Edited/Current labels,
      current inserted `final`, deleted `second`, no original diff, highlight
      default/toggle-off exact versions/toggle-on restoration and zero error/
      truncation; close natively.
- [ ] Open formatted history natively; prove `Mon` insertion and `Fri` deletion
      inside `strong`, retained `day`, then toggle off natively and prove exact
      bold Monday with no diff or stale Friday; close natively.
- [ ] Reopen plain history, prove three rows/two Remove actions/no original
      Remove, remove current revision and confirm natively, prove authoritative
      server removal plus two-row error-free dialog, close and prove timeline
      repaired to second draft with marker retained.
- [ ] Reopen and prove removed final absent/second present, remove the remaining
      edit and confirm natively, prove server one-version state, close and prove
      exact original plus marker absence.
- [ ] Prove the separately redacted row visible but without edited marker or old
      body/history access.

## Task 4: Implement the 16-record Pixel 5 large-text stage

**Files:**

- Continue `e2e/android/edit-history-journeys.mts`.

- [ ] Arrange/open the long three-version history on the exact production Pixel
      5 profile through native actions and record all three helper-expanded
      readiness identities.
- [ ] Prove dialog width/height fill the viewport within one pixel, header Close
      visible with at least 44×44 CSS px, no horizontal overflow, toggle visible
      and revisions visible.
- [ ] Apply the proven real Android large-text setting and cold-relaunch; reopen
      Room/history natively and prove the live renderer reflects the larger
      scale and remains fullscreen.
- [ ] Prove revisions reading region has no horizontal overflow, use native
      sheet/revision swipes to reach the trailing Remove action, prove it in the
      viewport and its left/right bounds within the viewport.
- [ ] Restore exact prior font-scale state and relaunch during teardown even on
      failure; prove baseline restoration.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, edit/relation/font-scale/native-input receipts and
      aggregate cleanup and redaction scans for both stages.
- [ ] Always close dialog, clear installed application data, close client and
      release Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 5: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `edit-history` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.edit-history` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-action-sheet with a bounded
      wrapper and started marker; add started-only `android-edit-history`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, 62 identities/grouping, desktop exclusion,
      exact edit/server-repair boundaries, real Android large-text feasibility,
      native/REST/renderer ownership, secrets, teardown and predecessors.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 6: Local runtime, review, publication and hosted acceptance

- [ ] Run all focused/source-selected static gates and run
      `pnpm nx run trinity-e2e-android:edit-history --skipNxCache` three times
      sequentially on unchanged inputs; require 2/2 stages, 62/62 identities,
      attempt 1 and retries 0 each time.
- [ ] Scan retained diagnostics for credentials, access/session tokens, bearer
      patterns and event authorization; require no raster artifacts, exact
      font-scale restoration and clean Matrix/application/device teardown.
- [ ] Run the complete unchanged message-edit-history browser predecessor with
      one worker and `--retries=0`; require all three definitions to pass and
      recheck all three pinned source hashes.
- [ ] Run full repository validation, review the complete diff, resolve every
      finding, re-run publication checks, commit task-owned files and push the
      consolidated branch while keeping PR #677 draft/open and unmerged.
- [ ] Audit first hosted merge SHA, renderer/APK/profile, three browser
      predecessors, dedicated Android artifact, 2/2 stages, 62/62 identities,
      attempt 1/retries 0, edit/relation/font-scale/native-input receipts,
      redaction, teardown and clean worktree.
- [ ] Post evidence to #743, #660, #653 and PR #677; close #743 only after all
      acceptance evidence is complete, then continue with #744.
