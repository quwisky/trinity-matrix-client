# Android Room Tombstone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-stage installed-Android Maestro/Node replacement for every assertion in the canonical Room-tombstone Playwright definition while keeping its predecessor enabled.

**Architecture:** The suite reuses the invocation-owned Android device, `AccountWorkspaceClient`, Matrix fixtures, and read-only WebView observation boundary. A source-pinned contract test owns the six assertion identities and product-input restrictions; one journey module owns old/successor Room setup, the tombstone state event, native interaction, layout observation, diagnostics, cleanup, and redaction.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Playwright Android WebView/CDP observation, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

**Spec:** GitHub issue [#707](https://github.com/quwisky/trinity-matrix-client/issues/707), pinned to consolidated base `f46e2751da6bfa3ff784f253da1360491e28e53d` and source SHA-256 `ca5563f9d5a4f84db23d7fb7a889da28682fffabf3dedd3b42b2f529d936472b`.

## Global Constraints

- Preserve the Playwright definition at lines 28–113 and its helper assertion at lines 15–23; do not retire, skip, weaken, or retry it.
- Drive login, Rooms-rail selection, old-Room selection, and successor activation through measured native Maestro input on the exact Pixel 5 profile.
- Restrict CDP to read-only observation and coordinate measurement; it must not click, focus, fill, dispatch product events, submit forms, mutate application state/styles, or navigate.
- Seed the Account, distinctly named old/successor Rooms, and `m.room.tombstone` event through finite Matrix fixtures.
- Keep renderer/APK verification, run-scoped diagnostics, device/WebView/Matrix cleanup, and secret redaction on every exit.
- Initialize `journeys.json` before device startup or APK installation.
- Run Synapse-backed suites sequentially because they share fixed ports.
- Place the hosted suite on Android shard 2 after `space-leave` and before retained Playwright.
- Keep screenshots, APKs, reports, and deliberate-control output under ignored `dist/` paths.

---

### Task 1: Pin the source and six replacement identities

**Files:**

- Create: `scripts/room-tombstone-migration.spec.mjs`
- Create: `e2e/android/room-tombstone-contract.mts`

**Interfaces:**

- Consumes: `tombstone.spec.mts` lines 15–23 and 28–113.
- Produces: `roomTombstoneAssertions`, `ROOM_TOMBSTONE_SOURCE`, native-boundary source guards, and an exact six-identity invariant.

- [x] **Step 1: Write the failing source-shape and contract test**

Pin the source SHA-256, exact definition title, helper/definition spans, six literal assertion identities, required native calls, tombstone fixture, layout reads, and absence of product `.click()`, `.focus()`, `dispatchEvent`, form submission, history, location, or application-state mutation in the replacement journey.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- room-tombstone-migration.spec.mjs`

Expected: FAIL because the contract and journey modules do not exist.

- [x] **Step 3: Add the minimal contract module**

Define the pinned source and these identities exactly once: `old.composer-visible`, `old.banner-visible`, `layout.banner-above-chat-row`, `layout.timeline-share`, `successor.banner-hidden`, and `successor.composer-visible`.

- [x] **Step 4: Re-run the focused contract**

Run: `pnpm nx test scripts -- room-tombstone-migration.spec.mjs`

Expected: remain red only for the missing journey implementation and tombstone fixture support.

### Task 2: Implement the one-stage native journey and lifecycle

**Files:**

- Modify: `e2e/android/account-workspace-fixtures.mts`
- Create: `e2e/android/room-tombstone-journeys.mts`

**Interfaces:**

- Consumes: `AccountWorkspaceClient`, `PIXEL_5_ACCOUNT_PROFILE`, `createAccountFixtures`, `evaluateNative`, and the Task 1 assertion contract.
- Produces: one `room-tombstone` stage with six assertion records and `journeys.json` lifecycle evidence.

- [x] **Step 1: Add the narrow tombstone fixture capability**

Permit `m.room.tombstone` in the existing typed room-state fixture and use its bounded authenticated PUT without exposing the access token.

- [x] **Step 2: Seed and open the exact old Room natively**

Create one fresh Account and two distinctly named private Rooms, set the exact tombstone body and successor ID, log in, open the Rooms rail and old Room through native input, then record visible composer and banner assertions.

- [x] **Step 3: Record the two layout contracts read-only**

Read `banner.closest('.chat-body')` and the message-list/chat-row width ratio through a validated CDP observation. Record `insideChatBody === false` and `timelineShare > 0.5` without mutating the document.

- [x] **Step 4: Navigate to the successor natively**

Tap `tombstone-go` through a fresh measured native point, then record that the banner is absent and the composer remains visible.

- [x] **Step 5: Add invocation-owned lifecycle evidence**

Write empty lifecycle evidence before opening the device, install the verified APK, reset to the Pixel 5 profile, write running/passed/failed stage transitions, capture pass/failure diagnostics, redact secrets, and close WebView/device/Matrix resources on every exit. Assert one stage and six identities.

- [x] **Step 6: Run the migration contract and Android typecheck green**

Run: `pnpm nx test scripts -- room-tombstone-migration.spec.mjs`

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

- Produces: runnable `android.room-tombstone`, Nx target `trinity-e2e-android:room-tombstone`, package command `e2e:android:room-tombstone`, shard-2 started diagnostics, and durable parity mapping.

- [x] **Step 1: Write failing registry and workflow assertions**

Require the new host-budget suite, exact entrypoint/target/script, updated upload count, one `android-room-tombstone` started-only upload, and ordering after `space-leave` on shard 2 but before `pnpm e2e:android --`.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs`

Expected: FAIL because the suite, target, command, workflow step, and upload are absent.

- [x] **Step 3: Add the registry, target, package command, and CI wiring**

Use cache false, parallelism false, Android build dependency, `android-avd`/`synapse` serialization, host timeout, and the single journey entrypoint. Run shard 2 after `space-leave`; emit a started flag and upload only when started.

- [x] **Step 4: Document exact parity and provisional bounds**

Add a `Room tombstone batch` section with #707, pinned base/hash/spans, six identities, native/CDP boundary, command, artifact path, shard placement, and acceptance gates.

- [x] **Step 5: Re-run focused registry/workflow tests green**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs room-tombstone-migration.spec.mjs`

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

Cover a wrong source hash or omitted identity, false old-Room/banner readiness, false banner placement or timeline width, and false successor banner/composer state. Every control must fail at its intended assertion, then the restored owned check must pass.

### Task 5: Native stability, predecessor, review, and publication

**Files:**

- Modify only if validation or review exposes an owned defect.
- Keep generated evidence under ignored `dist/.playwright/` and `dist/maestro-private/` paths.

- [x] **Step 1: Run three complete unchanged-input native first attempts sequentially**

Run: `pnpm nx run trinity-e2e-android:room-tombstone --skipNxCache`

Expected for each accepted run: one passed stage, six assertion records, one attempt, zero retries, completed native commands, exact profile/renderer/APK receipts, and clean teardown.

- [x] **Step 2: Run the unchanged Playwright predecessor**

Run: `pnpm nx run trinity-e2e-browser:e2e -- e2e/browser/journeys/room-administration/tombstone.spec.mts --grep "shows the upgrade banner" --workers=1 --retries=0`

Expected: one pass on its first attempt with clean Synapse teardown.

- [x] **Step 3: Run final diff/worktree checks and request independent review**

Run: `git diff --check`

Run: `git status --short`

Review the complete working-tree artifact against `f46e2751`, including untracked files. Address findings through focused red/green cycles and re-run affected gates.

- [ ] **Step 4: Commit and push only after fresh verification**

Stage only #707-owned files, inspect `git diff --cached`, commit as `test(e2e): migrate Android Room tombstone`, push `test/707-android-room-tombstone`, cherry-pick onto `test/676-android-sidebar-filter`, verify again, and push the consolidated branch. Do not merge PR #677.

- [ ] **Step 5: Audit hosted shard 2 before closing #707**

Require original-attempt green browser and Android shard-2 jobs. Download the immutable suite artifact and audit one stage, six identities, layout/successor evidence, native commands, renderer/APK/profile provenance, secret redaction, and teardown before updating #707, #660, #653, and PR #677.
