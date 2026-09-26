# Android Message Grouping Maestro Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The coordinator must not delegate unless the user explicitly selects subagent-driven execution.

**Goal:** Migrate the Android branch of the canonical message-grouping journey to one installed-Android Maestro stage without changing its Playwright predecessor or desktop-only tail.

**Architecture:** A pure contract owns 22 source-mapped assertions and used-geometry predicates. One run-scoped Matrix fixture seeds three exact same-sender events; Maestro owns all app interaction, while read-only WebView and native Preferences observers measure cosy/Compact state. The serial Nx target, fail-closed diagnostics, and original-attempt hosted artifact audit make the result reviewable.

**Tech Stack:** TypeScript `.mts`, Node `node:test`, Vitest source/negative-control guards, Matrix Client-Server REST, Maestro, Capacitor Android WebView/Preferences, Nx, and GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-24-android-message-grouping-maestro-design.md` (approved written design); [issue #745](https://github.com/quwisky/trinity-matrix-client/issues/745).

**Review correction (after `7cec1c4b`):** Task 2 must parse the whole Preferences
XML document structurally with the explicitly declared `saxes` dependency;
comments cannot supply entries and malformed surrounding XML must fail.
Behavioral controls live in `scripts/appearance-density-preference.spec.mjs`.
Task 3 must require `.msg__text` visibility and positive dimensions, not merely
the enclosing row's visibility; the migration guard executes the real observer
against hidden/collapsed/zero-size text. These corrections invalidate the
earlier native three-run set for final acceptance. Repeat Task 5's unchanged
native set and original-attempt hosted audit after the corrections stabilize.

## Global Constraints

- Preserve `e2e/browser/journeys/conversations/message-grouping.spec.mts` SHA-256 `9cdd8dcd5722dabe4783b9f045bcff56ab4c50adfce51f2ce9ba8e33884dd05f`, `e2e/support/app.mts` SHA-256 `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`, and `e2e/support/account.mts` SHA-256 `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
- Own predecessor lines 57–234 through the explicit Android return and helper/constant lines 25–52; exclude desktop-only lines 237–643. Keep every Playwright definition enabled. The Android stage has exactly 22 unique parity records: Room 1, bodies 3, avatar/continuations 2, leads 3, text edges 3, cosy spacing 3, phone toolbar 1, Compact gap 1, Compact geometry 5.
- Seed one fresh Account/private non-DM Room and the exact consecutive bodies `First message`, `Second message with enough text to reach the trailing action track without the reserved inset`, and `Third message` via real Synapse; retain their ordered `$` event IDs internally.
- Maestro owns login, Room/Settings/Appearance navigation, Compact selection, and Room return. REST may arrange fixtures; WebView and package Preferences access may only observe. No DOM click/focus/fill/submit/scroll/navigation, synthetic hover/pointer action, direct `data-density`/style/class mutation, stylesheet-value or screenshot-only geometry proof.
- The native Preferences key is `trinity.appearance.density` in `shared_prefs/CapacitorStorage.xml`. After selection require exactly one XML entry decoding to JSON with exactly `{ "version": 1, "value": "compact" }`; a bare `compact`, duplicate entry, malformed XML/entity/JSON, wrong version, or wrong value fails. Before selection, absence means rendered Cosy default; a present entry must be version-1 Cosy. Never publish raw XML.
- Use one attempt, zero retries, finite polls/actions/cleanup, serialized `android-avd` and `synapse`, exact renderer/APK/profile provenance, started-stage pass/failure text captures, secret-safe artifacts, and a fail-closed publication marker. Keep raster proof only in ignored local output, never in commits or published diagnostics.
- Run Synapse-backed checks sequentially. Keep task checkpoints uncommitted until full local verification and review; stage only #745-owned files. The ten unrelated untracked `docs/superpowers/plans/2026-09-22-*.md` files are user-owned and stay untouched. Keep PR #677 draft/open and unmerged.

## Review Focus

1. A missing, duplicate, or malformed density entry must fail before Compact can be claimed, even if `html` happens to show Compact (Task 2 parser tests; Task 3 persistence gate).
2. A stale Room route or three bodies from unrelated rows must not produce parity records; require the same Room and exact ordered `data-mid` IDs before and after Settings (Task 1 route/row tests; Task 3 integration control).
3. Offscreen or ambiguous native Compact choices must not be replaced by a DOM click or silent selection; require one production select and Maestro action receipt (Task 3 flow and guard tests).
4. A declared 40 px flex basis, screenshot-like gap, nonzero margin, or equal cosy/Compact total height must fail used-geometry proof (Task 1 mutated observations).
5. A bearer token, raw XML, raster file, missing capture, cancellation, or cleanup failure must prevent a passing report and `publication-safe` marker (Task 3 artifact/cancellation tests).

## File Map

| File                                                                                                                                                               | Responsibility                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `e2e/android/message-grouping-contract.mts`                                                                                                                        | Ordered 22 IDs, exact Room/event scoping, and pure cosy/Compact geometry predicates.          |
| `scripts/message-grouping-migration.spec.mjs`                                                                                                                      | Source pins/AST ownership, pure negative controls, forbidden-path guard, and wiring checks.   |
| `e2e/android/appearance-density-preference.mts`                                                                                                                    | Strict `run-as` XML/JSON decoding of one density key into a sanitized observation.            |
| `e2e/android/message-grouping-journeys.mts`                                                                                                                        | Fixture setup, one native stage, read-only WebView measurements, records, report and cleanup. |
| `e2e/android/message-grouping-artifacts.mts`                                                                                                                       | Pass/failure text capture scrub, secret/raster scan and `publication-safe` gate.              |
| `e2e/android/flows/native-shell-appearance-compact.yaml`                                                                                                           | Focused Maestro select of Compact only.                                                       |
| `e2e/android/project.json`, `package.json`, `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`, `.github/workflows/ci.yml`, `e2e/android/MIGRATION.md` | Uncached serialized target, registry/CI and parity ledger.                                    |

---

### Task 1: Pin source ownership and pure grouping geometry

**Files:** Create `e2e/android/message-grouping-contract.mts`; create `scripts/message-grouping-migration.spec.mjs`.

**Interfaces:** Export `MESSAGE_GROUPING_ASSERTIONS` (readonly 22-element tuple), `type MessageGroupingAssertion`, `type GroupingEvent`, `type GroupingRow`, `type GroupingGeometry`, `assertGroupingRecords(actual: readonly string[]): void`, `assertGroupingRoomRoute(url: string, roomId: string, userId: string): void`, `parseGroupingGeometry(value: unknown): GroupingGeometry`, `assertExactRows(rows: readonly GroupingRow[], expected: readonly GroupingEvent[]): void`, `assertCosyGrouping(observation: GroupingGeometry): void`, and `assertCompactGrouping(cosy: GroupingGeometry, compact: GroupingGeometry): void`. `GroupingEvent` is `{ readonly id: string; readonly body: string }`; `GroupingRow` adds `visible`, `continuation`, `avatarCount`, and the exact rendered body. `GroupingGeometry` has three DOM-ordered rows with finite `leadWidth`, `textLeft`, `paddingTop`, `marginTop`, `height`, `columnGap`, and nullable `bodyEndGap`, plus global `toolbarCount`. The parser rejects missing/non-finite fields before comparison.

- [ ] **Step 1: Write the failing source and contract tests.** Use `createHash('sha256')` on all three pins; parse the predecessor with TypeScript AST to pin assertion sites, 40 px constant, Android branch/return, and excluded tail. Import the absent contract. Assert exactly 22 source-ordered IDs; use a valid three-row observation and table-driven bad variants for wrong ID/order/body, hidden row, second avatar, missing continuation, 39.9 px lead, displaced text, cosy start margin, compact 8.1 px gap, equal heights, and absent/wide trailing body gap.

```js
expect(digest('e2e/browser/journeys/conversations/message-grouping.spec.mts')).toBe('9cdd8dcd5722dabe4783b9f045bcff56ab4c50adfce51f2ce9ba8e33884dd05f');
expect(source).toContain('if (isAndroidE2E) {');
expect(source).toContain("html.setAttribute('data-density', 'compact')"); // Predecessor-only behavior; forbidden in the new journey.
expect(MESSAGE_GROUPING_ASSERTIONS).toHaveLength(22);
expect(() => assertCosyGrouping({ ...validCosy, rows: [{ ...validCosy.rows[0], marginTop: 16 }, ...validCosy.rows.slice(1)] })).toThrow();
expect(() => assertCompactGrouping(validCosy, { ...validCompact, rows: [{ ...validCompact.rows[0], columnGap: 8.1 }, ...validCompact.rows.slice(1)] })).toThrow();
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- message-grouping-migration.spec.mjs`.** Expected RED because the contract does not exist; independently confirm the source/hash checks pass.
- [ ] **Step 3: Implement only the pure contract.** Define IDs in the spec's 1/3/2/3/3/3/1/1/5 order below; require count, uniqueness and exact order. Require exactly three visible rows in DOM order with ordered `data-mid` IDs and exact bodies, one first-row avatar and two continuations. Compare used `getBoundingClientRect()` values supplied by the observer, not CSS declarations. For text edges, compare each with the first within one CSS pixel; for Compact, require strictly lower sum of three row heights and present body-end gap within one CSS pixel.

```ts
export const MESSAGE_GROUPING_ASSERTIONS = ['message-grouping.room-visible', 'message-grouping.body-first', 'message-grouping.body-second', 'message-grouping.body-third', 'message-grouping.avatar-count', 'message-grouping.continuation-count', 'message-grouping.lead-first', 'message-grouping.lead-second', 'message-grouping.lead-third', 'message-grouping.text-left-first', 'message-grouping.text-left-second', 'message-grouping.text-left-third', 'message-grouping.cosy-start-padding', 'message-grouping.cosy-continuation-padding', 'message-grouping.cosy-start-margin', 'message-grouping.phone-no-toolbar', 'message-grouping.compact-column-gap', 'message-grouping.compact-total-height', 'message-grouping.compact-start-padding', 'message-grouping.compact-start-margin', 'message-grouping.compact-continuation-padding', 'message-grouping.compact-body-end-gap'] as const;
assert.equal(new Set(actual).size, 22);
assert.deepEqual(actual, MESSAGE_GROUPING_ASSERTIONS);
assert.deepEqual(
  rows.map((row) => row.id),
  expected.map((event) => event.id),
);
assert.deepEqual(
  rows.map((row) => row.body),
  expected.map((event) => event.body),
);
assert(rows.every((row) => row.visible));
assert.equal(cosy.rows[0]!.marginTop, 0);
assert.equal(compact.rows[0]!.columnGap, 8);
assert(compact.rows.reduce((sum, row) => sum + row.height, 0) < cosy.rows.reduce((sum, row) => sum + row.height, 0));
```

- [ ] **Step 4: Re-run the focused target and Android typecheck.** Expected GREEN. Temporarily invert one condition per geometry category and require its named negative control to turn RED; restore each condition and require GREEN. Use `pnpm nx run trinity-e2e-android:typecheck` separately from Vitest.

### Task 2: Decode native density persistence strictly

**Files:** Create `e2e/android/appearance-density-preference.mts`; extend `scripts/message-grouping-migration.spec.mjs`.

**Interfaces:** Export `type NativeAppearanceDensityObservation = { readonly present: boolean; readonly version: 1 | null; readonly value: 'cosy' | 'compact' }`, `parseNativeAppearanceDensityPreference(xml: string): NativeAppearanceDensityObservation`, and `readNativeAppearanceDensityPreference(client: AccountWorkspaceClient, expected: 'cosy' | 'compact', timeoutMs?: number): Promise<NativeAppearanceDensityObservation>`. The reader returns only this sanitized object; it never returns XML.

- [ ] **Step 1: Write failing parser tests.** Valid cases: absent key in a complete map yields `{present:false, version:null, value:'cosy'}`; XML-escaped JSON for version-1 Cosy or Compact decodes exactly. Invalid cases: duplicate density entry, bare `compact`, wrong version/value, extra JSON key, malformed JSON/XML, unsupported XML entity, malformed named entry and absent Compact. Require the reader source to use `run-as` and the exact package-owned file without preference writes.

```js
expect(parseNativeAppearanceDensityPreference('<map/>')).toEqual({ present: false, version: null, value: 'cosy' });
expect(parseNativeAppearanceDensityPreference('<map><string name="trinity.appearance.density">{&quot;version&quot;:1,&quot;value&quot;:&quot;compact&quot;}</string></map>')).toEqual({ present: true, version: 1, value: 'compact' });
for (const value of ['compact', '{"version":2,"value":"compact"}', '{"version":1,"value":"large"}']) expect(() => parseNativeAppearanceDensityPreference(xmlWithDensity(value))).toThrow();
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- message-grouping-migration.spec.mjs`.** Expected RED for the missing parser.
- [ ] **Step 3: Implement a narrow, fail-closed observer.** Follow the bounded `run-as` read pattern in `e2e/android/timeline-membership-preference.mts`; decode supported XML entities and reject remaining entity syntax; require exactly one matching string entry after selection. Parse JSON as an object with exactly `version` and `value`, compare version and value, and expose no raw XML in returned values or thrown error messages. Poll with `waitForNativeShellState` for the expected value and bounded timeout.

```ts
const stored: unknown = JSON.parse(decodedXmlValue);
assert(stored !== null && typeof stored === 'object' && !Array.isArray(stored), 'Density envelope is an object');
assert.deepEqual(Object.keys(stored).sort(), ['value', 'version'], 'Density envelope has exact keys');
const envelope = stored as Record<string, unknown>;
assert.equal(envelope['version'], 1, 'Density envelope is version 1');
assert(envelope['value'] === 'cosy' || envelope['value'] === 'compact', 'Density is a known value');
return { present: true, version: 1, value: envelope['value'] };
```

- [ ] **Step 4: Run the focused tests and Android typecheck again.** Expected GREEN. Intentionally relax duplicate, version, entity and bare-string checks one at a time; require the corresponding tests to turn RED, then restore them.

### Task 3: Run one native cosy-to-Compact stage with safe artifacts

**Files:** Create `e2e/android/message-grouping-journeys.mts`, `e2e/android/message-grouping-artifacts.mts`, and `e2e/android/flows/native-shell-appearance-compact.yaml`; extend `scripts/message-grouping-migration.spec.mjs`.

**Interfaces:** Consume Tasks 1–2 and existing `createAccountFixtures`, `AccountWorkspaceClient`, `PIXEL_5_ACCOUNT_PROFILE`, `openMaestroDevice`, `installWithAndroidRuntimeProvenance`, `evaluateNative`, and `waitForNativeShellState`. Export `runMessageGroupingSuite(context: TestContext): Promise<void>` for the Node entrypoint. The journey-private `runStage(client, fixtures, stage): Promise<void>` performs the native sequence. The artifact module exports `scanGroupingArtifacts(output: string, secrets: Readonly<Record<string, string>>): Promise<void>` and `runGroupingStageCleanup(actions: readonly (() => Promise<void>)[], failures: unknown[]): Promise<void>`; its final publication function requires captures and a clean report. Write one `message-grouping` stage with `attempt:1`, `retries:0`, `expectedAssertionRecords:22`, sanitized per-record receipts, `runtime-provenance.json`, pass/failure text captures, and a `publication-safe` marker only after clean teardown and scan.

- [ ] **Step 1: Add failing native-ownership and artifact tests.** Require ordered `fixtures.sendMessage` calls with one Account and exact bodies; one stage with 22 post-assertion `record` calls; native `client.login`, `tapCurrent`/Maestro flow navigation and `runFlow` Compact choice; read-only renderer evaluation; `run-as` preference observation; same-Room route/ID proof after return; explicit pass/failure captures and aggregate cleanup. Reject forbidden DOM methods and direct `data-density` writes in the new files. In temporary ignored output, inject a bearer string, registered secret, raw Preferences XML, raster file, missing capture, or failing cleanup and require publication to fail.

```js
expect(journey).toContain('fixtures.sendMessage(account, room.id, body,');
expect(journey).toContain("readNativeAppearanceDensityPreference(client, 'compact'");
expect(journey).not.toMatch(/setAttribute\(['"]data-density|\.click\(|\.scrollIntoView\(/u);
await expect(scanGroupingArtifacts(unsafeOutput, secrets)).rejects.toThrow();
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- message-grouping-migration.spec.mjs`.** Expected RED for the absent journey, flow, and artifact gate.
- [ ] **Step 3: Seed and open the Room natively.** In `withNodeTestResources`, register bounded cleanup, open the Maestro device, install with exact runtime provenance, reset a Pixel 5 client, then create a fresh account and private Room. Send the three bodies sequentially using the existing fixture; require `$` IDs and preserve raw IDs only in memory. Login, tap `rail-rooms` and the exact `.channel`, check Room route/account/view, then wait for the three exact `data-mid` rows. Record Room/body identities only after their checks pass.

```ts
const bodies = ['First message', 'Second message with enough text to reach the trailing action track without the reserved inset', 'Third message'] as const;
const account = await fixtures.account('grouping');
const room = await fixtures.createRoom(account, { name: resources.roomName('grouping'), preset: 'private_chat' });
const events: GroupingEvent[] = [];
for (const [index, body] of bodies.entries()) events.push({ id: await fixtures.sendMessage(account, room.id, body, `grouping-${index}`), body });
await client.login(account);
await client.tapCurrent('[data-testid="rail-rooms"]');
await client.tapCurrent('.channel', { text: room.name });
assertGroupingRoomRoute((await evaluateNative(client.webview, 'location.href')) as string, room.id, account.userId);
```

- [ ] **Step 4: Measure and record cosy geometry from used boxes.** In one read-only `evaluateNative`, filter `.msg[data-mid]` by the three exact IDs and return primitive row facts from `getBoundingClientRect()` and `getComputedStyle()`. Reject missing/duplicate rows, wrong body, pending IDs or non-finite geometry before recording. Call `assertExactRows` and `assertCosyGrouping`; record the source-ordered avatar, continuation, lead, text-edge, cosy-spacing and no-toolbar identities. Save the actual sum of three border-box heights for Compact comparison.

```ts
const observed = await evaluateNative(
  client.webview,
  `(() => {
  const wanted = new Set(${JSON.stringify(events.map((event) => event.id))});
  const rows = [...document.querySelectorAll('.msg[data-mid]')]
    .filter((row) => wanted.has(row.getAttribute('data-mid')))
    .map((row) => {
      const box = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      const lead = row.querySelector('.msg__avatar, .msg__gutter');
      const text = row.querySelector('.msg__text');
      const body = row.querySelector('.msg__body');
      if (!lead || !text || !body) return null;
      const bodyBox = body.getBoundingClientRect();
      const textBox = text.getBoundingClientRect();
      const textStyle = getComputedStyle(text);
      return {
        id: row.getAttribute('data-mid'), body: text.textContent?.trim() ?? '',
        visible: box.width > 0 && box.height > 0 && style.visibility === 'visible' &&
          textBox.width > 0 && textBox.height > 0 && textStyle.visibility === 'visible',
        continuation: row.classList.contains('msg--cont'),
        avatarCount: row.querySelectorAll('.msg__avatar').length,
        leadWidth: lead.getBoundingClientRect().width,
        textLeft: textBox.left,
        paddingTop: parseFloat(style.paddingTop), marginTop: parseFloat(style.marginTop),
        height: box.height, columnGap: parseFloat(style.columnGap),
        bodyEndGap: box.right - parseFloat(style.paddingInlineEnd) - bodyBox.right,
      };
    });
  return { rows, toolbarCount: document.querySelectorAll('.msg__toolbar').length };
})()`,
);
const geometry = parseGroupingGeometry(observed);
assertExactRows(geometry.rows, events);
```

- [ ] **Step 5: Select Compact using only Maestro, then remeasure.** Verify preselection native density as absent/default Cosy or persisted version-1 Cosy and rendered Cosy. Use the existing `native-shell-settings.yaml` and `native-shell-appearance.yaml` navigation, discover the production `density-select` button's native-accessible ID read-only, and run a new focused `native-shell-appearance-compact.yaml` containing only `scrollUntilVisible`, trigger tap and `Compact` tap. Wait for exact version-1 Compact persistence; return to the same Room through native actions. Recheck route and ordered IDs/bodies, then call `assertCompactGrouping` on new used geometry and record the six Compact identities (8 px gap plus five geometry comparisons).

```yaml
appId: ${APP_ID}
androidWebViewHierarchy: devtools
---
- scrollUntilVisible:
    element:
      id: ${DENSITY_TRIGGER_ID}
    direction: DOWN
- tapOn:
    id: ${DENSITY_TRIGGER_ID}
- tapOn: Compact
```

```ts
const flowRoot = join(client.workspaceRoot, 'e2e/android/flows');
await client.device.runFlow(join(flowRoot, 'native-shell-settings.yaml'), { APP_ID: client.applicationId });
await client.device.runFlow(join(flowRoot, 'native-shell-appearance.yaml'), { APP_ID: client.applicationId });
const trigger = await evaluateNative(client.webview, `document.querySelector('[data-testid="density-select"] button')?.id`);
assert(typeof trigger === 'string' && trigger.length > 0, 'Density trigger has a native-accessible ID');
await client.device.runFlow(join(flowRoot, 'native-shell-appearance-compact.yaml'), { APP_ID: client.applicationId, DENSITY_TRIGGER_ID: trigger });
assert.deepEqual(await readNativeAppearanceDensityPreference(client, 'compact'), { present: true, version: 1, value: 'compact' });
await client.device.runFlow(join(flowRoot, 'native-shell-back.yaml'), { APP_ID: client.applicationId });
await client.device.runFlow(join(flowRoot, 'native-shell-back.yaml'), { APP_ID: client.applicationId });
await client.visible('[data-testid="rail-rooms"]');
await client.tapCurrent('[data-testid="rail-rooms"]');
await client.tapCurrent('.channel', { text: room.name });
assertGroupingRoomRoute((await evaluateNative(client.webview, 'location.href')) as string, room.id, account.userId);
```

- [ ] **Step 6: Make reporting and teardown fail closed.** Follow the existing `message-forward-artifacts.mts` stack: register redaction and scrub before device/fixture cleanup so teardown precedes final scan; register account credentials, Room name/ID, event IDs and all three bodies as secrets before capturing; record one stage as running before product actions; capture both success/failure in ignored output; remove raster files; scan secrets, bearer patterns and raw XML; aggregate client close, app-data clear, Matrix/device release and scan errors. A failed assertion, cancellation, missing capture, scrub or cleanup keeps the report failed and prevents `publication-safe`. Record event-ID digests/aliases rather than raw IDs in publishable receipts.

```ts
const stage = { id: 'message-grouping', status: 'running', attempt: 1, retries: 0, expectedAssertionRecords: 22, assertionRecords: 0, assertions: [] as string[] };
try {
  await runStage(client, fixtures, stage);
  await client.capture('passed');
} catch (error) {
  failures.push(error);
  await client.capture('failed').catch((captureError) => failures.push(captureError));
} finally {
  await runGroupingStageCleanup([() => client.close(), () => device.clearApplicationData(APPLICATION_ID)], failures);
  stage.status = failures.length ? 'failed' : 'passed';
  await save();
}
if (failures.length) throw new AggregateError(failures, 'Android message-grouping stage failed');
```

- [ ] **Step 7: Run focused tests and `pnpm nx run trinity-e2e-android:typecheck`.** Expected GREEN. Perform intentional failed-assertion, missing-row, absent Compact, unsafe-artifact and cleanup fault controls; require each to fail the named boundary and retain sanitized diagnostics.

### Task 4: Register and document the hosted suite

**Files:** Modify `e2e/android/project.json`, `package.json`, `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`, `.github/workflows/ci.yml`, and `e2e/android/MIGRATION.md`; extend `scripts/message-grouping-migration.spec.mjs`, `scripts/e2e-suite-registry.spec.mjs`, and `scripts/ci-workflow.spec.mjs` only for their owned named contracts.

**Interfaces:** Nx target `trinity-e2e-android:message-grouping`; suite ID `android.message-grouping`; package script `e2e:android:message-grouping`; shard-2 `message-grouping-started` flag, `message-grouping-safe` gate, and `android-message-grouping` diagnostic surface.

- [ ] **Step 1: Write failing wiring checks.** Require one non-cached, nonparallel `message-grouping` target dependent on `trinity-android:build-prebuilt`, invoking `run-node.mts` with exact suite/entrypoint, `--timeout-ms=1200000`, `--platform=android --bundle-manifest --resource=android-avd --resource=synapse`. Require one matching registry/package/command entry, shard 2 after message-forward and before cross-user, bounded 1,500,000 ms CI wrapper, started-only safe-marker gate, and upload only when both started and safe. Require an old-to-new 22-record table and explicit desktop-tail exclusion in `MIGRATION.md`.

```js
expect(project.targets['message-grouping'].cache).toBe(false);
expect(project.targets['message-grouping'].options.command).toContain('--suite=android.message-grouping');
expect(suites.filter((suite) => suite.id === 'android.message-grouping')).toHaveLength(1);
expect(workflow).toContain("steps.message-grouping-artifact-gate.outputs.message-grouping-safe == 'true'");
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- message-grouping-migration.spec.mjs`.** Expected RED for absent target, registry and CI entries.
- [ ] **Step 3: Add the target and entries beside message-forward.** Use that resolved Nx target's prebuilt-APK/manifest command as the template, with the new suite/entrypoint and finite timeout; add the package and registry entries, then insert the CI runner, safe gate and upload block immediately after message-forward. Do not retire the browser suite.

```json
"message-grouping": {
  "cache": false,
  "parallelism": false,
  "dependsOn": [{ "projects": ["trinity-android"], "target": "build-prebuilt" }],
  "outputs": ["{workspaceRoot}/dist/.playwright/trinity-e2e-android"],
  "executor": "nx:run-commands",
  "options": { "command": "TRINITY_E2E_PROJECT=trinity-e2e-android TRINITY_E2E_PREBUILT_WWW=1 node scripts/web-bundle-manifest.mjs verify dist/web-bundle-manifest.json www && TRINITY_E2E_PROJECT=trinity-e2e-android TRINITY_E2E_PREBUILT_WWW=1 node e2e/support/run-node.mts --suite=android.message-grouping --timeout-ms=1200000 --entrypoint=e2e/android/message-grouping-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse" }
}
```

- [ ] **Step 4: Run focused guard, registry/workflow guards, Android typecheck and formatting.** Use `pnpm nx run scripts:test -- message-grouping-migration.spec.mjs`, `pnpm nx run scripts:test -- e2e-suite-registry.spec.mjs`, `pnpm nx run scripts:test -- ci-workflow.spec.mjs`, `pnpm nx run trinity-e2e-android:typecheck`, `pnpm lint`, and `pnpm format:check`. Read a failing source-shape guard's docstring before modifying it. Preserve unrelated formatter failures as separate evidence.

### Task 5: Local acceptance, review, publication and hosted audit

**Files:** No new source files; keep proof under ignored `dist/`. Post evidence only to #745, #660, #653 and PR #677 after it exists.

**Interfaces:** Three unchanged local Android reports, one retry-zero retained browser report, reviewed diff, a task-only commit/push, and the first hosted merge-checkout Android/browser/renderer artifacts.

- [ ] **Step 1: Run `pnpm nx run trinity-e2e-android:message-grouping --skipNxCache` three times sequentially without edits or retries.** Require each original attempt to show 1/1 stage, 22 distinct source-ordered identities, attempt 1/retries 0, exact three Matrix event/Room receipts, native Settings/Compact selection, version-1 preference readback, non-vacuous cosy-to-Compact geometry, pass/failure text capture, clean teardown, safe marker and matching renderer/APK/profile provenance. Retain and report any first-attempt failure; a later pass does not erase it.
- [ ] **Step 2: Run the unchanged canonical browser predecessor sequentially:** `pnpm nx run trinity-e2e-browser:e2e -- e2e/browser/journeys/conversations/message-grouping.spec.mts --workers=1 --retries=0`. Require its complete applicable and desktop tail to pass, not skip; recheck all three pinned SHA-256 values.
- [ ] **Step 3: Run full selected repository gates and review the complete task-owned diff.** Run `pnpm nx run scripts:test`, `pnpm nx run trinity-e2e-android:typecheck`, `pnpm nx run-many -t typecheck`, `pnpm test`, `pnpm lint`, `pnpm stylelint`, `pnpm format:check`, `pnpm build`, `pnpm architecture:check`, `pnpm nx run trinity-e2e-web:production-renderer`, and the Android prebuilt/host target when prerequisites exist. Record each exact command, exit status, environment and artifact; distinguish unrelated failures and unavailable checks. Inspect staged, unstaged and task-owned untracked changes, run `git diff --check`, fix review findings and rerun invalidated checks. No subagent dispatch without explicit user choice.
- [ ] **Step 4: Stage only #745 files, commit `test(e2e): migrate Android message grouping to Maestro`, and push `test/676-android-sidebar-filter` after local acceptance and review.** Do not stage the ten unrelated untracked plans, rewrite pushed history, mark PR #677 ready or merge it.
- [ ] **Step 5: Audit the first hosted run at its exact merge checkout.** Verify the Android artifact ZIP/API digest and provenance, 1/1 stage, 22/22 unique records, attempt 1/retries 0, native actions, ordered event/route receipts, exact version-1 native persistence, geometry, diagnostics/redaction and cleanup. Audit the unchanged browser predecessor and production renderer artifacts independently; classify unrelated failures under #665. Only after all #745 gates pass, post exact evidence to #745/#660/#653 and PR #677, close #745, then continue to #746. PR #677 remains draft/open and unmerged.

## Self-review

- All spec sections have an owning task: source and 22-record contract (1), native density format (2), Matrix/native/geometry/artifacts (3), Nx/registry/CI/docs (4), and local/hosted delivery (5).
- The five Review Focus conditions have named negative controls in their owning tasks. Pure predicates, renderer observations, native action receipts and artifact safety are separate evidence, not interchangeable claims.
- Interfaces use the same `GroupingEvent`, `GroupingRow`, `GroupingGeometry`, density observation, stage ID and suite/target names across tasks. The older 2026-09-20 plan is explicitly superseded.
