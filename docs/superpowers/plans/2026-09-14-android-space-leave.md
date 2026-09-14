# Android Space Leave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-stage installed-Android Maestro/Node replacement for every assertion in the canonical Space-leave Playwright definition while keeping its predecessor enabled.

**Architecture:** The suite reuses the invocation-owned Android device, `AccountWorkspaceClient`, Matrix fixtures, and read-only WebView observation boundary. A source-pinned contract test owns the seven assertion identities and product-input restrictions; one journey module owns fixture setup, native interaction, Matrix membership verification, diagnostics, cleanup, and redaction.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Playwright Android WebView/CDP observation, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

**Spec:** GitHub issue [#706](https://github.com/quwisky/trinity-matrix-client/issues/706), pinned to consolidated base `b23a2474eb366c1d714f8a8d20f1563242003678` and source SHA-256 `a895c51a4a586f80d1399c31d1a3780d0c20c42534c926e9e53cf41f3fe8ed54`.

## Global Constraints

- Preserve the Playwright definition at lines 58–125 and all seven direct assertions; do not retire, skip, weaken, or retry it.
- Drive Space selection, overflow, Leave, Cancel, and confirmation through measured native Maestro input on the exact Pixel 5 profile.
- Restrict CDP to read-only observation and coordinate measurement; it must not click, focus, fill, dispatch product events, submit forms, mutate application state/styles, or navigate.
- Seed and verify the Account, Space, child Room, `m.space.child` link, and memberships through finite Matrix fixtures.
- Keep renderer/APK verification, run-scoped diagnostics, device/WebView/Matrix cleanup, and secret redaction on every exit.
- Run Synapse-backed suites sequentially because they share fixed ports.
- Place the hosted suite on Android shard 2 after `space-settings-core` and before retained Playwright.
- Keep screenshots, APKs, reports, and deliberate-control output under ignored `dist/` paths.

---

### Task 1: Pin the source and seven replacement identities

**Files:**

- Create: `scripts/space-leave-migration.spec.mjs`
- Create: `e2e/android/space-leave-contract.mts`

**Interfaces:**

- Consumes: `space-leave.spec.mts` lines 17–53 and 58–125.
- Produces: `spaceLeaveAssertions`, `SPACE_LEAVE_SOURCE`, native-boundary source guards, and an exact seven-identity invariant.

- [x] **Step 1: Write the failing source-shape and contract test**

Pin the source SHA-256, exact definition title, helper/definition spans, seven literal assertion identities, required native calls, Matrix membership reads, and absence of product `.click()`, `.focus()`, `dispatchEvent`, form submission, history, location, or application-state mutation in the replacement journey.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- space-leave-migration.spec.mjs`

Expected: FAIL because the contract and journey modules do not exist.

- [x] **Step 3: Add the minimal contract module**

Define the pinned source and these identities exactly once: `dialog.space-name`, `dialog.account-name`, `dialog.child-membership-copy`, `cancel.memberships-retained`, `cancel.space-pill-visible`, `confirm.space-left`, and `confirm.child-membership-retained`.

- [x] **Step 4: Re-run the focused contract**

Run: `pnpm nx test scripts -- space-leave-migration.spec.mjs`

Expected: remain red only for the missing journey implementation.

### Task 2: Implement the one-stage native journey and lifecycle

**Files:**

- Create: `e2e/android/space-leave-journeys.mts`

**Interfaces:**

- Consumes: `AccountWorkspaceClient`, `PIXEL_5_ACCOUNT_PROFILE`, `createAccountFixtures`, the Task 1 assertion contract, and invocation-owned Maestro/Matrix resources.
- Produces: one `space-leave` stage with seven assertion records and `journeys.json` lifecycle evidence.

- [x] **Step 1: Seed the exact Matrix fixture**

Create one fresh Account, private Space, private child Room, and parent `m.space.child` link. Record no access token or password in diagnostics.

- [x] **Step 2: Drive the cancellation path natively**

Log in, open the exact Space pill and overflow, tap Leave, observe the exact Space/Account/child-membership copy, tap Cancel, verify both memberships from Matrix, and observe the exact Space pill still visible.

- [x] **Step 3: Drive the confirmation path natively**

Reopen the same menu, confirm Leave, poll Matrix until the Space disappears from joined rooms, and prove the child Room remains joined.

- [x] **Step 4: Add invocation-owned lifecycle evidence**

Install the verified APK, reset to the Pixel 5 profile, write running/passed/failed stage transitions, capture pass/failure diagnostics, redact secrets, and close WebView/device/Matrix resources on every exit. Assert one stage and seven identities.

- [x] **Step 5: Run the migration contract and Android typecheck green**

Run: `pnpm nx test scripts -- space-leave-migration.spec.mjs`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

Expected: PASS.

### Task 3: Register Nx, package, CI diagnostics, and parity docs

**Files:**

- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Modify: `scripts/ci-workflow.spec.mjs`
- Modify: `e2e/android/project.json`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `e2e/registry/commands.mts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `e2e/android/MIGRATION.md`

**Interfaces:**

- Produces: runnable `android.space-leave`, Nx target `trinity-e2e-android:space-leave`, package command `e2e:android:space-leave`, shard-2 started diagnostics, and durable parity mapping.

- [x] **Step 1: Write failing registry and workflow assertions**

Require the new host-budget suite, exact entrypoint/target/script, updated upload count, one `android-space-leave` started-only upload, and ordering after `space-settings-core` on shard 2 but before `pnpm e2e:android --`.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs`

Expected: FAIL because the suite, target, command, workflow step, and upload are absent.

- [x] **Step 3: Add the registry, target, package command, and CI wiring**

Use cache false, parallelism false, Android build dependency, `android-avd`/`synapse` serialization, host timeout, and the single journey entrypoint. Run shard 2 after `space-settings-core`; emit a started flag and upload only when started.

- [x] **Step 4: Document exact parity and provisional bounds**

Add a `Space leave batch` section with #706, pinned base/hash/spans, seven identities, native/CDP boundary, command, artifact path, shard placement, and acceptance gates.

- [x] **Step 5: Re-run focused registry/workflow tests green**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs space-leave-migration.spec.mjs`

Expected: PASS.

### Task 4: Static gates and deliberate red/green controls

**Files:**

- Modify only if a check exposes an owned defect in the files above.
- Keep control evidence under ignored `dist/` paths.

- [x] **Step 1: Run the complete affected static gate set**

Run: `pnpm nx test scripts`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

Run: `pnpm nx run trinity-e2e-android:lint --skipNxCache`

Run: `pnpm nx run trinity-e2e:typecheck --skipNxCache`

Run: `pnpm nx run trinity-e2e:lint --skipNxCache`

Run: `pnpm format:check`

Expected: all pass with retained output and exit statuses.

- [x] **Step 2: Run at least four effective controls and revert each mutation**

Cover a wrong source hash or omitted identity, wrong confirmation text/Account, false cancellation retention, false Space departure, and false child-Room retention. Every control must fail at its intended assertion, then the restored owned check must pass.

### Task 5: Native stability, predecessor, review, and publication

**Files:**

- Modify only if validation or review exposes an owned defect.
- Keep generated evidence under ignored `dist/.playwright/` and `dist/maestro-private/` paths.

- [x] **Step 1: Run three complete unchanged-input native first attempts sequentially**

Run: `pnpm nx run trinity-e2e-android:space-leave --skipNxCache`

Expected for each accepted run: one passed stage, seven assertion records, one attempt, zero retries, completed native commands, exact profile/renderer/APK receipts, and clean teardown.

- [x] **Step 2: Run the unchanged Playwright predecessor**

Run: `pnpm nx run trinity-e2e-browser:e2e -- e2e/browser/journeys/room-administration/space-leave.spec.mts --grep "names the exact Account" --workers=1 --retries=0`

Expected: one pass on its first attempt with clean Synapse teardown.

- [x] **Step 3: Run final diff/worktree checks and request independent review**

Run: `git diff --check`

Run: `git status --short`

Review the complete working-tree artifact against `b23a2474`, including untracked files. Address findings through focused red/green cycles and re-run affected gates.

- [x] **Step 4: Commit and push only after fresh verification**

Stage only #706-owned files, inspect `git diff --cached`, commit as `test(e2e): migrate Android Space leave`, push `test/706-android-space-leave`, cherry-pick onto `test/676-android-sidebar-filter`, verify again, and push the consolidated branch. Do not merge PR #677.

- [x] **Step 5: Audit hosted shard 2 before closing #706**

Require original-attempt green browser and Android shard-2 jobs. Download the immutable suite artifact and audit one stage, seven identities, Matrix membership evidence, native commands, renderer/APK/profile provenance, secret redaction, and teardown before updating #706, #660, #653, and PR #677.
