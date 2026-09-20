# Android Composer Typing Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for all six canonical
typing-indicator definitions while preserving their complete Playwright
predecessor.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, their exact assertion expansion and all forbidden shortcuts. Six
serial Node/Maestro stages arrange disposable Matrix accounts and rooms through
closure-private REST fixtures, navigate and type through native product input,
and use the renderer only for read-only copy, geometry and Web Animations
observations. A reversible Android animation-scale setting supplies the real
WebView reduced-motion signal and is restored during bounded teardown.

**Issue:** #734, blocked on #733 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned composer-typing, application-login and account sources
  unchanged.
- Record exactly 25 unique identities grouped 4 + 4 + 5 + 5 + 3 + 4; each
  stage includes its helper-expanded composer-readiness identity.
- Maestro owns Room navigation and local composer input. Matrix REST may only
  arrange accounts/rooms and drive the counterpart typing EDU. Renderer/CDP
  may only observe copy, geometry, animation state and media-query state.
- Use the actual Android `animator_duration_scale=0` path for reduced motion;
  never use CDP media emulation or renderer mutation.
- Use one attempt, zero retries, finite observations, bounded typing reset,
  reversible device settings and aggregate Matrix/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access tokens and local draft content.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/composer-typing-migration.spec.mjs`.

- [ ] Pin the composer-typing source hash and exact helper/definition spans,
      plus the application-login and account source hashes.
- [ ] Prove 19 direct predecessor assertion sites plus six helper-expanded
      composer-readiness identities.
- [ ] Require the exact six stage IDs and 4 + 4 + 5 + 5 + 3 + 4 grouped
      contract identities with global uniqueness.
- [ ] Require native Room navigation/local fill, exact Matrix typing PUT,
      read-only geometry/animation observations and the real Android
      reduced-motion setting path.
- [ ] Reject DOM click/focus/fill/submit/navigation, CDP media emulation,
      renderer mutation, retries, unbounded waits, weak cleanup and missing
      redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for indicator show/clear/copy, positive
      idle height, occupied-height delta, long-name overflow, animation count,
      1000 ms duration, infinite iterations, reduced-motion media state and
      three full-opacity dots, sidebar projection, native ownership, setting
      restoration, typing reset, redaction and cleanup.
- [ ] Run `pnpm exec vitest run scripts/composer-typing-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and bounded fixture seams

**Files:**

- Create `e2e/android/composer-typing-contract.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts`.

- [ ] Export exact source mappings and six grouped assertion maps; assert 25
      identities and uniqueness at module load.
- [ ] Add a closure-private `setTyping(account, roomId, typing)` fixture using
      the exact Matrix v3 typing endpoint, `timeout: 30000` for start and a
      bounded explicit stop for cleanup.
- [ ] Keep access tokens inside the fixture closure and return no transport
      response as assertion proof.
- [ ] Extend the focused guard so omission or weakening of the exact endpoint,
      timeout or cleanup stop fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the six native stages

**Files:**

- Create `e2e/android/composer-typing-journeys.mts`.

- [ ] Add one disposable reader, named member and private Room per stage;
      invite/join through Matrix REST, sign the reader into the installed app
      and open the Room through native navigation.
- [ ] Implement `show-clear` with composer readiness, visible exact named copy
      and hidden-after-stop proof.
- [ ] Implement `reserved-slot` with positive idle height, observed indicator
      projection and occupied-vs-idle delta below one pixel.
- [ ] Implement `long-name` at the real phone profile with positive idle
      height, indicator projection, below-one-pixel height delta and true
      `scrollWidth > clientWidth` overflow.
- [ ] Implement `live-animation` with indicator projection and exactly one
      animation on the first dot whose resolved duration is 1000 ms and whose
      iterations are infinite.
- [ ] Implement `reduced-motion` by saving the prior Android global setting,
      applying only `animator_duration_scale 0`, relaunching the installed app,
      proving the live WebView media query switched, observing the indicator
      and exact `['1', '1', '1']` dot opacities, then restoring/deleting the
      original setting and relaunching even on failure.
- [ ] Implement `sidebar-projection` with exact named copy, disappearance after
      counterpart stop, native local composer fill, renewed counterpart typing
      and the unchanged exact named sidebar copy.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, device-setting receipts and aggregate cleanup and
      redaction scans.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add uncached serial `composer-typing` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.composer-typing` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after composer reactions with a bounded
      wrapper and started marker; add started-only
      `android-composer-typing` diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, 25 identities, native/REST/renderer
      boundaries, reduced-motion feasibility, secrets, teardown and retained
      predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:composer-typing --skipNxCache`
      three times sequentially on unchanged inputs; require 6/6 stages, 25/25
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens, bearer patterns and the local composer draft;
      require no raster artifacts, typing reset, restored Android setting and
      clean emulator/application teardown.
- [ ] Run the complete unchanged composer-typing browser predecessor with one
      worker and `--retries=0`; require all six tests to pass and recheck all
      three source hashes.
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
      all six exact browser predecessors, dedicated Android artifact, 6/6
      stages, 25/25 identities, attempt 1/retries 0, device-setting receipts,
      redaction, teardown and clean worktree.
- [ ] Post evidence to #734, #660, #653 and PR #677; close #734 only after all
      acceptance evidence is complete, then continue with #735.
