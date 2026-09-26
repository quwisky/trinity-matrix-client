# Android Member Role Live Updates Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a four-stage installed-Android Maestro/Node replacement for the remaining live member-role, permission-loss, settings-demotion, and blocked-touch definitions while keeping every Playwright predecessor enabled.

**Architecture:** Reuse the invocation-owned Pixel 5 device, `AccountWorkspaceClient`, finite Matrix account/Room fixtures, and the established read-only WebView observation boundary. Apply exact remote power-level transitions through the fixture actor while the relevant product surface remains open. Native Maestro input owns navigation, selection, focus traversal, keyboard activation, and touch. A source-pinned contract owns exactly 25 new direct identities and imports the three shared open-Room identities from #711 only as inherited runtime prerequisites.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Android native key events, Playwright Android WebView/CDP observation, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

---

### Task 1: Pin source shape and exact ownership

**Files:**

- Create: `scripts/member-role-live-updates-migration.spec.mjs`
- Create: `e2e/android/member-role-live-updates-contract.mts`

**Interfaces:**

- Consume `e2e/browser/journeys/room-administration/member-roles.spec.mts`, SHA-256 `58f0cacf00feb7a2587545b8261164632af83b24e0b839cc4be889af6a52b20f`.
- Pin the shared helper at lines 173–193 as inherited from #711, plus definitions at lines 435–480, 482–543, 545–583, and 590–626.
- Produce exactly four `live-promotion.*`, seven `permission-loss.*`, ten `settings-demotion.*`, and four `touch-feedback.*` newly owned identities.
- Reuse `open-members.room-timeline-visible`, `open-members.roster-initially-hidden`, and `open-members.roster-visible` as runtime records without adding them to the 25-site ownership object.

- [x] **Step 1: Write the failing source-shape and contract test**

Require the exact source hash, titles/spans, 25 new identities, four mandatory stages, inherited-helper separation, Pixel 5 profile, remote 0→50 and 100→0 transitions, native focus/key/touch actions, read-only CDP boundaries, lifecycle/cleanup, redaction, and predecessor retention.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- member-role-live-updates-migration.spec.mjs`

Expected: FAIL because the contract and journey modules do not exist.

- [x] **Step 3: Add the minimal contract module**

Define all 25 stable direct identities and exact source metadata; assert count and uniqueness in-module. Reference the three inherited #711 identities without duplicating their source ownership.

- [x] **Step 4: Re-run the focused contract**

Expected: remain red only for missing journeys and registration.

### Task 2: Implement four faithful live-update stages

**Files:**

- Create: `e2e/android/member-role-live-updates-journeys.mts`

- [x] **Step 1: Implement shared fixtures, navigation, and observations**

Seed owner/member Rooms with stable display names. Reuse exact Pixel 5 resets, native login/Rooms/Room/overflow/Members navigation, and read-only element/state observations. Record the three inherited helper identities in every stage while keeping the new ownership count at 25.

- [x] **Step 2: Implement live promotion re-partitioning**

Prove two rows and exact `Owner — 1` / `Member — 1` labels, apply the remote member power transition 0→50 without closing the roster, then prove exact `Owner — 1` / `Moderator — 1` labels and the promoted member in the Moderator section.

- [x] **Step 3: Implement live permission loss and keyboard blocking**

Open the plain member's info panel and prove Kick initially enabled. Demote the already-viewing owner 100→0 remotely without reopening. Prove exact disabled state and description, reach Kick through native Tab traversal, prove tooltip text, send native Enter and Space, and prove no removal dialog. Close through native input, reopen compact overflow, reach disabled Invite through native focus traversal, send Enter and Space, and prove no invite dialog.

- [x] **Step 4: Implement read-only Room Settings after demotion**

Open Room Settings through compact native navigation, prove the surface and initially enabled name control, demote the viewing owner 100→0 remotely, then prove the exact room name rendered as a paragraph, absent General actions, exact Addresses read-only copy, and all four alias mutation controls absent.

- [x] **Step 5: Implement blocked-action touch feedback**

Open the plain member's panel, demote the viewer remotely, prove Kick disabled and visible, use one measured native touch on Kick, then prove the exact unavailable-action feedback and absence of a removal dialog.

- [x] **Step 6: Run focused contract and Android typecheck green**

Run: `pnpm nx test scripts -- member-role-live-updates-migration.spec.mjs`

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

Require suite `android.member-role-live-updates`, target/script/entrypoint, serialized resources, four-stage host budget, shard placement selected from current hosted timing evidence, started flag, artifact surface, and exact upload-count change.

- [x] **Step 2: Verify RED**

Run the focused registry/workflow tests and confirm they fail only for missing registration.

- [x] **Step 3: Add target, script, registry, and hosted wiring**

Use uncached serial execution, `android-avd` plus `synapse`, a bounded four-stage Node test and CI wrapper, and started-only diagnostics. Do not reduce existing suite budgets or move unrelated jobs.

- [x] **Step 4: Document exact parity and inherited helper evidence**

Add a `Member role live updates batch` section with #712, pinned source/hash/spans, 25-site ownership table, three inherited helper identities, native/read-only boundaries, command, artifact path, shard placement, and acceptance gates.

- [x] **Step 5: Re-run focused registry/workflow tests green**

### Task 4: Static gates and deliberate controls

- [x] **Step 1: Run focused and full script tests**

Run the migration contract test, registry/workflow tests, then `pnpm nx test scripts --skipNxCache`.

- [x] **Step 2: Run typecheck, lint, formatting, and diff checks**

Run Android and browser typecheck/lint, `pnpm format:check`, `git diff --check`, and inspect status.

- [x] **Step 3: Run at least five effective failing controls and restore each**

Cover an omitted direct identity, false inherited-helper readiness, 49 instead of 50 promotion, a CDP focus mutation replacing native Tab traversal, and an absent-dialog check weakened to a non-exact result. Every mutation must fail its intended guard and the restored check must pass.

### Task 5: Native stability, predecessors, review, and publication

- [x] **Step 1: Run three complete unchanged-input native first attempts sequentially**

Run: `pnpm nx run trinity-e2e-android:member-role-live-updates --skipNxCache`

Require four passed stages, 25 newly owned identities, 37 stage-local records including inherited readiness, one suite attempt, zero retries, completed native commands, exact live transition receipts, profile/renderer/APK provenance, redaction, and clean teardown each time.

- [x] **Step 2: Run all four unchanged Playwright predecessors sequentially**

Run the four exact titles with `--workers=1 --retries=0`; require one first-attempt pass for each.

- [x] **Step 3: Review the final diff and evidence**

Require no unresolved findings and confirm the canonical Playwright source remains unchanged.

- [x] **Step 4: Publish only after #711 hosted acceptance and fresh verification**

Commit and push `test/712-android-live-role-updates`, cherry-pick onto `test/676-android-sidebar-filter`, verify the composed tree, and push. Never merge PR #677.

- [x] **Step 5: Audit original-attempt hosted evidence before closing #712**

Require green owned Android shard evidence and exact hosted predecessor passes at retry 0. Audit the immutable suite artifact for four stages, all direct and inherited records, exact live transitions and blocked-action results, completed native commands, renderer/APK/profile provenance, secret redaction, and teardown. Track unrelated job-level reliability separately on #665, then update #712, #660, #653, and PR #677.
