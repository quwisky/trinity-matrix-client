# Android Recovery Reset Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans` and
> `superpowers:test-driven-development`; subagent delegation is not part of
> this plan.

**Goal:** Add faithful installed-Android parity for all four password-account
recovery-reset definitions while preserving their complete Playwright
predecessor.

**Architecture:** A focused Vitest guard pins the source and forbidden
shortcuts. Four serial Node/Maestro stages use a real primary/secondary package
topology, closure-private Matrix observations, native product actions and
read-only renderer observation. Existing Nx, registry and CI patterns publish
bounded, secret-safe diagnostics without changing product behavior.

**Spec:**
`docs/superpowers/plans/2026-09-18-android-recovery-reset-design.md`

## Global constraints

- Preserve all three pinned files and exact owned spans unchanged.
- Record exactly 54 unique direct identities grouped 22 + 12 + 15 + 5.
- Expand setup/UIA behavior for all four stages and final Rooms readiness for
  the original-key stage.
- Maestro owns every reachable product action; REST arranges accounts and
  observes server state; renderer access only observes.
- Use real cross-signing, secret storage, key backup, conditional UIA and two
  installed packages; no mocks or production hooks.
- Never persist a recovery key, password, access token or UIA/session material.
- Use one attempt, zero retries, finite observation and bounded aggregate
  two-package teardown.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/recovery-reset-migration.spec.mjs`.
- Read the three pinned canonical sources.

- [ ] Assert exact hashes, helper boundaries, four source boundaries,
      22 + 12 + 15 + 5 direct assertion sites, setup expansion and final Rooms
      expansion.
- [ ] Require the exact 54 contract identities and uniqueness.
- [ ] Require four stages, both package IDs, native setup/reset/cancel/unlock/
      Settings actions, server observations and exact assertion accounting.
- [ ] Reject DOM actions, renderer navigation/reload/handler invocation, mock
      Trust state, retries, vacuous pointers and unbounded resources.
- [ ] Require secret-safe capture, redaction scan and aggregate two-package
      cleanup.
- [ ] Require Nx/package/registry/CI/docs wiring and predecessor retention.
- [ ] Add effective mutation controls for warning/copy, wrong-word feedback,
      non-vacuity, replacement uniqueness, cancel mutation, original-key unlock,
      escape-hatch ownership, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/recovery-reset-migration.spec.mjs`
      and preserve the expected RED result.
- [ ] Commit as `test(e2e): guard Android recovery reset migration`.

## Task 2: Add package-aware native and server observation seams

**Files:**

- Modify `e2e/android/account-workspace-client.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts`.
- Extend focused source-shape tests where appropriate.

- [ ] Add immutable `NativeShellApplicationId` to
      `AccountWorkspaceClient`, defaulting to the primary package.
- [ ] Route every package-owned clear/grant/start/flow/keyboard/paste/swipe
      action through the configured application ID.
- [ ] Preserve all existing call sites without changes.
- [ ] Add bounded closure-private default-key, backup-version and master-key
      observations to account fixtures.
- [ ] Prove access tokens cannot enter returned values or diagnostics.
- [ ] Run focused RED/GREEN controls plus Android typecheck.
- [ ] Commit as `test(e2e): support two-package recovery journeys`.

## Task 3: Implement the exact contract and four native stages

**Files:**

- Create `e2e/android/recovery-reset-contract.mts`.
- Create `e2e/android/recovery-reset-journeys.mts`.

- [ ] Export exact source mappings and four grouped assertion maps; assert 54
      identities and uniqueness at module load.
- [ ] Add native helpers for primary setup, conditional password UIA,
      secondary needs-recovery entry, exact reset gate, secret registration,
      ready Security posture, assertion recording and package switching.
- [ ] Implement `replacement-key-reset` with all 22 direct identities.
- [ ] Implement `password-cancel-atomicity` with all 12 direct identities and
      primary ready-posture proof.
- [ ] Implement `original-key-after-cancel` with all 15 direct identities,
      native original-key entry and final Rooms readiness.
- [ ] Implement `secondary-settings-escape-hatch` with all five direct
      identities and owning-surface cancel proof.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting and aggregate cleanup/redaction scans.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.
- [ ] Commit as `test(e2e): migrate Android recovery reset journeys`.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add uncached serial `recovery-reset` target with both Android APK build
      dependencies, a bounded Node timeout, `android-avd` + `synapse` resources
      and package command `e2e:android:recovery-reset`.
- [ ] Register `android.recovery-reset` as required/current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 4 after Security settings with a bounded wrapper and
      started marker; add started-only `android-recovery-reset` diagnostics.
- [ ] Extend registry/workflow source guards for the exact entry, ordering,
      timeout and diagnostic path.
- [ ] Document pinned ownership, 54 identities, two-package topology,
      native/REST/renderer boundaries, secrets, cleanup and predecessor
      coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.
- [ ] Commit wiring as `ci(e2e): register Android recovery reset` and docs as
      `docs(e2e): describe Android recovery reset migration`.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:recovery-reset --skipNxCache`
      three times sequentially on unchanged inputs; require 4/4 stages, 54/54
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for passwords, access/
      session values, bearer patterns and recovery-key material; require clean
      two-package teardown.
- [ ] Run the complete unchanged recovery-reset browser predecessor with one
      worker and `--retries=0`; require all four tests to pass and recheck all
      three source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      both Android APKs, Android host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK hashes, invocation IDs,
      durations, negative controls and artifacts in the ledger.
- [ ] Commit as `docs(e2e): record Android recovery reset evidence`.

## Task 6: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged hashes.
- [ ] Push the feature branch, cherry-pick only verified commits into
      `test/676-android-sidebar-filter`, prove identical trees and push the
      consolidated branch.
- [ ] Audit the first hosted merge SHA, renderer manifest, both APKs, four exact
      browser predecessors, dedicated Android artifact, 4/4 stages, 54/54
      identities, attempt 1/retries 0, provenance, redaction, teardown and clean
      worktree.
- [ ] Post evidence to #726, #660, #653 and PR #677; close #726 only after all
      acceptance evidence is complete, then continue with #727.
