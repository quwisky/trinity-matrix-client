# Android Room Access Policy Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one installed-Android Maestro/Node replacement for all four canonical Room access-policy definitions while keeping every Playwright predecessor enabled.

**Architecture:** Add a four-stage `android.room-access-policy` suite using the existing installed APK, desktop WebView profile, `AccountWorkspaceClient`, finite Matrix fixtures, and the reversible document-root visual fixture. Maestro owns every product interaction. REST creates and observes finite Room/Space/account state; CDP is read-only except for the source-pinned, immediately restored light/text-scale and dark/amethyst screenshot fixture.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Android WebView/CDP observation, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

**Spec:** https://github.com/quwisky/trinity-matrix-client/issues/716

## Global Constraints

- Base all work on accepted consolidated head `4ccfca1704a69d171697d5cb462469a0b8561811`.
- Preserve `e2e/browser/journeys/room-administration/room-access-settings.spec.mts` byte-for-byte at SHA-256 `3ae190d7814f8e3e2fda6640bcbfb77e089b1da8605b11645b7e79c2df0bcb6c`.
- Preserve `e2e/browser/support/room-settings-journey.mts` byte-for-byte at SHA-256 `bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`.
- Preserve `e2e/support/app.mts` byte-for-byte at SHA-256 `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`.
- Own the four definitions at lines 20–137, 139–215, 217–314, and 316–390; the 23 direct assertion sites on lines 51, 56, 58, 61, 64, 86, 108, 119, 124, 134, 178, 183, 193, 209, 212, 286, 295, 299, 369, 372, 375, 378, and 381; and six helper call-site obligations: two `openRoom` timeline checks plus one Access-panel check in each stage. The final stage-one Addresses-panel helper check is represented by the identical direct line-134 outcome, yielding exactly 29 unique identities.
- Use `DESKTOP_ACCOUNT_PROFILE` (`1280x720`, non-mobile, non-touch, scale factor 1) for all four definitions.
- REST may create and observe finite fixtures. CDP may read state and temporarily mutate only the document root for the two source-pinned captures, with restoration in `finally`; neither may click, focus, submit, navigate, or mutate product state.
- Preserve one attempt, zero retries, serialized `android-avd` and `synapse` resources, renderer/APK/profile provenance, bounded teardown, and secret redaction.
- Keep all four Playwright predecessors enabled. Never merge PR #677.

---

### Task 1: Pin source shape and exact parity ownership

**Files:**

- Create: `scripts/room-access-policy-migration.spec.mjs`
- Create: `e2e/android/room-access-policy-contract.mts`

- [x] **Step 1: Write the failing source-shape test**

Pin all three source hashes, exact definition boundaries/titles, 10+5+3+5 direct expectation sites, two `openRoom` uses, five `openSettingsTab` uses, and the deliberate stage-one Addresses-panel folding rule.

- [x] **Step 2: Require the stable 23+6 contract**

Require four ordered source mappings, 23 direct identities, six inherited identities, 29 unique total identities, and four desktop cases that consume every identity exactly in its owning stage.

- [x] **Step 3: Require interaction, observation, visual-fixture, and lifecycle boundaries**

Require finite account/Room/Space setup; exact version-9 Room creation; exact join-rule/history/allow-list outcomes; native Room/Space/settings/select/checkbox/save/focus/Enter actions; the reversible visual fixture and named captures; pass/fail capture; device/WebView/Matrix cleanup; redaction; registry/CI wiring; and predecessor retention. Reject DOM click/focus/submission/navigation and product mutations outside the approved visual-fixture helper.

- [x] **Step 4: Verify RED**

Run: `pnpm nx test scripts -- room-access-policy-migration.spec.mjs`

Expected: FAIL because the contract and journey are absent.

- [x] **Step 5: Add the minimal contract module**

Export `ROOM_ACCESS_POLICY_SOURCES`, stage-grouped direct/helper assertion objects, a merged `roomAccessPolicyAssertions`, and `RoomAccessPolicyAssertion`. Assert 23 direct, six helper, 29 total, and 29 unique identities in-module.

- [x] **Step 6: Re-run the focused contract**

Expected: source and contract tests pass; journey/fixture/registration requirements remain red.

### Task 2: Add bounded Room-version fixture support

**Files:**

- Modify: `e2e/android/account-workspace-fixtures.mts`
- Modify: `scripts/account-workspace-fixtures.spec.mjs`

- [x] **Step 1: Add a failing version-9 fixture test**

Exercise `fixtures.createRoom(owner, { name, preset: 'private_chat', roomVersion: '9' })`; require exact `room_version: '9'` transport while preserving existing payloads and token-free returned/serialized evidence.

- [x] **Step 2: Verify focused RED**

Run: `pnpm nx test scripts -- account-workspace-fixtures.spec.mjs`

Expected: FAIL because `roomVersion` is not forwarded.

- [x] **Step 3: Implement the narrow extension**

Add `readonly roomVersion?: '9'` to `WorkspaceRoomContent` and emit `room_version` only when present. Do not broaden supported versions or alter existing Room payloads.

- [x] **Step 4: Re-run the fixture test green**

### Task 3: Implement the four faithful installed-Android stages

**Files:**

- Create: `e2e/android/room-access-policy-journeys.mts`

- [x] **Step 1: Add evidence helpers and native navigation**

Add failure-recording `observedElements(...)` and `observedServerValue(...)`, `focusByNativeTab(...)`, native `openRoom(...)`, `selectSpaceRoom(...)`, and `openAccessPanel(...)`. Every observation records its last value before rethrow; every product action uses `AccountWorkspaceClient` native input.

- [x] **Step 2: Implement admin public/history stage**

Create one owner/private Room, log in, open the Room and settings, prove inactive/active sections and focused Access heading, natively choose Public and World readable, use the reversible visual fixture for the two exact captures, focus Save through native Tab and press Enter, prove exact server state, then open Addresses and prove the panel.

- [x] **Step 3: Implement restricted Space allow stage**

Create one owner, one version-9 private Room, and one parent Space with `m.space.child`; enter the Room through the Space pill, select Restricted, prove the exact Space checkbox, save natively, and record exact `{ join_rule: 'restricted', allow: [{ type: 'm.room_membership', room_id: space.id }] }` server state.

- [x] **Step 4: Implement revoked Space stage**

Create one version-9 Room linked to kept and dropped Spaces, seed Restricted with both standard entries plus the exact unknown entry, enter through the kept Space, prove and untick the dropped checkbox, save, and record the exact retained standard kept entry plus byte-equivalent unknown entry.

- [x] **Step 5: Implement ordinary-member read-only stage**

Create owner/member accounts and one invited/joined Room with `history_visibility: 'joined'`; log in as member, open Access, prove exact Invite only and Members — since they joined text, both exact role-warning messages, absence of `room-settings-access-actions`, and the exact read-only capture.

- [x] **Step 6: Preserve four-stage diagnostics and teardown**

Install once, reset each stage to `DESKTOP_ACCOUNT_PROFILE`, record all 29 identity files, capture `passed` or `failed`, write stage status/duration/failure count, redact account passwords, close WebView/device and clean Matrix resources on every exit. Assert exactly four cases.

- [x] **Step 7: Re-run focused contracts green**

Run: `pnpm nx test scripts -- room-access-policy-migration.spec.mjs account-workspace-fixtures.spec.mjs`

### Task 4: Register the suite, hosted artifact, and migration ledger

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

Require target/script/entrypoint, exact suite ID, no-cache one-attempt runner, serialized resources, bounded timeouts, first-suite shard-3 ordering before `accounts-workspace`, started flag, exact report path `android.room-access-policy/**`, artifact surface, and upload-count increment. The original after-`room-address-lifecycle` placement was revised after two original-attempt hosted runs ended in unchanged prerequisites before this batch could start; running the new batch first preserves independent evidence without changing any retained suite.

- [x] **Step 2: Verify registration RED**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs room-access-policy-migration.spec.mjs`

- [x] **Step 3: Add target, script, registry, and hosted wiring**

Use a 35-minute Node timeout and 40-minute hosted wrapper, with the same prebuilt-bundle verification as neighboring Room suites. Do not change accepted suite budgets or composition.

- [x] **Step 4: Document exact parity and boundaries**

Add a #716 section to `e2e/android/MIGRATION.md` with pinned hashes/spans, 23+6 mapping, native/CDP/REST boundaries, command, artifact path, shard placement, deliberate controls, local stability gate, predecessor gate, and hosted acceptance gate.

- [x] **Step 5: Re-run focused registration tests green**

### Task 5: Static gates, deliberate controls, runtime stability, and publication

- [x] **Step 1: Run focused and full script tests**

Run focused Task 2/4 commands, then `pnpm nx test scripts --skipNxCache`.

- [x] **Step 2: Run static Nx and diff gates**

Run Android and browser typecheck/lint, `pnpm format:check`, docs-site checks, `git diff --check`, inspect the task-owned diff, and confirm all three pinned sources retain exact hashes.

- [x] **Step 3: Run at least five effective deliberate negative controls**

Temporarily mutate and restore one direct identity, one helper identity, version-9 forwarding, one native action into a DOM action, and one exact allow-list/read-only assertion into a weaker check. Each mutation must fail its intended guard; the restored focused contract must pass.

- [x] **Step 4: Run three unchanged native first attempts sequentially**

Run `pnpm nx run trinity-e2e-android:room-access-policy --skipNxCache` three times without source/build/input changes. For each require four passed stages, 29 unique identities with expected stage-local records, one suite attempt, zero retries, only completed native commands, exact UI/server outcomes, desktop renderer/APK/profile provenance, redaction, and clean teardown.

- [x] **Step 5: Run all four exact unchanged Playwright predecessors**

Run each exact title from the pinned definition sequentially with `--workers=1 --retries=0`. Require first-attempt passes and clean Synapse teardown.

- [x] **Step 6: Review, publish, and audit hosted evidence**

Require no unresolved review findings. Commit/push `test/716-android-room-access-policy`, cherry-pick the verified commit onto `test/676-android-sidebar-filter`, re-run composed-tree gates, push, and audit the original-attempt hosted Android/browser/renderer artifacts before closing #716 and updating #660, #653, and PR #677. Never merge PR #677.
