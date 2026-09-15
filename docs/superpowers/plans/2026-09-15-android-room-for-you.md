# Android Room For-you preferences migration implementation plan

> **For Codex:** Follow the accepted issue boundaries and execute this plan with test-driven development. Preserve both Playwright predecessors and never merge PR #677.

**Goal:** Replace both canonical Room For-you preference Playwright definitions with faithful installed-Android Node/Maestro journeys while retaining every predecessor.

**Architecture:** Add a two-stage `android.room-for-you` Node suite using the existing `AccountWorkspaceClient`, finite REST fixtures, exact CDP transport fault instrumentation, and desktop Android viewport. Extend the shared Matrix fault matcher only for exact push-rules reads and exact user/Room/tag writes, and extend the fixture closure with narrowly typed notification/tag setup and observation. Maestro owns every reachable product action; CDP remains observation, document-root visual setup, and bounded transport instrumentation only.

**Pinned inputs:** `room-settings-for-you.spec.mts` SHA-256 `923fe4053badf040b9deaf9beba7da74bc27bf19277af4bb570462fed2c24f88`, lines 150–225 and 227–391; `room-settings-journey.mts` SHA-256 `bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`, lines 36–44; `multi-account-journey.mts` SHA-256 `d0eba322f61a8139fc0666dee5f0575a473f5bcd9007af619f22b740bc851306`; `app.mts` SHA-256 `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`.

---

### Task 1: Freeze source shape and the 38-identity parity contract

- [x] **Step 1: Write the failing migration contract test**

Add `scripts/room-for-you-migration.spec.mjs`. Pin both definition spans, exact titles, 12 + 23 direct assertion sites including the file-local `openForYou` and `expectMode` helpers, three inherited `openRoom` obligations, source hashes, predecessor retention, native-only interaction boundaries, exact fault targets, cleanup/redaction, registration, CI order, and documentation mapping.

- [x] **Step 2: Run the focused test and prove RED**

Run the focused Vitest file through the `scripts` Nx target and require failure because the contract and journey files do not yet exist.

- [x] **Step 3: Add the exact contract**

Create `e2e/android/room-for-you-contract.mts` with exact source mappings, 35 direct identities and three inherited stage-local identities. Assert exact counts and uniqueness at module load.

- [x] **Step 4: Re-run the focused contract test**

Keep the journey/registration expectations red while the source and identity assertions become green.

### Task 2: Add exact preference transport and server-state support

- [x] **Step 1: Write failing exact matcher/controller tests**

Extend `scripts/matrix-http-fault.spec.mjs` with negative and positive cases for only `GET /_matrix/client/<version>/pushrules[/]` and only the exact `PUT`/`DELETE /user/<user>/rooms/<room>/tags/m.lowpriority` target. Prove first-match failure, later pass-through, adjacent user/Room/tag/method exclusion, request counts, injected status/body evidence, and bounded close.

- [x] **Step 2: Implement the narrow fault targets**

Extend `e2e/android/matrix-http-fault.mts` without broad URL interception. Preserve existing invite/join/room-state/alias behavior and expose exact per-kind observations needed by the new suite.

- [x] **Step 3: Write failing fixture tests**

Extend `scripts/account-workspace-fixtures.spec.mjs` for notification-mode setup/read and Room-tag readback, including Account/Room isolation, URL encoding, response validation, and token non-disclosure.

- [x] **Step 4: Implement finite fixture methods**

Extend `e2e/android/account-workspace-fixtures.mts` with typed `setRoomNotificationMode`, `roomNotificationMode`, and `roomTags` methods inside the existing private-token closure. Reuse tracked cleanup and bounded request signals.

- [x] **Step 5: Run focused transport and fixture tests**

Require all old and new cases green before writing the installed-Android journeys.

### Task 3: Implement the two installed-Android stages

- [x] **Step 1: Add the failed-read/retry stage**

Create `e2e/android/room-for-you-journeys.mts`. Seed one private shared Room, sign in natively, open its timeline, install an exact first push-rules GET 500/`offline` fault, and navigate to For you with native taps. Record the exact error heading, absent `aria-live`, enabled and geometrically contained retry, failure capture, editable-form recovery, and at least two exact reads.

- [x] **Step 2: Add the Account-isolation/partial-retry stage**

Seed Accounts A/B with B in mentions + favourite and A in all + no tags. Add B through native UI, return to A, mix both into the shared Room, open For you, and stage mute/favourite/low-priority using native radio and checkbox input. Fail only A's exact low-priority write with HTTP 500/`retry me`; prove exact partial feedback, positive first-write counts, exactly one favourite write, at least one low-priority attempt, retry-only-low-priority, and exact final A/B server state.

- [x] **Step 3: Preserve visual and local-helper parity**

Observe the file-local `openForYou` and `expectMode` assertion sites without duplicating contract identities. Verify focused heading, all expected/other radio states across A initial/A staged/B final, six reversible default/Amethyst/Onyx light/dark form captures, 125% text scale, readable/reachable action geometry, exact Account labels, and native cancellation/Account switching.

- [x] **Step 4: Preserve diagnostics and teardown**

Use one attempt and zero retries, started-only artifact directories, per-stage pass/failure captures, all 38 unique identities, exact request/server outcomes, renderer/APK/profile provenance, `SECRET_TEXT` redaction, and bounded cleanup for WebView connections, faults, device, Matrix fixtures and Synapse.

### Task 4: Register the suite and hosted evidence

- [x] **Step 1: Add the Nx target and package command**

Register uncached serial `trinity-e2e-android:room-for-you` with `android-avd` + `synapse`, a 30-minute Node timeout, and `e2e:android:room-for-you`.

- [x] **Step 2: Register suite metadata**

Add `android.room-for-you` to `scripts/e2e-suite-registry.mjs` with host timeout, never-cache policy, exact entrypoint and both serialization keys; extend registry tests with a 35-minute wrapper allowance.

- [x] **Step 3: Wire Android shard 3**

Run the suite immediately after `room-profile-settings` and before `accounts-workspace` with a started marker and a 35-minute wrapper. Extend CI source-shape tests and started-only artifact upload globs.

- [x] **Step 4: Add the migration ledger mapping**

Append all 38 predecessor-to-replacement identities, execution boundaries, validation requirements, and non-retirement/non-merge boundary to `e2e/android/MIGRATION.md`.

### Task 5: Validate, publish and accept

- [x] **Step 1: Run focused and full script tests**

Run the migration, transport, fixture, registry and workflow tests, then `pnpm nx test scripts --skipNxCache`.

- [x] **Step 2: Run static Nx and documentation gates**

Run Android/browser typecheck and lint, formatting, documentation test/check/assemble/E2E, all pinned source hashes and `git diff --check`.

- [x] **Step 3: Run at least six effective deliberate controls**

Temporarily mutate and restore a direct identity, inherited identity, push-read matcher, low-priority exact target, retry-write count, Account isolation, and cleanup/redaction expectations. Each mutation must fail its intended guard and the restored check must pass.

- [x] **Step 4: Run three unchanged native first attempts sequentially**

Run `pnpm nx run trinity-e2e-android:room-for-you --skipNxCache` three times without source/build/input changes. Require both stages, 38 unique identities, one attempt, zero retries, completed native commands, exact outcomes, provenance, redaction and teardown.

- [x] **Step 5: Run both exact unchanged Playwright predecessors**

Run each title sequentially with `--workers=1 --retries=0`; require retry-zero passes and clean Synapse teardown.

- [ ] **Step 6: Review, publish and audit hosted evidence**

Require no unresolved review findings. Commit and push `test/718-android-room-for-you`, cherry-pick the verified commit onto `test/676-android-sidebar-filter`, re-run composed-tree gates, push, and audit original-attempt Android/browser/renderer artifacts before closing #718 and updating #660, #653 and PR #677. Never merge PR #677.
