# Android Core Space Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a seven-stage installed-Android Maestro/Node replacement for every assertion in the canonical core Space Settings Playwright file while keeping all seven predecessors enabled.

**Architecture:** The suite reuses the invocation-owned Android device, Account workspace client, Matrix fixtures, and read-only WebView observation boundary. New code is split into a small contract/observation layer, three cohesive journey groups, and one lifecycle orchestrator; the only shared infrastructure extensions are exact keyed room-state interception, Matrix state/power fixtures, and an Android DocumentsUI selector whose side effects are unit-tested.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Playwright Android WebView/CDP observation, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

**Spec:** GitHub issue [#701](https://github.com/quwisky/trinity-matrix-client/issues/701), pinned to consolidated base `cb8959d70f9e5c1b61e651bb2048f17a0b66ff9e` and source SHA-256 `662f0fc7c62ba206aa1bd344c1d9ecf913162424c486b97059d252ff7ea30a3a`.

## Global Constraints

- Preserve all seven Playwright definitions and their 85 direct assertions; do not retire, skip, weaken, or retry them.
- Drive product input through measured Maestro actions, Android DocumentsUI, and native Android Space/Enter key events.
- CDP is read-only except a source-pinned fixture that sets/restores only root font size, the `dark` class, `data-theme`, and viewport metrics.
- Seed and verify Matrix state through finite REST fixtures; scope the recovery fault to the exact parent Space and `m.space.child` route.
- Keep renderer/APK verification, run-scoped diagnostics, device/WebView/Matrix cleanup, and secret redaction on every exit.
- Run Synapse-backed suites sequentially because they share fixed ports.
- Place the new hosted suite on Android shard 2 after `native-shell` and before retained Playwright.
- Keep screenshots, APKs, reports, and deliberate-control output under ignored `dist/` paths.

---

### Task 1: Exact keyed Matrix transport and state fixtures

**Files:**

- Modify: `scripts/matrix-http-fault.spec.mjs`
- Modify: `e2e/android/matrix-http-fault.mts`
- Modify: `scripts/account-workspace-fixtures.spec.mjs`
- Modify: `e2e/android/account-workspace-fixtures.mts`

**Interfaces:**

- Consumes: `DevtoolsEventConnection`, `MatrixTestResources`, `NodeWorkspaceAccount`.
- Produces: keyed `MatrixRoomStateTarget.stateKey`, `MatrixHttpFault.createRoomAttempts`, `setRoomState(account, roomId, eventType, content)`, `setRoomPower(account, roomId, memberId, power)`, and keyed/broadened `roomState(...)` reads.

- [x] **Step 1: Write failing transport tests**

Add table-driven cases with literal URLs proving that a target `{ roomId: '!parent:localhost', eventType: 'm.space.child', stateKey: '*' }` matches only non-empty child keys under that exact parent, and that the active fault controller counts `POST /createRoom` independently of the failed child write.

```js
expect(
  isMatrixRoomStateRequest(paused('PUT', childUrl), {
    roomId: '!parent:localhost',
    eventType: 'm.space.child',
    stateKey: '*',
  }),
).toBe(true);
expect(fault.createRoomAttempts).toBe(1);
```

- [x] **Step 2: Verify the transport tests fail for the missing keyed contract**

Run: `pnpm nx test scripts -- scripts/matrix-http-fault.spec.mjs --runInBand`

Expected: FAIL because `stateKey` and `createRoomAttempts` are not implemented.

- [x] **Step 3: Implement the minimal keyed matcher and counter**

Accept an omitted empty state key, an exact state key, or the explicit wildcard `'*'`; decode URL components before comparing. Add a second Fetch pattern for `/createRoom`, continue those requests unchanged, and increment only the exposed counter.

```ts
export interface MatrixRoomStateTarget {
  readonly roomId: string;
  readonly eventType: 'm.room.name' | 'm.room.topic' | 'm.space.child';
  readonly stateKey?: '' | '*' | string;
}
```

- [x] **Step 4: Run the transport tests green**

Run: `pnpm nx test scripts -- scripts/matrix-http-fault.spec.mjs --runInBand`

Expected: PASS with existing invite/join/name/topic cases unchanged.

- [x] **Step 5: Write failing Matrix fixture tests**

Add literal request/response cases proving `setRoomState` emits the exact encoded state path/body, `setRoomPower` GETs and merges the complete current power event before PUT, and `roomState` can read avatar, join-rules, power-level, and keyed parent events without returning tokens.

```js
await fixtures.setRoomState(owner, '!space:localhost', 'm.room.topic', {
  topic: 'Seed topic',
});
await fixtures.setRoomPower(owner, '!space:localhost', '@member:localhost', 50);
```

- [x] **Step 6: Verify the fixture tests fail for missing methods**

Run: `pnpm nx test scripts -- scripts/account-workspace-fixtures.spec.mjs --runInBand`

Expected: FAIL with `setRoomState is not a function` or `setRoomPower is not a function`.

- [x] **Step 7: Implement the minimal finite Matrix methods and run green**

Use the existing authenticated `request`/`get` closure, preserve all current power-level fields, encode event type and state key, and register no new long-lived resource.

Run: `pnpm nx test scripts -- scripts/account-workspace-fixtures.spec.mjs --runInBand`

Expected: PASS.

### Task 2: Android document selection and visual fixture boundaries

**Files:**

- Create: `scripts/maestro-document-picker.spec.mjs`
- Create: `e2e/android/maestro-document-picker.mts`
- Create: `e2e/android/flows/accounts-document-pick.yaml`
- Create: `e2e/android/space-settings-visual-fixture.mts`
- Modify: `scripts/maestro-keyboard.spec.mjs`
- Modify: `e2e/android/maestro-keyboard.mts`

**Interfaces:**

- Consumes: `MaestroDevice`, `AccountWorkspaceClient`, a local PNG path, and run-scoped output.
- Produces: `pickAndroidDocument(device, workspaceRoot, localPath, remoteName): Promise<void>` and `withSpaceSettingsVisualFixture(client, options, operation): Promise<void>`.

- [x] **Step 1: Write failing behavior tests for DocumentsUI staging**

Use a fake `MaestroDevice` that records real method arguments. Assert the exact `adb push`, Maestro flow/variables, and `adb shell rm -f` cleanup order for success and flow failure.

```js
await pickAndroidDocument(device, root, '/tmp/photo.png', 'space-photo.png');
expect(calls).toEqual([
  ['adb', 'push', '/tmp/photo.png', '/sdcard/Download/space-photo.png'],
  ['flow', flowPath, { APP_ID: 'eu.qwky.trinity', FILE_NAME: 'space-photo.png' }],
  ['adb', 'shell', 'rm', '-f', '/sdcard/Download/space-photo.png'],
]);
```

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- scripts/maestro-document-picker.spec.mjs --runInBand`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement staging, selection, and guaranteed cleanup**

Reject path separators in `remoteName`, push only to `/sdcard/Download`, run `accounts-document-pick.yaml`, and delete the staged file in `finally`. The YAML taps the exact visible filename and contains no launch, WebView, or script command.

- [x] **Step 4: Run document-picker tests green**

Run: `pnpm nx test scripts -- scripts/maestro-document-picker.spec.mjs --runInBand`

Expected: PASS for success, invalid-name, and cleanup-after-failure cases.

- [x] **Step 5: Implement the narrow visual fixture wrapper**

Capture original inline font size, `dark`, and `data-theme`; set only requested fixture values through `evaluateNative`; restore in `finally`; leave product elements, application state, focus, events, forms, history, and location untouched.

```ts
await withSpaceSettingsVisualFixture(client, { fontSize: '125%', dark: true, theme: 'amethyst' }, () => client.capture('space-contents-desktop-dark-amethyst'));
```

- [x] **Step 6: Add native Enter through the tested keyboard boundary**

First add a literal `enter -> 66` expectation to `scripts/maestro-keyboard.spec.mjs`, run it red, then add `enter: 66` to `ANDROID_KEYCODES` and rerun green. This keeps the address stage on Android's real key-event path.

Run: `pnpm nx test scripts -- scripts/maestro-keyboard.spec.mjs --runInBand`

Expected: FAIL before the keycode is added, then PASS after the minimal map change.

### Task 3: Pin all seven stages and 85 replacement identities

**Files:**

- Create: `scripts/space-settings-core-migration.spec.mjs`
- Create: `e2e/android/space-settings-core-contract.mts`
- Create: `e2e/android/space-settings-core-observations.mts`

**Interfaces:**

- Consumes: issue #701's seven source spans and literal assertion list.
- Produces: `spaceSettingsCoreAssertions`, seven source constants, observed DOM/Matrix recorders, native settings navigation helpers, and an exact `85`-identity invariant.

- [x] **Step 1: Write the failing migration contract**

Pin the SHA-256 and seven titles of `space-settings.spec.mts`; list all 85 literal identities; require seven exact source spans, native tap/fill/key/document-picker calls, the keyed child fault, Matrix reads, the narrow visual fixture, and absence of product `.click()`, `.focus()`, `dispatchEvent`, form submission, history, or location mutation in journey files.

```js
expect(createHash('sha256').update(source).digest('hex')).toBe('662f0fc7c62ba206aa1bd344c1d9ecf913162424c486b97059d252ff7ea30a3a');
expect(new Set(assertionIds).size).toBe(85);
```

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- scripts/space-settings-core-migration.spec.mjs --runInBand`

Expected: FAIL because the contract and journey modules do not exist.

- [x] **Step 3: Add the contract and observation modules**

Define all literal identities once, export source spans, and implement record-on-success/record-on-failure wrappers for DOM elements, arbitrary read-only expressions, and finite Matrix reads. Reuse `AccountWorkspaceClient` and `waitForNativeShellState`; do not introduce an alternate driver.

- [x] **Step 4: Run the migration contract and TypeScript check**

Run: `pnpm nx test scripts -- scripts/space-settings-core-migration.spec.mjs --runInBand`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

Expected: the migration test remains red only for missing journey stages; typecheck passes for the new shared modules.

### Task 4: Admin, seeded-value, and exact Contents stages

**Files:**

- Create: `e2e/android/space-settings-core-admin-journeys.mts`
- Create: `e2e/android/space-settings-core-contents-journey.mts`

**Interfaces:**

- Consumes: Task 1 Matrix APIs, Task 2 document/visual helpers, and Task 3 assertions/observations.
- Produces: `spaceSettingsCoreAdminCases` with two cases and `spaceSettingsCoreContentsCase` with one case.

- [x] **Step 1: Implement the admin stage against the failing 21-identity contract**

Seed the Space, mounted child Room, and suggested child link through Matrix; drive login, room selection, Space reopening, settings, viewport cycle, image picker, General save, Access select, and close through native input. Record exactly `admin.*` identities 1-21 and the required light and dark-Amethyst captures.

- [x] **Step 2: Implement the seeded-values stage**

Seed non-default topic and public join rule through `setRoomState`; open settings natively and record exactly `seed.name`, `seed.topic`, and `seed.join-rule` from the live UI.

- [x] **Step 3: Implement the Contents lifecycle stage**

Seed linked/candidate Room and candidate Space. Use native Space to select one checkbox, native taps for the other and for create/remove dialogs, diff `spaceChildIds` to discover created IDs, fail the first exact parent `m.space.child` write, assert one create request before/after retry, and verify no keyed child `m.space.parent` event plus retained memberships and post-demotion read-only controls. Record identities 25-57 and both required Contents captures.

- [x] **Step 4: Run focused static and type checks**

Run: `pnpm nx test scripts -- scripts/space-settings-core-migration.spec.mjs --runInBand`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

Expected: only the four remaining stage definitions keep the migration contract red; TypeScript passes.

### Task 5: Read-only, permission-loss, address, and roster stages

**Files:**

- Create: `e2e/android/space-settings-core-permissions-journeys.mts`

**Interfaces:**

- Consumes: shared assertions/observations and Matrix power/membership fixtures.
- Produces: `spaceSettingsCorePermissionCases` with four cases and assertion identities 58-85.

- [x] **Step 1: Implement the ordinary-member stage**

Join a plain member to the Space and linked child, open General/Access/Contents natively, and record exact paragraph tags, disabled/absent actions, policy copy, visible child, and the named read-only capture.

- [x] **Step 2: Implement live permission loss**

Grant the member power 50, create a dirty Topic through native input, demote to 0 through Matrix, and record editable-to-read-only transition, retained draft, explanation, Discard, and disabled Save.

- [x] **Step 3: Implement native Enter address publication**

Fill the localpart, call `client.key('enter')`, then prove the Space dialog remains open, the exact alias appears, and `resolveRoomAlias` returns the Space ID.

- [x] **Step 4: Implement Owner/Admin roster distinction**

Join a second member, merge equal top power for owner and peer, open the Members shortcut natively, and record dialog/heading plus the correct owner/admin group rows.

- [x] **Step 5: Run the migration contract and typecheck green**

Run: `pnpm nx test scripts -- scripts/space-settings-core-migration.spec.mjs --runInBand`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

Expected: PASS with seven stage definitions and all 85 identities present.

### Task 6: Suite lifecycle, registry, Nx, package, CI, and migration docs

**Files:**

- Create: `e2e/android/space-settings-core-journeys.mts`
- Modify: `e2e/android/project.json`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `e2e/registry/commands.mts`
- Modify: `package.json`
- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Modify: `scripts/ci-workflow.spec.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `e2e/android/MIGRATION.md`

**Interfaces:**

- Consumes: all seven cases and existing Node/Maestro invocation lifecycle.
- Produces: runnable `android.space-settings-core`, Nx target `trinity-e2e-android:space-settings-core`, package script `e2e:android:space-settings-core`, shard-2 started diagnostic artifact, and durable parity documentation.

- [x] **Step 1: Write failing registry and workflow assertions**

Require the new host-budget suite, exact entrypoint/target/script, upload count `31`, one `android-space-settings-core` started-only upload, and ordering after `native-shell` on shard 2 but before `pnpm e2e:android --`.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- scripts/e2e-suite-registry.spec.mjs scripts/ci-workflow.spec.mjs --runInBand`

Expected: FAIL because the suite, target, command, and CI step are absent.

- [x] **Step 3: Implement the lifecycle orchestrator**

Open one invocation-owned Maestro device, install the verified debug APK, reset each case to its declared profile, execute all seven cases sequentially, write `journeys.json` after every transition, capture pass/failure diagnostics, redact secrets, close WebView/device, and assert `cases.length === 7` plus `Object.keys(spaceSettingsCoreAssertions).length === 85`.

- [x] **Step 4: Register the target and hosted diagnostics**

Use cache false, parallelism false, Android build dependency, `android-avd`/`synapse` serialization, host timeout, and source entrypoint. Add the package command and shard-2 workflow command/upload without moving or weakening retained Playwright.

- [x] **Step 5: Document exact parity and provisional bounds**

Add a `Core Space Settings administration batch` section with #701, pinned base/hash/spans, all 85 identities grouped by stage, native/CDP boundaries, command, artifact path, shard placement, and acceptance requirements.

- [x] **Step 6: Run registry/workflow, scripts, type, lint, and format gates**

Run: `pnpm nx test scripts -- scripts/e2e-suite-registry.spec.mjs scripts/ci-workflow.spec.mjs scripts/space-settings-core-migration.spec.mjs scripts/maestro-document-picker.spec.mjs scripts/matrix-http-fault.spec.mjs scripts/account-workspace-fixtures.spec.mjs --runInBand`

Run: `pnpm nx test scripts --skipNxCache`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

Run: `pnpm nx run trinity-e2e-android:lint --skipNxCache`

Run: `pnpm nx run trinity-e2e-registry:typecheck --skipNxCache`

Run: `pnpm nx run trinity-e2e-registry:lint --skipNxCache`

Run: `pnpm format:check`

Expected: all pass; retain exact output and exit statuses.

### Task 7: Native red/green controls, stable passes, predecessor, and publication

**Files:**

- Modify only if a native failure exposes an owned defect in the files above.
- Keep evidence under: `dist/.playwright/`, `dist/maestro-private/`, and ignored control directories.

**Interfaces:**

- Consumes: `trinity-e2e-android:space-settings-core` and the unchanged Playwright source.
- Produces: effective deliberate controls, three unchanged-input first-attempt native passes, seven predecessor passes, review evidence, and one authorized feature/consolidated commit.

- [x] **Step 1: Run an effective native control before acceptance**

Temporarily mutate one assertion boundary at a time without committing: wrong source hash, omitted assertion identity, wrong keyed fault target, wrong DocumentsUI filename, wrong expected Matrix state, and disabled redaction/cleanup guard. Preserve each expected failure artifact, then restore the mutation with `apply_patch` and verify the owned check passes.

- [x] **Step 2: Run the complete native suite sequentially until three unchanged-input first attempts pass**

Run: `pnpm nx run trinity-e2e-android:space-settings-core --skipNxCache`

Expected for each accepted run: seven passed stages, 85 assertion JSONs, one attempt, zero retries, native command records completed, exact profile/renderer/APK receipts, and clean Synapse/device teardown.

- [x] **Step 3: Re-run the unchanged predecessor**

Run: `pnpm nx run trinity-e2e-browser:e2e -- e2e/browser/journeys/room-administration/space-settings.spec.mts --grep "Space settings" --workers=1 --retries=0`

Expected: 7 passed on the first attempt and clean Synapse teardown.

- [x] **Step 4: Run final diff and worktree checks**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; only #701-owned files are changed.

- [x] **Step 5: Request independent review and address findings through red/green cycles**

Review the complete working-tree artifact against `cb8959d7`, including untracked files. Re-run affected checks after every material change.

- [ ] **Step 6: Commit and push only after fresh verification**

Stage only #701-owned files, inspect `git diff --cached`, commit as `test(e2e): migrate Android core Space Settings`, push `test/701-android-space-settings-core`, cherry-pick onto `test/676-android-sidebar-filter`, verify again, and push the consolidated branch. Do not merge PR #677.

- [ ] **Step 7: Audit hosted shard 2 before closing #701**

Require original-attempt green browser and Android shard-2 jobs. Download the immutable suite artifact and audit seven stages, 85 identities, exact fault/count evidence, native commands, renderer/APK/profile provenance, secret redaction, and teardown before updating #701, #660, and PR #677.
