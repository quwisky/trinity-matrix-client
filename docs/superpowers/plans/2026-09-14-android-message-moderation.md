# Android Message Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-stage installed-Android Maestro/Node replacement for every direct assertion in the canonical message-reporting and moderator-redaction Playwright definitions while keeping both predecessors enabled.

**Architecture:** Reuse the invocation-owned Android device, `AccountWorkspaceClient`, Matrix account/room fixtures, and read-only WebView observation boundary. Add one narrowly measured 750 ms near-static Maestro swipe for message-row long presses, with trusted pointer down/terminal duration proof. A source-pinned contract owns five stable assertion identities; one journey module owns fixture setup, native actions, result observation, diagnostics, cleanup, and redaction.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Playwright Android WebView/CDP observation, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

**Spec:** GitHub issue [#708](https://github.com/quwisky/trinity-matrix-client/issues/708), pinned to consolidated base `b667802795d7cd7fd19cc99292ee1d8e30eaf4e1`.

## Global constraints

- Preserve both Playwright definitions and their `openRoom` helper assertions; do not retire, skip, weaken, or retry them.
- Drive login, Rooms selection, Room selection, message-row long press, sheet action selection, and confirmation through measured native Maestro input on the exact Pixel 5 profile.
- Restrict CDP to read-only observation and coordinate measurement. It must not click, focus, fill, dispatch product events, submit forms, mutate application state/styles, or navigate.
- Seed accounts, unencrypted Rooms, membership, and source messages through finite Matrix fixtures without exposing access tokens.
- Initialize `journeys.json` before device startup or APK installation.
- Preserve renderer/APK verification, run-scoped diagnostics, device/WebView/Matrix cleanup, and secret redaction on every exit.
- Run Synapse-backed suites sequentially and keep generated proof under ignored `dist/` paths.
- Add one started-only hosted artifact surface and keep retained Playwright after the native replacement.

---

### Task 1: Pin both sources and five replacement identities

**Files:**

- Create: `scripts/message-moderation-migration.spec.mjs`
- Create: `e2e/android/message-moderation-contract.mts`

**Interfaces:**

- Consumes: report source/helper spans 19–25 and 30–80, SHA-256 `3f8e9051936b66e5b6ab1112d52f29f95826866bc4277e7ba6d5bdd9ca312b7c`.
- Consumes: redaction source/helper spans 57–63 and 68–143, SHA-256 `b7bb891ccdde3bb829044b6378247971555be539a6a8cd190f7ace323fa78b57`.
- Produces: source metadata, five assertion identities, and native/CDP boundary guards.

- [x] **Step 1: Write the failing source-shape and contract test**

Pin both hashes, titles, spans, assertion count and literal identities. Require two cases, exact fixture setup, native long press/action/confirmation, result reads, lifecycle ordering, cleanup, and redaction. Reject product `.click()`, `.focus()`, `dispatchEvent`, form submission, navigation, or application-state mutation in the journey.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- message-moderation-migration.spec.mjs`

Expected: FAIL because the contract, journey, and native long-press flow do not exist.

- [x] **Step 3: Add the minimal contract module**

Define exactly: `report.timeline-visible`, `report.success-toast-visible`, `redact.timeline-visible`, `redact.deleted-marker-visible`, and `redact.original-body-absent`.

- [x] **Step 4: Re-run the focused contract**

Expected: remain red only for missing journey/long-press implementation and registration.

### Task 2: Add measured native long press and two stages

**Files:**

- Modify: `e2e/android/account-workspace-client.mts`
- Create: `e2e/android/message-moderation-journeys.mts`

**Interfaces:**

- `AccountWorkspaceClient.longPressCurrent(selector, filter)` resolves a fresh measured point, materializes a run-scoped Maestro swipe with a 750 ms duration and two-native-pixel horizontal drift, and records trusted pointer down/terminal duration proof.
- The reporting stage creates one user/Room/message, opens the message action sheet natively, selects Report, confirms, and observes the success toast.
- The redaction stage creates admin/member accounts, an invited/joined unencrypted Room and member message, then natively deletes it and observes replacement/removal state.

- [x] **Step 1: Implement the minimal current-point long-press primitive**

Materialize literal measured coordinates in the ignored proof directory because Maestro parses swipe coordinates before variable expansion. Require trusted matching `pointerdown`, a same-pointer terminal event (`pointerup`, or `pointercancel` if the opened sheet replaces the touched surface), and at least 500 ms observed duration. The two-native-pixel horizontal drift stays well below the app's 10 CSS-pixel cancellation slop while avoiding Android's unstable zero-distance injection path. Do not broaden CDP mutation authority; keep tap behavior unchanged.

- [x] **Step 2: Implement the reporting stage**

Seed the source message, log in and open the Room natively, record timeline visibility, long-press the exact row, select `sheet-report`, confirm `alert-confirm`, and record the exact success toast.

- [x] **Step 3: Implement the moderator-redaction stage**

Create admin/member accounts, invite/join, post as member, log in as admin, record timeline visibility, long-press the member row, select `sheet-delete`, confirm, then record the deleted marker and original-body absence.

- [x] **Step 4: Add invocation-owned lifecycle evidence**

Write empty lifecycle evidence before opening the device, install the verified APK, reset each stage to Pixel 5, capture pass/failure diagnostics, redact secrets, and close WebView/device/Matrix resources on every exit. Assert two stages and five identities.

- [x] **Step 5: Run focused contract and Android typecheck green**

Run: `pnpm nx test scripts -- message-moderation-migration.spec.mjs`

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

Require suite `android.message-moderation`, its target/script/entrypoint, serialized resources, host budget, CI order, started flag, artifact surface, and upload-count changes.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs`

- [x] **Step 3: Add registry, target, package command, and CI wiring**

Use cache false, parallelism false, Android build dependency, `android-avd`/`synapse` serialization, one journey entrypoint, and one started-only artifact upload before retained Playwright.

- [x] **Step 4: Document exact parity and provisional bounds**

Add a `Message moderation batch` section with #708, pinned sources/hashes/spans, five identities, native/CDP boundary, command, artifact path, shard placement, and acceptance gates.

- [x] **Step 5: Re-run focused registry/workflow tests green**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs message-moderation-migration.spec.mjs`

### Task 4: Static gates and deliberate red/green controls

- [x] **Step 1: Run the complete affected static gate set**

Run: `pnpm nx test scripts`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

Run: `pnpm nx run trinity-e2e-android:lint --skipNxCache`

Run: `pnpm nx run trinity-e2e:typecheck --skipNxCache`

Run: `pnpm nx run trinity-e2e:lint --skipNxCache`

Run: `pnpm format:check`

- [x] **Step 2: Run at least four effective controls and revert each mutation**

Cover a wrong source hash/omitted identity, false reporting readiness/result, false redaction readiness/action, and false deleted/original-body result. Every control must fail at its intended assertion and the restored check must pass.

### Task 5: Native stability, predecessors, review, and publication

- [x] **Step 1: Run three complete unchanged-input native first attempts sequentially**

Run: `pnpm nx run trinity-e2e-android:message-moderation --skipNxCache`

Require two passed stages, five assertion records, one suite attempt, zero retries, completed native commands, exact profile/renderer/APK receipts, and clean teardown each time.

- [x] **Step 2: Run both unchanged Playwright predecessors sequentially**

Run each pinned file with `--workers=1 --retries=0` and a title grep. Require one first-attempt pass and clean teardown per command.

- [x] **Step 3: Run final diff/worktree checks and independent review**

Run `git diff --check`, inspect the complete worktree against `b6678027`, and address findings through focused red/green cycles.

- [x] **Step 4: Commit and push after fresh verification**

Stage only #708-owned files, inspect the cached diff, commit `test(e2e): migrate Android message moderation`, push `test/708-android-message-moderation`, cherry-pick onto `test/676-android-sidebar-filter`, verify, and push. Do not merge PR #677.

- [x] **Step 5: Audit hosted evidence before closing #708**

Require original-attempt green Android shard evidence and exact hosted predecessor passes at retry 0. Audit the immutable suite artifact for two stages, five identities, native long-press/action proof, renderer/APK/profile provenance, secret redaction, and teardown. Track unrelated job-level reliability separately on #665, then update #708, #660, #653, and PR #677.
