# Android Member Details and Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-stage installed-Android Maestro/Node replacement for every assertion in the canonical member-info and member-promotion Playwright definitions while keeping both predecessors enabled.

**Architecture:** Reuse the invocation-owned Android device, `AccountWorkspaceClient`, finite Matrix account/Room fixtures, and the established read-only WebView observation boundary. The member-info stage proves roster geometry, identity/actions, surface layout, the real Android clipboard, and close recovery. The promotion stage performs the role change natively and proves both UI regrouping and exact Matrix power level 50. A source-pinned contract owns 25 stable identities.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Playwright Android WebView/CDP observation, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

**Spec:** GitHub issue [#710](https://github.com/quwisky/trinity-matrix-client/issues/710), pinned to consolidated base `02de1669419235fdeff4b0614f00ee1e5b2af862`. Prerequisite #709 is closed with audited hosted acceptance.

## Global constraints

- Preserve both Playwright definitions and their shared helper assertions. Do not retire, skip, weaken, or retry them.
- Drive login, Rooms/Room selection, compact overflow/Members navigation, member-row selection, Copy user ID, panel close, role selection, confirmation, composer focus, and clipboard paste through measured native Maestro input on the exact Pixel 5 profile.
- Restrict CDP to read-only observation and coordinate measurement. It must not click, focus, fill, dispatch product events, submit forms, mutate application state/styles, inject a clipboard probe, or navigate.
- Seed accounts, display names, unencrypted Rooms, invites, and joins through finite Matrix fixtures without exposing access tokens.
- Prove the exact roster geometry, member identity/role/Message action, opaque full-height surface, copy-success toast, pasted MXID, close/roster recovery, Moderator regrouping, and server power level 50.
- Initialize `journeys.json` before device startup or APK installation.
- Preserve renderer/APK verification, run-scoped diagnostics, device/WebView/Matrix cleanup, and secret redaction on every exit.
- Run Synapse-backed suites sequentially and keep generated proof under ignored `dist/` paths.
- Add one started-only hosted artifact surface before retained Playwright.

---

### Task 1: Pin both sources and 25 replacement identities

**Files:**

- Create: `scripts/member-details-promotion-migration.spec.mjs`
- Create: `e2e/android/member-details-promotion-contract.mts`

**Interfaces:**

- Consumes: member-info Room helper lines 49–57, Members helper lines 59–68, and definition lines 73–218, SHA-256 `cca86e8d3c5925ff2358e6efbcf229ca4f32095379385d9539698dedd1c2200d`.
- Consumes: promotion helper lines 49–57 and definition lines 62–134, SHA-256 `649c05090a92bf48036530ea3738c55ad40f0ebc06a0200745e48b3b6903f7c3`.
- Produces: exact source metadata, 18 member-info identities, seven promotion identities, and native/CDP boundary guards.

- [x] **Step 1: Write the failing source-shape and contract test**

Pin both hashes, titles, spans, all 25 assertion sites, and two mandatory stages. Require exact fixture setup, compact mobile navigation, native copy/paste/close/promotion actions, geometry/style/result reads, lifecycle ordering, cleanup, and redaction. Reject product `.click()`, `.focus()`, `dispatchEvent`, form submission, navigation, DOM injection, or application-state/style mutation in the journey.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- member-details-promotion-migration.spec.mjs`

Expected: FAIL because the contract and journey modules do not exist.

- [x] **Step 3: Add the minimal contract module**

Define exactly 18 `member-info.*` identities and seven `promotion.*` identities, each mapped to its source assertion.

- [x] **Step 4: Re-run the focused contract**

Expected: remain red only for the missing journey and registration.

### Task 2: Implement member-info and promotion stages

**Files:**

- Create: `e2e/android/member-details-promotion-journeys.mts`
- Create: `e2e/android/flows/accounts-focused-paste.yaml`
- Modify: `e2e/android/account-workspace-client.mts`

**Interfaces:**

- A shared helper opens the exact Room and compact Members drawer through `room-actions-overflow` and `overflow-toggle-members`, recording the stage-specific timeline/hidden/visible identities.
- A shared fixture helper creates the admin/member pair, sets the target display name, creates an invited private Room, and joins the lower-power member.
- Member-info observes exact row/header dimensions, panel content and surface layout; Copy is tapped natively, the existing composer is focused natively, and a Maestro `pasteText` flow proves the clipboard value without overwriting it.
- Promotion observes no Moderator group, opens member info, selects role 50 and confirms natively, then observes the Moderator group/row and polls `m.room.power_levels` for the exact user value.

- [x] **Step 1: Implement shared fixture and compact Members navigation**

Use the Pixel 5 profile and exact target display name. Keep UI reads narrowly allowlisted and record the corresponding source assertion identity at each observation.

- [x] **Step 2: Add native clipboard paste support and member-info stage**

Add a focused-input Maestro flow containing only `pasteText` and keyboard dismissal. Click the product Copy action first, close member info, focus the existing composer through measured native input, paste without a preceding `setClipboard`, and observe the exact MXID. Record the 44 px row, 34 px header, visible panel/name/handle/role/Message action, opaque flex full-height surface, exact toast, hidden panel, and restored roster.

- [x] **Step 3: Implement promotion**

Observe the absent Moderator section, open member info natively, activate `member-info-role-50`, confirm, observe the Moderator section and exact member row, and read `m.room.power_levels` until the target user is exactly 50.

- [x] **Step 4: Add invocation-owned lifecycle evidence**

Write empty lifecycle evidence before opening the device, install the verified APK, reset each stage to Pixel 5, capture pass/failure diagnostics, redact secrets, and close WebView/device/Matrix resources on every exit. Assert two stages and 25 identities.

- [x] **Step 5: Run focused contract and Android typecheck green**

Run: `pnpm nx test scripts -- member-details-promotion-migration.spec.mjs`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

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

- [x] **Step 1: Write failing registry and workflow assertions**

Require suite `android.member-details-promotion`, its target/script/entrypoint, serialized resources, host budget, shard-2 order after Room tombstone, started flag, artifact surface, and upload-count changes.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs`

- [x] **Step 3: Add registry, target, package command, and CI wiring**

Use cache false, parallelism false, Android build dependency, `android-avd`/`synapse` serialization, one journey entrypoint, and one started-only shard-2 artifact upload after Room tombstone and before retained Playwright. Shard 2 is selected from current hosted timing evidence because it retains more execution headroom than shard 3; shard 3 already carries the member-moderation batch and is consuming a substantial share of its 180-minute ceiling.

- [x] **Step 4: Document exact parity and provisional bounds**

Add a `Member details and promotion batch` section with #710, pinned sources/hashes/spans, 25 identities, native clipboard and CDP boundaries, command, artifact path, shard placement, and acceptance gates.

- [x] **Step 5: Re-run focused registry/workflow tests green**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs member-details-promotion-migration.spec.mjs`

### Task 4: Static gates and deliberate red/green controls

- [x] **Step 1: Run the complete affected static gate set**

Run: `pnpm nx test scripts`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

Run: `pnpm nx run trinity-e2e-android:lint --skipNxCache`

Run: `pnpm nx run trinity-e2e:typecheck --skipNxCache`

Run: `pnpm nx run trinity-e2e:lint --skipNxCache`

Run: `pnpm format:check`

- [x] **Step 2: Run at least five effective controls and revert each mutation**

Cover a wrong source hash/omitted identity, false compact-navigation readiness, false geometry/style result, a clipboard flow that overwrites rather than consumes the current clipboard, and false final power level. Every control must fail at its intended assertion and the restored check must pass.

### Task 5: Native stability, predecessors, review, and publication

- [x] **Step 1: Run three complete unchanged-input native first attempts sequentially**

Run: `pnpm nx run trinity-e2e-android:member-details-promotion --skipNxCache`

Require two passed stages, 25 assertion records, one suite attempt, zero retries, completed native commands, exact profile/renderer/APK receipts, and clean teardown each time.

- [x] **Step 2: Run both unchanged Playwright predecessors sequentially**

Run each pinned file with `--workers=1 --retries=0`. Require both first-attempt passes and clean teardown.

- [x] **Step 3: Run final diff/worktree checks and independent review**

Run `git diff --check`, inspect the complete worktree against `02de1669`, and address findings through focused red/green cycles.

- [ ] **Step 4: Commit and push after fresh verification**

Stage only #710-owned files, inspect the cached diff, commit `test(e2e): migrate Android member details and promotion`, push `test/710-android-member-details-promotion`, cherry-pick onto `test/676-android-sidebar-filter`, verify, and push. Do not merge PR #677.

- [ ] **Step 5: Audit hosted evidence before closing #710**

Require original-attempt green Android shard evidence and exact hosted predecessor passes at retry 0. Audit the immutable suite artifact for two stages, 25 identities, native clipboard/promotion proof, exact power level, renderer/APK/profile provenance, secret redaction, and teardown. Track unrelated job-level reliability separately on #665, then update #710, #660, #653, and PR #677.
