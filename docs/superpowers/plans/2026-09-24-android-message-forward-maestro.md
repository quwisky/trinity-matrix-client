# Android Message Forward Maestro Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one Android-applicable message-forward definition with a faithful installed-Android Maestro journey while retaining its Playwright predecessor.

**Architecture:** An existing disposable-Synapse fixture creates one account and two run-scoped Rooms. Maestro owns composer, action-sheet, picker and Room navigation; read-only WebView observations identify reconciled event IDs, and independent Matrix REST reads prove source readiness and the exact new target event. A seven-identity contract, single-attempt report and publication-safe artifact gate make the local and hosted result auditable.

**Tech Stack:** TypeScript `.mts`, Node `node:test`, Vitest contract tests, Matrix Client-Server REST, Maestro, Capacitor Android WebView, Nx and GitHub Actions.

**Spec:** [Issue #744](https://github.com/quwisky/trinity-matrix-client/issues/744), whose acceptance text is the source of requirements.

## Global Constraints

- The pinned predecessor is `e2e/browser/journeys/conversations/message-forward.spec.mts` SHA-256 `2c90b5ee4989d85c611629e37cf8847169b90c21d526a52e1e8d0113dfee179d`; its owned definition is lines 30–94 and Room helper lines 17–25. `e2e/support/app.mts` and `e2e/support/account.mts` must retain hashes `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
- Preserve the predecessor unchanged. Map its three direct assertion sites (lines 71, 85 and 91) plus two `openRoom` readiness expansions, one `waitForSent` server-ready expansion and one `openMessageActionSheet` readiness expansion to seven ordered stage-local records.
- One run-scoped account owns exact source and target Rooms. Source text is entered/sent through native composer actions and must have a real `$` event ID and an authoritative source-Room server event before Forward. The target server event must have a distinct ID, exact target Room, active sender and body, `m.text` type, and neither `m.relates_to` nor `m.new_content`.
- Maestro owns all reachable product actions. Fixture REST may only arrange and inspect Matrix state; WebView inspection may only read readiness, visibility, text, IDs and selector identity. No DOM click/focus/fill/submit/navigation, desktop hover menu, synthetic target event, fuzzy first-result selection or retry.
- Register credentials, account/Room/event IDs and run-scoped body with the artifact redactor; capture outcomes locally but remove raster files before publication. Fail closed if scrub/scan or bounded cleanup fails. Keep APK, renderer and profile provenance, serialized `android-avd` + `synapse`, one attempt and zero retries.
- Keep PR #677 draft/open and unmerged. Run Synapse-backed tests sequentially. Keep implementation checkpoints uncommitted until full local validation and review, then stage only #744 files and push the existing authorized branch for original-attempt hosted evidence. Close #744 and update #660 only after auditing Android, browser and renderer artifacts.

## Review Focus

1. A pending local echo with a non-`$` row ID must fail source readiness before a long press (Task 1 test; Task 2 journey).
2. A wrong account/Room, same source and target event ID, wrong body, or stale relation must fail target-server proof (Task 1 table-driven tests).
3. A duplicate or approximate picker result must not be tapped; require one exact target-name Room result, not `.first()` (Task 2 integration/negative control).
4. A stale action sheet or nonnative Forward path must not emit the sheet identity; require the visible Android sheet, one exact `sheet-forward` target and native touch receipt (Task 2 negative control).
5. Cancellation, a missing secret, unsafe raster, bearer value or cleanup failure must prevent `publication-safe` and a passed report (Tasks 2–3 tests).

## File Map

| File                                                                                                                                                               | Responsibility                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `e2e/android/message-forward-contract.mts`                                                                                                                         | Seven ordered source-mapped identities and pure authoritative event predicates.       |
| `scripts/message-forward-migration.spec.mjs`                                                                                                                       | Source pins, predicate negative controls, native ownership, report and wiring guards. |
| `e2e/android/message-forward-journeys.mts`                                                                                                                         | One installed-Android native stage, fixtures, receipts, captures and cleanup.         |
| `e2e/android/message-forward-artifacts.mts`                                                                                                                        | Secret registry, text redaction, raster removal and fail-closed scan.                 |
| `e2e/android/project.json`, `package.json`, `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`, `.github/workflows/ci.yml`, `e2e/android/MIGRATION.md` | Nx/registry/CI entrypoints and old-to-new parity ledger.                              |

---

### Task 1: Pin source ownership and event predicates

**Files:** Create `e2e/android/message-forward-contract.mts`; create `scripts/message-forward-migration.spec.mjs`.

**Interfaces:** Export `MESSAGE_FORWARD_ASSERTIONS`, `assertForwardRecords(actual)`, `assertReadySourceEvent(event, expected)`, and `assertForwardTargetEvent(event, expected)`; `expected` has `eventId` (source only), `roomId`, `sender` and `body`, and target additionally has `sourceEventId`.

- [ ] **Step 1: Write failing tests.** Compute the three source hashes, parse the predecessor with TypeScript AST for exact assertion sites and Android branch, then import the absent contract. Hand-author a valid Matrix event fixture and invalid variants for pending ID, wrong Room/sender/body, same event ID and stale relations. Assert each invalid variant throws.

```js
expect(assertionLines(source, 30, 94)).toEqual([71, 85, 91]);
expect(assertionLines(source, 17, 25)).toEqual([22]);
expect(MESSAGE_FORWARD_ASSERTIONS).toEqual(['message-forward.source-room-ready', 'message-forward.source-row-visible', 'message-forward.source-server-ready', 'message-forward.sheet-ready', 'message-forward.picker-visible', 'message-forward.target-room-ready', 'message-forward.target-row-and-event']);
expect(() => assertReadySourceEvent({ ...sourceEvent, event_id: '~pending' }, expectedSource)).toThrow();
expect(() => assertForwardTargetEvent({ ...targetEvent, content: { ...targetEvent.content, 'm.relates_to': { event_id: '$source' } } }, expectedTarget)).toThrow();
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- message-forward-migration.spec.mjs`.** Expected RED because the contract module does not exist; independently verify the source/hash checks pass.
- [ ] **Step 3: Implement the smallest pure contract.** Require exactly seven unique ordered identities. For each event, require a real `$` ID, exact `room_id`/`sender`/`content.body`, and `msgtype: 'm.text'`. The target predicate additionally rejects the source ID and both relation keys.

```ts
const content = event['content'];
assert(content && typeof content === 'object' && !Array.isArray(content));
assert.equal(event['room_id'], expected.roomId);
assert.equal(event['sender'], expected.sender);
assert.equal((content as Record<string, unknown>)['body'], expected.body);
assert.equal((content as Record<string, unknown>)['msgtype'], 'm.text');
assert(!('m.relates_to' in content) && !('m.new_content' in content));
```

- [ ] **Step 4: Re-run the focused target.** Expected GREEN; temporarily reverse each event predicate and confirm its corresponding negative-control test goes RED, then restore the correct implementation.

### Task 2: Prove the native path and safe diagnostics

**Files:** Create `e2e/android/message-forward-journeys.mts`; create `e2e/android/message-forward-artifacts.mts`; extend `scripts/message-forward-migration.spec.mjs`.

**Interfaces:** Consume Task 1 predicates/identities and existing `createAccountFixtures`, `AccountWorkspaceClient`, `openMaestroDevice` and `installWithAndroidRuntimeProvenance`; write `journeys.json`, `runtime-provenance.json`, stage assertion files and `publication-safe` under the runner report directory.

- [ ] **Step 1: Add failing checks.** Require one stage and exactly seven source-ordered record calls, native `login/fill/key/longPressCurrent/tapCurrent` use, a current-point Forward tap, exact target picker result before touch, REST `roomEvent` reads for both Rooms, native outcome captures, aggregate-failing cleanup, and artifact scrub/scan. Test the artifact scanner with a temporary bearer string, registered secret and raster; each must fail before publication.

```js
expect(() => assertForwardRecords(['message-forward.source-room-ready', 'message-forward.source-row-visible'])).toThrow();
await expect(scanForwardArtifacts(tempWithBearer, secrets)).rejects.toThrow();
await expect(scanForwardArtifacts(tempWithRaster, secrets)).rejects.toThrow();
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- message-forward-migration.spec.mjs`.** Expected RED for the missing journey/artifact module and absent native ownership.
- [ ] **Step 3: Implement one serial stage.** Create `fixtures.account('forward')`, two uniquely named `fixtures.createRoom` Rooms, register secrets before use, and `client.login(account)`. Open the source through `rail-rooms` and exact `.channel` text using `tapCurrent`; record source Room readiness. Native-fill the composer, send with `key('enter')`, wait for exactly one visible matching row whose `data-mid` begins `$`, then fetch `fixtures.roomEvent(account, source.id, sourceEventId)` and call `assertReadySourceEvent` before long-press.

```ts
await client.fill('[data-testid="composer-input"]', body);
await client.key('enter');
const [sourceRow] = await client.waitElements('.scroll .msg[data-mid]', (rows) => rows.length === 1 && rows[0]!.visible && rows[0]!.attributes['data-mid']?.startsWith('$') === true, 'exact source reconciled to Matrix', { text: body }, 30_000);
const sourceId = sourceRow!.attributes['data-mid']!;
assertReadySourceEvent(await fixtures.roomEvent(account, source.id, sourceId), { eventId: sourceId, roomId: source.id, sender: account.userId, body });
await client.longPressCurrent(`.scroll .msg[data-mid=${JSON.stringify(sourceId)}]`);
await client.visible('[role="dialog"][aria-label="Message actions"]');
await client.tapCurrent('[data-testid="sheet-forward"]');
```

- [ ] **Step 4: Require the exact picker and target event.** Wait for one visible `switcher-input`, native-fill the unique target name, require exactly one visible `switcher-result` with exact title plus `Room` kind, and tap that result with native current-point touch. Open the exact target channel natively. Wait for one visible body-matching target row with a distinct `$` ID, fetch its target-Room server event and call `assertForwardTargetEvent` before recording the final identity. Do not use `.first()` or the source Room row as target proof.
- [ ] **Step 5: Add single-attempt reporting and safety.** Record seven identities only after their assertions pass; capture pass/failure device+WebView state to ignored output. Use `withNodeTestResources` for bounded Matrix and device teardown. Register scan first and scrub second, before device/fixture cleanup registrations, so the stack unwinds device/fixture cleanup, then scrub, then scan. Remove raster formats, reject raw registered secrets/Bearer/storage values and write `publication-safe` only after successful cleanup; a cleanup error marks the stage failed.
- [ ] **Step 6: Run focused tests and `pnpm nx run trinity-e2e-android:typecheck`.** Expected GREEN. Run intentional fault controls for source readiness, sheet absence, duplicate picker, target event variants and scrub/cleanup; each must fail at the named boundary.

### Task 3: Register a started-and-safety-gated hosted suite

**Files:** Modify `e2e/android/project.json`, `package.json`, `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`, `.github/workflows/ci.yml`, `e2e/android/MIGRATION.md`; extend `scripts/message-forward-migration.spec.mjs` and any registry/workflow guard that owns the new entry.

**Interfaces:** Nx target `trinity-e2e-android:message-forward`; registry ID `android.message-forward`; package script `e2e:android:message-forward`; shard-2 started flag and dedicated `android-message-forward` artifact.

- [ ] **Step 1: Add failing registration/CI tests.** Resolve the Nx project; require the exact Node runner, `--platform=android --bundle-manifest --resource=android-avd --resource=synapse`, one attempt, predecessor retention, matching registry/command IDs, a shard-2 execution line after edit-history and before cross-user, and upload gated by both `message-forward-started` and the matching `publication-safe` marker.

```js
expect(project.targets['message-forward'].options.command).toContain('--suite=android.message-forward');
expect(suites.filter((s) => s.id === 'android.message-forward')).toHaveLength(1);
expect(workflow).toContain("steps.message-forward-artifact-gate.outputs.message-forward-safe == 'true'");
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- message-forward-migration.spec.mjs`.** Expected RED for the absent Nx/registry/workflow entries.
- [ ] **Step 3: Add the entries using the neighboring edit-history forms.** Keep the predecessor enabled and add an explicit old-to-new seven-record table in `MIGRATION.md`. Use `pnpm nx` for the CI command, `ci-run-command.mjs` with a finite budget, and the same `find`-based publication-safe gate that worked for #743; do not condition diagnostics on suite success, only on started + safe.
- [ ] **Step 4: Re-run focused, registry and workflow tests, Android typecheck/lint, scripts lint and formatting.** Read any failing source-shape guard before changing it. Document unrelated existing failures without editing user-owned untracked plans.

### Task 4: Local and hosted acceptance checkpoint

**Files:** No new source files; write local proof only under ignored `dist/`. Update #744, #660, #665 and PR #677 only when the corresponding evidence exists.

**Interfaces:** Three unchanged local installed-Android reports, one unchanged canonical browser predecessor report, reviewed diff, pushed commit and original-attempt hosted Android/browser/renderer artifacts.

- [ ] **Step 1: Run `pnpm nx run trinity-e2e-android:message-forward --skipNxCache` three times sequentially on the installed emulator.** Confirm each reports one stage, seven unique records, attempt 1/retries 0, completed Maestro commands, source/target server receipts, cleanup, publication-safe marker and matching APK/renderer/profile provenance. Preserve first failures; do not relabel retries as first attempts.
- [ ] **Step 2: Run the exact retained predecessor sequentially at retry 0** using the registered `trinity-e2e-browser:e2e` focused target and the `message-forward.spec.mts` path. Verify one actual pass, not a skipped Docker preflight.
- [ ] **Step 3: Run all applicable repository validation and whole-batch review.** At minimum: scripts test (record the known unrelated untracked-plan failure if still present), scripts and Android lint, Android typecheck, formatting, registry/architecture guards and `git diff --check`. Request independent review of the complete task-owned diff; resolve findings and rerun invalidated checks.
- [ ] **Step 4: After authorization already granted for this branch, stage only #744 files, commit one `test(e2e): ...` change and push `test/676-android-sidebar-filter`.** Do not stage user-owned untracked plans, merge PR #677 or mark it ready.
- [ ] **Step 5: Audit the first hosted run at the exact merge checkout.** Verify the Android artifact ZIP digest, seven assertion files/summary/JUnit, one attempt/retries 0, native receipts, server proof, cleanup/publication safety and APK/renderer provenance; verify the unchanged browser predecessor and production renderer artifacts separately. Classify unrelated shard failures under #665. Only then close #744, update #660 and PR #677, and unblock #745.

## Self-review

- Source ownership, all seven identities, real ready source/target events, native sheet/picker, redaction, cleanup, CI wiring, three local attempts, browser coexistence and hosted audit each have an owning task.
- The pure event tests and integration negative controls exercise the five Review Focus cases; no target event is manufactured through fixtures.
- `sourceEventId`, `targetEventId`, `roomId`, `sender` and `body` use the same meanings in contract, journey and tests. All commands use existing resolved Nx targets or add a target before execution.
