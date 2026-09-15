# Android Room Unban Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one installed-Android Maestro/Node replacement for the canonical Room banned-list unban definition while keeping the Playwright predecessor enabled.

**Architecture:** Add a dedicated `android.room-unban` suite so this new source definition and its diagnostics remain independent from the accepted #709 member-moderation evidence. Reuse the invocation-owned Pixel 5 device, `AccountWorkspaceClient`, finite Matrix account/Room fixtures, and read-only WebView observation boundary. Add only the narrow fixture operation needed to ban the joined target before native interaction. Maestro owns login, Room and Room Settings navigation, opening the banned list, Unban activation, and confirmation; Matrix REST is used only for setup and the final authoritative membership observation.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Playwright Android WebView/CDP observation, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

---

### Task 1: Pin source shape and exact parity ownership

**Files:**

- Create: `scripts/room-unban-migration.spec.mjs`
- Create: `e2e/android/room-unban-contract.mts`

**Interfaces:**

- Pin `e2e/browser/journeys/room-administration/room-members-and-addresses.spec.mts`, SHA-256 `f306f5bfffca9f7a476966d7d2ff678a227fa7b2fae6e2f4934fb46c6c218ff5`, definition lines 75–170.
- Pin `e2e/browser/support/room-settings-journey.mts`, SHA-256 `bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`, helper lines 36–44.
- Pin `e2e/support/app.mts`, SHA-256 `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`, helper lines 228–248.
- Own exactly seven direct predecessor sites at lines 139, 145, 152, 153, 154, 156–160, and 169 plus the two transitive helper sites at lines 41–43 and 245–247: nine unique identities total.

- [x] **Step 1: Write the failing source-shape and contract test**

Require exact hashes, title/spans, seven direct plus two helper identities, one mandatory stage, Pixel 5 profile, finite joined-then-banned setup, native action boundaries, exact confirmation/toast content, authoritative `leave` result, lifecycle/cleanup, redaction, registry/CI wiring, and predecessor retention.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- room-unban-migration.spec.mjs`

Expected: FAIL because the contract and journey modules do not exist.

- [x] **Step 3: Add the minimal contract module**

Define stable source metadata and all nine identities; assert direct/helper/total counts and uniqueness in-module.

- [x] **Step 4: Re-run the focused contract**

Expected: remain red only for the missing journey and registration.

### Task 2: Add the finite ban fixture and faithful native journey

**Files:**

- Modify: `e2e/android/account-workspace-fixtures.mts`
- Create: `e2e/android/room-unban-journeys.mts`

- [x] **Step 1: Add the narrow fixture operation**

Expose `ban(owner, roomId, member, reason)` as a bounded Matrix `POST /ban`. Require the member to be tracked for cleanup and preserve tokens inside the fixture closure. Mark the banned membership as an allowed ended-membership cleanup state only after setup succeeds.

- [x] **Step 2: Seed and prove the banned target**

Create admin and target accounts, set the target display name before membership events, create a private Room with invite, join the target, ban with reason `spam`, and assert the admin observes exact `ban` membership before UI interaction.

- [x] **Step 3: Drive the full unban path natively**

Log in as admin, open Rooms and the exact Room, open Room Settings through compact overflow, select Members, open Banned, and prove the surface and exact target row. Tap Unban through Maestro, prove the dialog contains exact target, Room, and opening Account, confirm natively, prove the exact success toast, then poll exact server membership `leave`.

- [x] **Step 4: Preserve diagnostics and teardown**

Record all nine identities, pass captures, native command artifacts, Pixel 5/renderer/APK provenance, started-only failure evidence, secret redaction, and cleanup on every exit.

- [x] **Step 5: Run focused contract and Android typecheck green**

Run: `pnpm nx test scripts -- room-unban-migration.spec.mjs`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

### Task 3: Register target, CI, and migration ledger

**Files:**

- Modify: `e2e/android/project.json`
- Modify: `package.json`
- Modify: `e2e/registry/commands.mts`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Modify: `scripts/ci-workflow.spec.mjs`
- Modify: `e2e/android/MIGRATION.md`

- [x] **Step 1: Add failing registry/workflow assertions**

Require suite `android.room-unban`, target/script/entrypoint, serialized `android-avd` and `synapse` resources, bounded one-stage host budget, shard placement after message moderation and before the accepted member-moderation target, a started flag, one exact artifact surface, and the corresponding upload-count increment. This keeps the owned artifact reachable when later unrelated moderation coverage fails.

- [x] **Step 2: Verify RED**

Run the focused registry/workflow tests and confirm they fail only for missing registration.

- [x] **Step 3: Add target, script, registry, and hosted wiring**

Use uncached serial execution and started-only diagnostics. Do not reduce existing suite budgets, alter accepted suite composition, or move unrelated jobs.

- [x] **Step 4: Document parity and acceptance**

Add a Room unban batch section with #713, pinned sources/hashes/spans, 7+2 ownership table, native/read-only boundaries, command, artifact path, shard placement, and acceptance gates.

- [x] **Step 5: Re-run focused registry/workflow tests green**

### Task 4: Static gates and deliberate controls

- [x] **Step 1: Run focused and full script tests**

Run the migration contract, registry/workflow tests, then `pnpm nx test scripts --skipNxCache`.

- [x] **Step 2: Run typecheck, lint, formatting, and diff checks**

Run Android and browser typecheck/lint, `pnpm format:check`, `git diff --check`, and inspect status.

- [x] **Step 3: Run at least five effective failing controls and restore each**

Cover one omitted direct identity, one omitted helper identity, a WebView click replacing a native tap, weakened exact dialog content, and weakened server membership. Every mutation must fail its intended guard and the restored check must pass.

### Task 5: Stability, predecessor, review, and publication

- [x] **Step 1: Run three complete unchanged-input native first attempts sequentially**

Run: `pnpm nx run trinity-e2e-android:room-unban --skipNxCache`

Require one passed stage, all nine records, one suite attempt, zero retries, completed native commands, exact confirmation/toast/server evidence, Pixel 5/renderer/APK provenance, redaction, and clean teardown each time.

- [x] **Step 2: Run the unchanged Playwright predecessor**

Run the exact title with `--workers=1 --retries=0`; require one first-attempt pass.

- [x] **Step 3: Review the final diff and evidence**

Require no unresolved findings and confirm all three pinned predecessor/helper sources remain unchanged.

- [x] **Step 4: Publish only after #712 hosted acceptance and fresh verification**

Create the linked child issue and issue-named feature branch, carry the reviewed implementation onto the accepted consolidated base, commit/push the feature, cherry-pick onto `test/676-android-sidebar-filter`, verify the composed tree, and push. Never merge PR #677.

- [x] **Step 5: Audit original-attempt hosted evidence before closing the child**

Require green owned Android evidence and the exact hosted predecessor at retry 0. Audit the immutable suite artifact for the stage, all nine records, exact confirmation/toast/server outcomes, completed native commands, renderer/APK/profile provenance, secret redaction, and teardown; then update the child, #660, #653, and PR #677.

Hosted acceptance is recorded by original-attempt [run 34919262884](https://github.com/quwisky/trinity-matrix-client/actions/runs/34919262884) from consolidated source `86ebd1022d16da39d07d4e1defd160ac0ee36653` and hosted merge `9f6e49a26e3e967d55faa392aa43a361a6c462fc`. Owned Android shard 3 [job 104223764913](https://github.com/quwisky/trinity-matrix-client/actions/runs/34919262884/job/104223764913) passed on run attempt 1. Immutable [native artifact 10379458816](https://github.com/quwisky/trinity-matrix-client/actions/runs/34919262884/artifacts/10379458816) records one passed stage, one suite attempt, zero retries, all nine assertion identities, 13 native command files and 64 of 64 completed command entries. It preserves exact target/Room/Account confirmation, exact `Unbanned <target>.` toast, final server membership `leave`, pass captures, installed `eu.qwky.trinity` APK and hosted API 36 / Pixel 6 device provenance, renderer identity, zero targeted secret matches, and successful device, WebView, Matrix and Synapse teardown.

The audited [renderer artifact 10377771152](https://github.com/quwisky/trinity-matrix-client/actions/runs/34919262884/artifacts/10377771152) contains 49 individually verified files and digest `9ad995de220185e6e44bdcadd4ab989aae5e0fb75bf2e65d6efa75436c824c9b`. [Browser artifact 10378565873](https://github.com/quwisky/trinity-matrix-client/actions/runs/34919262884/artifacts/10378565873) records the exact unchanged predecessor passing once at retry 0 in 6,067 ms. The overall run's unrelated unchanged shard-1 `android.space-room-order` timeout is tracked on #665; every #713-owned gate passed. No rerun was used, and predecessor retirement remains unauthorized.
