# Android Room profile settings migration implementation plan

> Issue: [#717](https://github.com/quwisky/trinity-matrix-client/issues/717)

**Goal:** Replace all four canonical Room profile/settings Playwright definitions with faithful installed-Android Node/Maestro journeys while retaining every predecessor.

**Architecture:** Add one source-pinned parity contract and one four-stage `AccountWorkspaceClient` suite. Reuse the accepted Android document-picker, Matrix room-state failure/delay controllers, visual fixture, finite Matrix fixtures and one-attempt diagnostic harness. Keep every reachable product interaction native; isolate the predecessor-required pointer-blocked Account transition in one Room-specific helper containing exactly the two source-pinned CDP clicks.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10, Android WebView/CDP observation, Android DocumentsUI, Matrix client-server API, Vitest source-shape tests, Nx and GitHub Actions.

## Global constraints

- Base all work on accepted consolidated head `292aea6ac996cfcf3993b76f397fd1f22e90230c`.
- Preserve `e2e/browser/journeys/room-administration/room-profile-settings.spec.mts` byte-for-byte at SHA-256 `f6ab33a1fc7160efb206c66f064ab158cea1c3969ad6ee5a55b8eb39299d1f96`.
- Preserve `e2e/browser/support/room-settings-journey.mts` byte-for-byte at SHA-256 `bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`.
- Own the four definitions at lines 16–151, 153–197, 199–256 and 258–358, with 20 + 2 + 6 + 8 direct assertion sites and five stage-local `openRoom` obligations, for exactly 41 parity identities.
- Use `DESKTOP_ACCOUNT_PROFILE` for all stages. The compact 700×800 check and light/dark/125%-font fixtures must be bounded and restored in `finally`.
- REST may create and observe finite fixtures. CDP may observe, install exact transport controls, and temporarily change only the document root for source-pinned captures. Product clicks, focus, text, Back and file selection stay native except for the exact two-click blocked-modal Account transition at source lines 324–335.
- Keep all four Playwright predecessors enabled. Never merge PR #677.

### Task 1: Pin the contract and make parity fail first

**Files:**

- Create: `scripts/room-profile-settings-migration.spec.mjs`
- Create: `e2e/android/room-profile-settings-contract.mts`

- [x] **Step 1: Add source-shape and missing-replacement assertions**

Pin both source hashes, four definition boundaries, exactly 20/2/6/8 direct sites, five `openRoom` call sites, 36 direct identities and five helper identities. Require four desktop stages, native action APIs, the Android document picker, exact Matrix fault/delay targets, the Room-specific transition helper, diagnostics, registration and predecessor retention.

- [x] **Step 2: Run the focused test RED**

Run `pnpm nx test scripts --skipNxCache -- room-profile-settings-migration.spec.mjs` and require failure because the contract, journey and helper do not exist.

- [x] **Step 3: Add the minimal source/identity contract**

Export exact sources, stage-grouped direct/helper identity objects, the merged 41-identity map and its union type. Assert 36 direct, five helper, 41 total and 41 unique identities in-module.

- [x] **Step 4: Re-run the focused contract**

Require source and identity checks green while implementation/registration checks remain red.

### Task 2: Implement the four installed-Android stages

**Files:**

- Create: `e2e/android/room-profile-settings-journeys.mts`
- Create: `e2e/android/room-profile-settings-account-transition.mts`
- Reuse unchanged: `e2e/android/maestro-document-picker.mts`
- Reuse unchanged: `e2e/android/matrix-http-fault.mts`
- Reuse unchanged: `e2e/android/space-settings-visual-fixture.mts`

- [x] **Step 1: Add shared bounded observations and Room navigation**

Use finite polling that records the last value on failure. Implement native Rooms-rail/Room selection for each of the five `openRoom` obligations and native Room Settings opening without stealing initial heading focus.

- [x] **Step 2: Implement rename, responsive and discard parity**

Create prior/current Rooms, prove desktop geometry and opening identity/focus, resize to 700×800 and restore, prove 125%-font action layout, edit through native input, invoke native Android Back, retain edits through both discard dialogs, capture light/dark Amethyst, save, and prove exact new/old channel-list convergence.

- [x] **Step 3: Implement native Room-photo upload parity**

Write the canonical 1×1 PNG only inside ignored diagnostics, activate the exact Room avatar button/file-input pair with a trusted native tap, select the staged file through Android DocumentsUI, remove it on every exit, and record the exact success toast plus authoritative `m.room.avatar` MXC state under the single source identity.

- [x] **Step 4: Implement partial General failure/retry parity**

Install a bounded first-failure controller for the exact Room/topic state write with status 500 and exact payload. Fill name/topic natively, prove the first feedback and 1/1 name/topic attempt counts, retry through native Save, then prove `Topic saved`, name count 1, topic count 2 and exact final Room state. Always close interception before the WebView connection.

- [x] **Step 5: Implement opening-Account continuity parity**

Create owner/member accounts and one joined shared Room, add/switch to the opening owner natively, hold only the first exact Room-name write, prove `Saving`, then call the Room-specific source-pinned two-click helper to switch the active Account behind the blocking modal. Prove active member, retained opening Account, `Name saved`, subsequent `Topic saved` and exact server topic via the member observer.

- [x] **Step 6: Preserve diagnostics and teardown**

Install once, reset every stage to `DESKTOP_ACCOUNT_PROFILE`, record all 41 identities, native commands, renderer/APK/profile provenance and named pass/failure captures. Redact dynamically created passwords and close transport, WebView, device, staged document and Matrix resources on all exits. Assert exactly four stages.

### Task 3: Register the suite and hosted evidence

**Files:**

- Modify: `e2e/android/project.json`
- Modify: `package.json`
- Modify: `e2e/registry/commands.mts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Modify: `scripts/ci-workflow.spec.mjs`
- Modify: `e2e/android/MIGRATION.md`

- [x] **Step 1: Add failing registry/workflow assertions**

Require target/script/entrypoint, exact suite ID, cache disabled, one attempt, serial `android-avd` + `synapse`, a 35-minute Node bound and 40-minute wrapper, shard-3 placement immediately after `room-access-policy` and before `accounts-workspace`, started-only diagnostics, exact artifact path and upload-count increment.

- [x] **Step 2: Verify registration RED**

Run focused registry, workflow and migration tests and require only the absent wiring checks to fail.

- [x] **Step 3: Add target, script, registry and CI wiring**

Reuse the verified prebuilt renderer and existing Android shard. Do not weaken or reorder retained suites beyond inserting this dependency-successor immediately after #716.

- [x] **Step 4: Document exact parity and boundaries**

Add the #717 ledger section with source hashes/spans, the 36+5 identity table, native/CDP/REST boundaries, command, diagnostics, shard placement, controls and acceptance gates.

- [x] **Step 5: Re-run focused registration tests green**

### Task 4: Validate, publish and accept

- [x] **Step 1: Run focused and full script tests**

Run the focused migration/registry/workflow tests and `pnpm nx test scripts --skipNxCache`.

- [x] **Step 2: Run static Nx and documentation gates**

Run Android/browser typecheck and lint, formatting, documentation test/check/assemble/E2E, source hashes and `git diff --check`.

- [x] **Step 3: Run at least five effective deliberate controls**

Temporarily mutate and restore one direct identity, one inherited identity, document-picker ownership, fault specificity, blocked-modal helper breadth, and cleanup/redaction. Each mutation must fail its intended guard; restored checks must pass.

- [x] **Step 4: Run three unchanged native first attempts sequentially**

Run `pnpm nx run trinity-e2e-android:room-profile-settings --skipNxCache` three times without source/build/input changes. Require four passed stages, 41 unique identities, one attempt, zero retries, completed native commands, exact outcomes, provenance, redaction and teardown.

- [x] **Step 5: Run all four exact unchanged Playwright predecessors**

Run each title sequentially with `--workers=1 --retries=0`; require retry-zero passes and clean Synapse teardown.

- [ ] **Step 6: Review, publish and audit hosted evidence**

Require no unresolved review findings. Commit and push `test/717-android-room-profile-settings`, cherry-pick the verified commit onto `test/676-android-sidebar-filter`, re-run composed-tree gates, push, and audit original-attempt Android/browser/renderer artifacts before closing #717 and updating #660, #653 and PR #677. Never merge PR #677.
