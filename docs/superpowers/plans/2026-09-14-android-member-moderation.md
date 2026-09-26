# Android Member Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a three-stage installed-Android Maestro/Node replacement for every Android-applicable assertion in the canonical member Block, Kick, and Ban Playwright definitions while keeping all predecessors enabled.

**Architecture:** Reuse the invocation-owned Android device, `AccountWorkspaceClient`, finite Matrix account/Room fixtures, and the existing read-only WebView observation boundary. Each Pixel 5 stage opens the compact Members drawer through the native overflow menu, selects the exact member row, performs its Block/Kick/Ban action and confirmation natively, and records the owned UI plus server result. A source-pinned contract owns 22 stable identities and preserves the production-APK exclusion for the stale-roster fault.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Playwright Android WebView/CDP observation, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

**Spec:** GitHub issue [#709](https://github.com/quwisky/trinity-matrix-client/issues/709), pinned to consolidated base `1610f3ca0872e8144be657b63d0e183b0a1284b0`.

## Global constraints

- Preserve the Block and Kick/Ban Playwright definitions, their `openRoom` helper assertions, and the stale-roster browser definition. Do not retire, skip, weaken, or retry them.
- Drive login, Rooms selection, Room selection, compact overflow/Members navigation, member-row selection, Block/Kick/Ban activation, confirmation, and panel/list recovery through measured native Maestro input on the exact Pixel 5 profile.
- Restrict CDP to read-only observation and coordinate measurement. It must not click, focus, fill, dispatch product events, submit forms, mutate application state/styles, or navigate.
- Seed accounts, display names, unencrypted Rooms, invites, and joins through finite Matrix fixtures without exposing access tokens.
- Prove Block changes to Unblock after its account-data round trip. Prove Kick/Ban close member info, restore the visible roster, remove the target row, and produce exact `leave`/`ban` server membership.
- Initialize `journeys.json` before device startup or APK installation.
- Preserve renderer/APK verification, run-scoped diagnostics, device/WebView/Matrix cleanup, and secret redaction on every exit.
- Run Synapse-backed suites sequentially and keep generated proof under ignored `dist/` paths.
- Add one started-only hosted artifact surface before retained Playwright. Keep the Angular-hook stale-roster fault explicitly browser-owned because the installed production APK cannot run it.

---

### Task 1: Pin both sources and 22 replacement identities

**Files:**

- Create: `scripts/member-moderation-migration.spec.mjs`
- Create: `e2e/android/member-moderation-contract.mts`

**Interfaces:**

- Consumes: Block helper/definition spans 47–55 and 60–123, SHA-256 `792a6e1d021c5e09661c5847e4fb577044cab1635673151cefd026cf57acfa84`.
- Consumes: Kick/Ban helper/generator/definition spans 68–76, 81–94, and 95–165, SHA-256 `e7ab22e420abf9f545c7ad1bb9b637b435cbc9a754759167070ebb38550d2a86`.
- Excludes but preserves: stale-roster fault at 168–291, guarded by the existing production-APK Android skip.
- Produces: exact source metadata, 22 assertion identities, the `kick | ban` domain, and native/CDP boundary guards.

- [x] **Step 1: Write the failing source-shape and contract test**

Pin both hashes, titles, spans, six Block assertions, eight Kick assertions, eight Ban assertions, the generated domain, and the stale-roster exclusion. Require three stages, exact fixture setup, compact mobile navigation, native actions/confirmations, result reads, lifecycle ordering, cleanup, and redaction. Reject product `.click()`, `.focus()`, `dispatchEvent`, form submission, navigation, or application-state mutation in the journey.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- member-moderation-migration.spec.mjs`

Expected: FAIL because the contract and journey modules do not exist.

- [x] **Step 3: Add the minimal contract module**

Define exactly six `block.*` identities plus the same eight `room-timeline-visible`, `members-initially-hidden`, `members-panel-visible`, `member-info-visible`, `member-info-closed`, `roster-visible`, `member-row-absent`, and `server-membership` identities for both `kick.*` and `ban.*`.

- [x] **Step 4: Re-run the focused contract**

Expected: remain red only for the missing journey and registration.

### Task 2: Implement Block, Kick, and Ban stages

**Files:**

- Create: `e2e/android/member-moderation-journeys.mts`

**Interfaces:**

- A shared helper opens the exact Room and compact Members drawer through `room-actions-overflow` and `overflow-toggle-members`, recording the stage-specific timeline/hidden/visible identities.
- A shared fixture helper creates the admin/member pair, sets the target display name, creates an invited private Room, and joins the lower-power member.
- Block records the exact member-info surface and Block text, taps natively, then observes Unblock after the account-data round trip.
- Generated Kick/Ban stages tap the action and confirmation natively, then record member-info removal, roster visibility, target-row absence, and exact Matrix membership.

- [x] **Step 1: Implement shared fixture and compact Members navigation**

Use the Pixel 5 profile and exact target display name. Keep UI reads narrowly allowlisted and record the corresponding source assertion identity at each observation.

- [x] **Step 2: Implement Block**

Open member info natively, record exact Block text, activate it through `tapCurrent`, and wait for exact Unblock text.

- [x] **Step 3: Implement generated Kick and Ban**

Use an explicit `kick | ban` descriptor table, scroll the exact action into the member-info panel if needed, activate and confirm natively, then observe closed member info, restored roster, removed target row, and poll finite Matrix fixtures for exact `leave`/`ban`.

- [x] **Step 4: Add invocation-owned lifecycle evidence**

Write empty lifecycle evidence before opening the device, install the verified APK, reset each stage to Pixel 5, capture pass/failure diagnostics, redact secrets, and close WebView/device/Matrix resources on every exit. Assert three stages and 22 identities.

- [x] **Step 5: Run focused contract and Android typecheck green**

Run: `pnpm nx test scripts -- member-moderation-migration.spec.mjs`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

- [x] **Step 6: Make fixture cleanup idempotent after Kick/Ban**

Add a focused fixture test proving cleanup tolerates only a 403 from the
best-effort Room `leave` action, while still forgetting the Room, logging out
all accounts, and aggregating every other failure. Then re-run the full native
journey with clean teardown.

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

Require suite `android.member-moderation`, its target/script/entrypoint, serialized resources, host budget, shard order after message moderation, started flag, artifact surface, and upload-count changes.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs`

- [x] **Step 3: Add registry, target, package command, and CI wiring**

Use cache false, parallelism false, Android build dependency, `android-avd`/`synapse` serialization, one journey entrypoint, and one started-only shard-3 artifact upload before retained Playwright.

- [x] **Step 4: Document exact parity and provisional bounds**

Add a `Member moderation batch` section with #709, pinned sources/hashes/spans, 22 identities, stale-roster exclusion, native/CDP boundary, command, artifact path, shard placement, and acceptance gates.

- [x] **Step 5: Re-run focused registry/workflow tests green**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs member-moderation-migration.spec.mjs`

### Task 4: Static gates and deliberate red/green controls

- [x] **Step 1: Run the complete affected static gate set**

Run: `pnpm nx test scripts`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

Run: `pnpm nx run trinity-e2e-android:lint --skipNxCache`

Run: `pnpm nx run trinity-e2e:typecheck --skipNxCache`

Run: `pnpm nx run trinity-e2e:lint --skipNxCache`

Run: `pnpm format:check`

- [x] **Step 2: Run at least five effective controls and revert each mutation**

Cover a wrong source hash/omitted identity, false compact-navigation readiness, false Block text/result, false Kick/Ban recovery, and false server membership. Every control must fail at its intended assertion and the restored check must pass.

### Task 5: Native stability, predecessors, review, and publication

- [x] **Step 1: Run three complete unchanged-input native first attempts sequentially**

Run: `pnpm nx run trinity-e2e-android:member-moderation --skipNxCache`

Require three passed stages, 22 assertion records, one suite attempt, zero retries, completed native commands, exact profile/renderer/APK receipts, and clean teardown each time.

- [x] **Step 2: Run all three unchanged Playwright predecessors sequentially**

Run the pinned Block file once and the generated Kick/Ban definitions with title greps, each with `--workers=1 --retries=0`. Require three first-attempt passes and clean teardown.

- [x] **Step 3: Run final diff/worktree checks and independent review**

Run `git diff --check`, inspect the complete worktree against `1610f3ca`, and address findings through focused red/green cycles.

- [x] **Step 4: Commit and push after fresh verification**

Stage only #709-owned files, inspect the cached diff, commit `test(e2e): migrate Android member moderation`, push `test/709-android-member-moderation`, cherry-pick onto `test/676-android-sidebar-filter`, verify, and push. Do not merge PR #677.

- [x] **Step 5: Audit hosted evidence before closing #709**

Require original-attempt green Android shard evidence and exact hosted predecessor passes at retry 0. Audit the immutable suite artifact for three stages, 22 identities, native action proof, exact server memberships, renderer/APK/profile provenance, secret redaction, and teardown. Track unrelated job-level reliability separately on #665, then update #709, #660, #653, and PR #677.

Completed on hosted run `34867886690` at source head `6fd03a32` (hosted merge `5d022ff3`). Android shard 3 passed on attempt 1. Immutable artifact `10362633783` records one suite attempt, zero retries, three passed stages, all 22 identities, 172/172 completed Maestro commands, native Block/Kick/Ban and confirmation actions, exact `leave`/`ban` server memberships, the verified renderer and installed package, the Pixel 5 viewport, no bearer/password findings, and complete Synapse teardown. Browser artifact `10358997011` records all three exact predecessors and the browser-owned stale-roster case passed at retry 0. The run's unrelated documentation/unit CodeMirror audit mismatch is tracked and fixed under #665.
