# Android Account Password Change Migration Plan

> **For Codex:** Follow this plan task by task. Keep Maestro-native input as the
> owner of product actions, keep credentials out of diagnostics, and retain the
> Playwright predecessor throughout this batch.

**Goal:** Migrate issue #720's account password-change journey to one
deterministic installed-Android Maestro/Node suite while preserving five direct
and three inherited assertions.

**Architecture:** A source-pinned contract enumerates eight unique identities.
One Android stage registers a disposable password account, signs in through the
installed app, reaches Settings → Account through native taps, proves rejected
and successful UIA password submissions, and independently probes the old and
new credentials through finite Matrix REST requests. Successful probe sessions
are revoked immediately. Artifacts contain only boolean/status observations and
are redacted again during cleanup.

**Tech stack:** TypeScript ESM, Node assertions, Maestro, Android WebView CDP
observation, disposable Synapse Matrix REST, Nx/Vitest and GitHub Actions.

---

## Task 1: Lock the predecessor and executable contract

**Files:**

- Create: `scripts/account-password-change-migration.spec.mjs`
- Create: `e2e/android/account-password-change-contract.mts`

1. Pin the exact predecessor, navigation helper and app-helper SHA-256 hashes
   plus their owned spans.
2. Guard exactly five direct and three inherited unique identities, native
   product-action ownership, registry/CI wiring, predecessor retention,
   redaction and bounded probe cleanup.
3. Run the focused guard before the implementation and preserve the expected
   RED caused by the missing journey/registration.
4. Add the source mappings and identity contract, then keep the guard RED only
   for the next missing implementation seam.

## Task 2: Implement the password-change stage

**Files:**

- Create: `e2e/android/account-password-change-journeys.mts`
- Modify: `scripts/account-password-change-migration.spec.mjs`

1. Register and sign in a unique disposable account through the installed app.
2. Open Settings and Account with native Maestro taps; record the stable
   Account-qualified Rooms URL, visible Settings navigation, non-empty detail
   and ready password form.
3. Fill a wrong current password plus matching new credentials and submit
   natively. Record exact inline feedback and retained new-password fields
   without writing credential values to diagnostics.
4. Replace only the current password, submit natively and record the exact
   success toast.
5. Probe new-password HTTP 200 and old-password HTTP 403. Revoke every
   successful observation session in `finally` with an independent timeout.
6. Record each of the eight identities exactly once, capture pass/failure
   diagnostics and prove the focused guard GREEN.

## Task 3: Register Nx and hosted execution

**Files:**

- Modify: `e2e/android/project.json`
- Modify: `package.json`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `e2e/registry/commands.mts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Modify: `scripts/ci-workflow.spec.mjs`

1. Register `android.account-password-change`, Nx target
   `account-password-change`, and package command
   `e2e:android:account-password-change` with Android AVD and Synapse resources.
2. Place it on the shortest suitable Android shard from the latest completed
   hosted timing evidence, with a bounded wrapper and started-only artifact.
3. Update guards first, prove RED, add runtime wiring and prove GREEN.

## Task 4: Document and validate locally

**Files:**

- Modify: `e2e/android/MIGRATION.md`
- Modify: this plan

1. Document scope, eight identities, native/REST boundaries, invocation,
   artifacts, one-attempt policy and predecessor retention.
2. Run focused and full script guards, Android/browser typecheck and lint,
   repository formatting and documentation gates.
3. Run at least six effective negative controls.
4. Run the installed-Android suite three consecutive times on unchanged input,
   requiring original-attempt passes, eight identities exactly once, complete
   redaction/provenance and clean teardown.
5. Run the exact Playwright predecessor once at retry 0.

## Task 5: Review, publish and obtain hosted acceptance

1. Review the complete diff and run the final selected verification set.
2. Commit and push `test/720-android-password-change`.
3. Cherry-pick the verified commit to `test/676-android-sidebar-filter`, verify
   identical trees and push without merging PR #677.
4. Require the exact-head original-attempt hosted Android suite and retained
   browser predecessor to pass with zero retries; audit Android/browser/renderer
   artifacts and teardown logs.
5. Record acceptance, push the documentation commit to both branches, comment
   on #720, #660, #653 and PR #677, then close #720 only. Never merge PR #677.

## Acceptance evidence

- [x] Focused contract starts RED and ends GREEN.
- [x] Seven effective negative controls fail their intended guards and are restored.
- [x] Three unchanged-input Android runs and the exact predecessor pass at retry 0.
- [x] Static, documentation, format and full-script gates pass.
- [x] Review has no unresolved findings.
- [ ] Original-attempt hosted Android/browser/renderer evidence is audited.
