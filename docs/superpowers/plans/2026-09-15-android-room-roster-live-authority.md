# Android Room Roster and Live Authority Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one installed-Android Maestro/Node replacement for the canonical Room roster, member detail, role changes, live authority, moderation, banned-list recovery, and Conversation-roster continuity definition while keeping the Playwright predecessor enabled.

**Architecture:** Add a dedicated `android.room-roster-live-authority` suite so the large canonical definition has an independent one-attempt diagnostic envelope. Reuse the invocation-owned Pixel 5 device, `AccountWorkspaceClient`, finite Matrix account/Room fixtures, and read-only WebView observation boundary. REST may perform only setup, controller-authored live power changes, membership rejoin transitions, and authoritative server observations. Maestro owns every installed-app navigation, selection, role change, moderation confirmation, banned-list recovery, Escape, Conversation-roster, detail-close, and focus interaction.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Playwright Android WebView/CDP observation, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

---

### Task 1: Pin source shape and exact parity ownership

**Files:**

- Create: `scripts/room-roster-live-authority-migration.spec.mjs`
- Create: `e2e/android/room-roster-live-authority-contract.mts`

**Interfaces:**

- Pin `e2e/browser/journeys/room-administration/room-members-and-addresses.spec.mts`, SHA-256 `f306f5bfffca9f7a476966d7d2ff678a227fa7b2fae6e2f4934fb46c6c218ff5`, definition lines 172–401.
- Pin `e2e/browser/support/room-settings-journey.mts`, SHA-256 `bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`, helper lines 36–44.
- Pin `e2e/support/app.mts`, SHA-256 `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`, helper lines 228–248.
- Own exactly 33 direct assertion sites at lines 253, 257, 261, 264–265, 268, 270, 272, 286, 289, 292–295, 314, 320–322, 329, 341, 345, 351–355, 362, 368–374, 387, 395, and 397–400 plus the two transitive helper sites at lines 41–43 and 245–247: 35 unique identities total.

- [x] **Step 1: Write the failing source-shape and contract test**

Require exact hashes, title/span, 33 direct plus two helper identities, one mandatory stage, Pixel 5 profile, controller/admin/member setup, exact 101/100/0 initial powers, native action boundaries, role 50, live 100→0→100 authority projection, kick/rejoin/ban/unban/rejoin transitions, exact dialog content, Escape, Conversation roster continuity, final focus, lifecycle/cleanup, redaction, registry/CI wiring, and predecessor retention.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- room-roster-live-authority-migration.spec.mjs`

Expected: FAIL because the contract and journey modules do not exist.

- [x] **Step 3: Add the minimal contract module**

Define stable source metadata and all 35 identities; assert direct/helper/total counts and uniqueness in-module.

- [x] **Step 4: Re-run the focused contract**

Expected: remain red only for the missing journey and registration.

### Task 2: Add the finite roster fixture operations and faithful native journey

**Files:**

- Modify: `e2e/android/account-workspace-fixtures.mts` only if a required bounded operation is not already exposed
- Create: `e2e/android/room-roster-live-authority-journeys.mts`

- [x] **Step 1: Reuse or add only narrow fixture operations**

Create controller, admin, and member accounts; set the member display name before membership; create the private Room with controller power 101 and admin power 100; join admin and member. Reuse bounded set-power, invite, join, kick, ban, and membership observation operations wherever already available. Keep credentials/tokens inside the fixture closure and model all terminal membership states for cleanup.

- [x] **Step 2: Drive roster, detail, and role 50 natively**

Log in as admin, open the exact Room and Members destination, prove the roster/target/detail, choose role 50, prove exact Room and opening Account in the confirmation, confirm natively, then prove the Moderator group and selected detail projection.

- [x] **Step 3: Prove live authority loss and restoration**

Use the controller fixture to demote the opening admin from 100 to 0 without closing or retargeting the selected detail. Prove kick and ban are absent while the target and Moderator role remain readable. Restore admin power 100 and prove the actions reappear on the same detail.

- [x] **Step 4: Drive kick, ban, unban, and rejoin continuity natively**

Activate kick with keyboard-equivalent Maestro input, prove exact target/Room/Account confirmation, enter `cleanup`, confirm, and prove the row disappears plus exact server membership. Reinvite/rejoin through the fixture, select the row through keyboard-equivalent input, ban with exact confirmation, and prove row removal/server ban. Open Banned through native focus/Enter semantics, prove the target, unban with exact confirmation, and prove banned-row removal/server leave. Reinvite/rejoin again.

- [x] **Step 5: Prove Escape and Conversation roster continuity**

Use native Escape to close Room Settings, open the Conversation roster with a measured Maestro-native tap, find and activate the same member, prove Conversation detail, close it natively, prove the row remains visible and the member filter owns focus.

- [x] **Step 6: Preserve diagnostics and teardown**

Record all 35 identities, pass captures, native command artifacts, Pixel 5/renderer/APK provenance, started-only failure evidence, secret redaction, exact UI/server outcomes, and cleanup on every exit.

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

Require suite `android.room-roster-live-authority`, target/script/entrypoint, serialized `android-avd` and `synapse` resources, bounded one-stage host budget, shard-3 placement after `room-unban` and before `member-moderation`, a started flag, one exact artifact surface, and the corresponding upload-count increment.

- [x] **Step 2: Verify RED**

Run focused registry/workflow tests and confirm they fail only for missing registration.

- [x] **Step 3: Add target, script, registry, and hosted wiring**

Use uncached serial execution and started-only diagnostics. Do not reduce existing suite budgets, alter accepted suite composition, or move unrelated jobs.

- [x] **Step 4: Document parity and acceptance**

Add a Room roster/live-authority batch section with #714, pinned sources/hashes/spans, 33+2 ownership table, native/read-only boundaries, command, artifact path, shard placement, and acceptance gates.

- [x] **Step 5: Re-run focused contract, registry, and workflow tests green**

### Task 4: Static gates and deliberate controls

- [x] **Step 1: Run focused and full script tests**

Run the migration contract, registry/workflow tests, then `pnpm nx test scripts --skipNxCache`.

- [x] **Step 2: Run typecheck, lint, formatting, and diff checks**

Run Android and browser typecheck/lint, `pnpm format:check`, `git diff --check`, and inspect status.

- [x] **Step 3: Run at least five effective failing controls and restore each**

Cover one omitted direct identity, one omitted helper identity, a WebView click replacing a native action, weakened live-authority absence/restoration, and weakened exact moderation/server transition evidence. Every mutation must fail its intended guard and the restored check must pass.

### Task 5: Stability, predecessor, review, and publication

- [x] **Step 1: Run three complete unchanged-input native first attempts sequentially**

Run: `pnpm nx run trinity-e2e-android:room-roster-live-authority --skipNxCache`

Require one passed stage, all 35 records, one suite attempt, zero retries, completed native commands, exact UI/server evidence, Pixel 5/renderer/APK provenance, redaction, and clean teardown each time.

- [x] **Step 2: Run the unchanged Playwright predecessor**

Run the exact title with `--workers=1 --retries=0`; require one first-attempt pass.

- [x] **Step 3: Review the final diff and evidence**

Require no unresolved findings and confirm all three pinned predecessor/helper sources remain unchanged.

- [x] **Step 4: Publish after fresh composed-tree verification**

Commit/push the issue-named feature branch, cherry-pick onto `test/676-android-sidebar-filter`, verify the composed tree, and push. Never merge PR #677.

- [x] **Step 5: Audit original-attempt hosted evidence before closing the child**

Require green owned Android evidence and the exact hosted predecessor at retry 0. Audit the immutable suite artifact for the stage, all 35 records, exact UI/server outcomes, completed native commands, renderer/APK/profile provenance, secret redaction, and teardown; then update the child, #660, #653, and PR #677.

Hosted acceptance is recorded by original-attempt [run 34932186969](https://github.com/quwisky/trinity-matrix-client/actions/runs/34932186969) from consolidated source `7864731f2464b1c452ead0fb8fa0c7ad99bc5f5b` and hosted merge `e5db94e94a8f7013a6f083f8b13ef9f80a452148`. Owned Android shard 3 [job 104262819521](https://github.com/quwisky/trinity-matrix-client/actions/runs/34932186969/job/104262819521) passed on run attempt 1. Immutable [native artifact 10385576752](https://github.com/quwisky/trinity-matrix-client/actions/runs/34932186969/artifacts/10385576752), digest `cb225fbcd17087db59c3ed0de26f9ae621d996005de74f0746c0f9cb19b18cc3`, records one passed stage in 311,535 ms, one suite attempt, zero retries, all 35 assertion identities, 19 successful native action files and 91 of 91 completed command entries. It preserves exact role, kick, ban and unban dialogs; the controller-authored admin 100→0→100 transitions; blocked moderation actions while demoted; exact kick, ban, unban and rejoin membership outcomes; Escape, Conversation roster/detail continuity and final member-filter focus; pass captures; installed APK/device/profile and renderer provenance; zero targeted secret matches; and successful device, WebView, Matrix and Synapse teardown.

The audited [renderer artifact 10382172118](https://github.com/quwisky/trinity-matrix-client/actions/runs/34932186969/artifacts/10382172118), artifact digest `89fac69d4d73108001707a111aa8498c441b4dce2d29c2c7e6a2868352f80b14`, contains 49 individually verified files whose recomputed manifest digest is `c7c73787c08c14e0ac6ff15a9af66c5ebe04825837eaf7a59ab4803fb2e764cc`. [Browser artifact 10382492300](https://github.com/quwisky/trinity-matrix-client/actions/runs/34932186969/artifacts/10382492300), digest `377c0a306d46f9e6b7d7eb59223f68651236e3291f9db5dfd8245e5cd4c28b59`, records the exact unchanged predecessor passing once at retry 0 in 10,231 ms; its full suite records 317 passes, one skip and zero retries. The overall run's unrelated unchanged shard-2 native-shell timeout is tracked on #665; every #714-owned gate passed. No rerun was used, and predecessor retirement remains unauthorized.
