# Android Security Settings Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans` and
> `superpowers:test-driven-development`; subagent delegation is not part of
> this plan.

**Goal:** Add faithful installed-Android parity for the two applicable Security
settings paths while preserving the complete Playwright predecessor and its
production-hook exclusion.

**Architecture:** A focused Vitest source guard pins the canonical shapes and
forbidden shortcuts. A dedicated two-stage Node suite reuses established
account, Maestro and read-only WebView seams. Existing Nx, registry and CI
patterns publish bounded diagnostics without changing product behavior.

**Spec:**
`docs/superpowers/plans/2026-09-17-android-security-settings-design.md`

## Global constraints

- Preserve all four pinned files and exact owned spans unchanged.
- Record exactly 15 unique identities: five posture, four narrow verification,
  and six stage-qualified inherited Settings identities.
- Maestro owns every reachable product action; REST arranges accounts and CDP
  only observes.
- Require exact setup/verify/return routes and exact focused headings.
- Preserve the browser-only fault test and its production-APK exclusion.
- Use one attempt, zero retries, bounded teardown and secret redaction.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/security-settings-migration.spec.mjs`.
- Read the four pinned canonical sources.

- [ ] Assert exact hashes, source boundaries, 5 + 4 direct assertion sites,
      two native route branches, two Settings helper calls and the fault exclusion.
- [ ] Require the exact 15 contract identities and uniqueness.
- [ ] Require two stages, exact profiles, native taps, fresh account setup,
      route/focus observations, assertion accounting, captures and aggregate
      cleanup/redaction.
- [ ] Reject DOM actions, production hooks, counterfeit fault injection,
      retries and unbounded resources.
- [ ] Require Nx/package/registry/CI/docs wiring and predecessor retention.
- [ ] Add effective mutation controls for posture, routes, focus, exclusion,
      cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/security-settings-migration.spec.mjs`
      and preserve the expected RED result.
- [ ] Commit as `test(e2e): guard Android Security settings migration`.

## Task 2: Implement the contract and two native stages

**Files:**

- Create `e2e/android/security-settings-contract.mts`.
- Create `e2e/android/security-settings-journeys.mts`.

- [ ] Export exact source mappings, grouped identities and assertion types;
      assert 15 identities and uniqueness at module load.
- [ ] Add a local `NARROW_SECURITY_PROFILE` matching 700×760 with desktop
      traits.
- [ ] Add local helpers for recording an identity once, bounded element/surface
      observation, Account-qualified Rooms readiness and native Settings → Security
      navigation.
- [ ] Implement `fresh-posture-setup`: fresh REST fixture account, app login,
      three inherited observations, five direct observations, native setup tap,
      exact `/encryption/setup` and return target.
- [ ] Implement `narrow-verification-return`: separate fresh account, exact
      700×760 profile, three inherited observations, native verify/close taps,
      exact routes, verify page and both focused headings.
- [ ] Write started-stage reports, pass/failure captures, exact assertion
      accounting and aggregate client/device/fixture cleanup with redaction.
- [ ] Run the focused guard to the wiring-only RED boundary and run
      `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`.
- [ ] Commit as `test(e2e): migrate Android Security settings`.

## Task 3: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add uncached, serial `security-settings` target with Android build
      dependency, 15-minute Node bound, `android-avd` + `synapse` resources and
      package command `e2e:android:security-settings`.
- [ ] Register `android.security-settings` as required/current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 4 after OIDC with a 20-minute wrapper and started
      marker; add started-only `android-security-settings` diagnostics.
- [ ] Extend registry/workflow source guards for the exact entry, ordering,
      timeout and diagnostic path.
- [ ] Document pinned ownership, 15 identities, native/REST/CDP boundaries,
      execution, artifact/redaction/cleanup and explicit predecessor coexistence.
- [ ] Run the focused migration, registry and workflow tests GREEN, then the
      full scripts test target.
- [ ] Commit wiring as `ci(e2e): register Android Security settings` and docs as
      `docs(e2e): describe Android Security settings migration`.

## Task 4: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:security-settings --skipNxCache`
      three times sequentially on unchanged inputs; require 2/2 stages, 15/15
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained artifact for passwords, access/session values and
      bearer patterns; require clean teardown.
- [ ] Run the complete unchanged Security settings browser predecessor with one
      worker and `--retries=0`; require all three tests to pass and recheck hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK hashes, invocation IDs,
      durations, negative controls and artifacts in the ledger.
- [ ] Commit as `docs(e2e): record Android Security settings evidence`.

## Task 5: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged hashes.
- [ ] Push the feature branch, cherry-pick only verified commits into
      `test/676-android-sidebar-filter`, prove identical trees and push the
      consolidated branch.
- [ ] Audit the first hosted merge SHA, renderer manifest, exact browser
      predecessor, dedicated Android artifact, 2/2 stages, 15/15 identities,
      attempt 1/retries 0, profile/APK provenance, redaction, teardown and clean
      worktree.
- [ ] Post evidence to #725, #660, #653 and PR #677; close #725 only after all
      acceptance evidence is complete, then continue with #726.
