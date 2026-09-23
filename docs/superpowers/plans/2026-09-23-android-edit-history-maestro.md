# Android Edit History Maestro Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two Android-applicable edit-history definitions with installed-Android Maestro journeys that pass all 62 source-mapped records without retiring any Playwright predecessor.

**Architecture:** Two serial stages use private Matrix REST fixtures to seed and verify edit chains, Maestro for every product action, and read-only WebView observation for exact semantics and geometry. A reversible `MaestroDevice` font-scale lease restores the prior Android setting through abort-independent cleanup. One contract pins the predecessor, excludes the desktop-only definition, and owns exact assertion accounting.

**Tech Stack:** TypeScript `.mts`, Node `node:test`, Vitest guard/unit tests, Matrix Client-Server REST with disposable Synapse, Maestro/ADB, Capacitor Android WebView, Nx, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-23-android-edit-history-maestro-design.md`

## Global Constraints

- Issue #743 owns browser lines 123–396 and 500–552, including lines 29–118 shared helpers; lines 398–495 are browser-only.
- Pin SHA-256 `66b251c72f0939a9913fb31641107f500d22cf627ff7b566740e15e744c37153` for the predecessor, `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` for app support, and `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` for account support.
- Preserve all three Playwright definitions unchanged; exactly 46 core and 13 Pixel 5 direct sites plus three Pixel 5 helper expansions produce 62 stage-local parity records.
- Use production Pixel 5 profile 393×727 CSS pixels, DPR 2.75, mobile/touch; real Android `font_scale=1.5` must raise live root text to at least 24px without changing viewport/DPR or inline root style.
- Pixel 5 is compact at baseline; do not claim that font scaling crosses the desktop breakpoint. Prove the large-text reading region and trailing Remove reachability.
- Maestro owns login, Room/marker/dialog navigation, toggles, scrolling, Remove/confirm, and close. REST only arranges/observes Matrix data; WebView inspection is read-only.
- No DOM click/focus/fill/submit/navigation, root-style mutation, viewport resize, synthetic focus, or renderer scroll method/offset assignment.
- Tokens stay private; artifacts redact credentials, bearer headers, event authorization, and unsafe raster output. Teardown is bounded and aggregate-failing, including after cancellation.
- Keep one attempt, zero retries, serial `android-avd` + `synapse`, exact renderer/APK/profile provenance, started-and-safety-gated CI diagnostics, and PR #677 draft/open/unmerged.
- Run Synapse-backed E2E sequentially. Keep Tasks 1–8 as reviewed checkpoints without implementation commits. After unchanged local acceptance and whole-batch review, make one task-owned #743 commit and push it for hosted evidence. Hosted evidence necessarily follows that push; it gates issue closure, not the push itself.

## Review Focus

These implied input/failure cases are easy to miss; the named task must contain the indicated test.

1. **Abort during Android settings write:** Task 2 tests that close waits for the write, restores an originally absent value with `delete`, and uses no cancelled invocation signal.
2. **Unexpected relation page or redacted edit:** Task 3 tests pagination, duplicate/wrong-target relations, and direct-event redaction before reporting server repair.
3. **Dialog or confirm overlay moves a touch target:** Tasks 4–5 test duplicate/covered selectors and guard dynamic `tapCurrent` before a parity record.
4. **Large text clips the last Remove:** Task 6 tests unchanged scroll offset, a covered button, and a right edge past 393px as failures before/after native swipes.
5. **Failure before secrets are collected or during scrub:** Task 7 tests that raster files or bearer strings fail diagnostics scanning and cannot leave a passed stage.

## File Map

| File                                                                                                                                                               | Single responsibility                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `e2e/android/edit-history-contract.mts`                                                                                                                            | Exact 62 identities, source spans, stage order and counts.             |
| `scripts/edit-history-migration.spec.mjs`                                                                                                                          | Pinned source shape, ownership, wiring and mutation guards.            |
| `e2e/android/maestro-session.mts` and `scripts/maestro-session.spec.mjs`                                                                                           | Device-owned reversible font-scale lease and cancellation tests.       |
| `e2e/android/edit-history-fixture.mts` and `scripts/edit-history-fixture.spec.mjs`                                                                                 | Private REST edit chains and authoritative server checks.              |
| `e2e/android/edit-history-observer.mts` and `scripts/edit-history-observer.spec.mjs`                                                                               | Read-only semantic/geometry snapshots and pure fail-closed predicates. |
| `e2e/android/edit-history-journeys.mts`                                                                                                                            | Two native stages, receipts, resource ownership and run report.        |
| `e2e/android/edit-history-artifacts.mts` and `scripts/edit-history-artifacts.spec.mjs`                                                                             | Stage secrets, artifact redaction scan and no-raster rule.             |
| `e2e/android/project.json`, `package.json`, `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`, `.github/workflows/ci.yml`, `e2e/android/MIGRATION.md` | Target, registry, CI and parity documentation.                         |

---

### Task 1: Pin the source and 62-record assertion contract

**Files:** Create `e2e/android/edit-history-contract.mts`; create `scripts/edit-history-migration.spec.mjs`.

**Interfaces:** Produces `EDIT_HISTORY_ASSERTION_RECORDS`, `editHistoryCases`, `editHistoryAssertion(stage, suffix)`, and `assertEditHistoryRecords(stage, actual)` for Tasks 5–8. A case has `id`, `source`, `assertions`, and `expectedAssertionRecords`.

- [ ] **Step 1: Write the failing guard.** Parse the unchanged predecessor with TypeScript AST; count both `expect(...)` and `expect.poll(...)` calls. Require exact site lines, not only totals, and pin all three hashes.

```js
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const predecessor = 'e2e/browser/journeys/conversations/message-edit-history.spec.mts';
const source = readFileSync(predecessor, 'utf8');
const PINNED_SHA = '66b251c72f0939a9913fb31641107f500d22cf627ff7b566740e15e744c37153';
function assertionLines(text, start, end) {
  const tree = ts.createSourceFile(predecessor, text, ts.ScriptTarget.Latest, true);
  const found = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      const match = (ts.isIdentifier(e) && e.text === 'expect') || (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'expect' && e.name.text === 'poll');
      if (match) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        if (line >= start && line <= end) found.push(line);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}
const coreLines = [232, 237, 244, 248, 249, 253, 263, 270, 271, 273, 279, 281, 282, 283, 286, 287, 289, 292, 299, 301, 305, 306, 311, 312, 313, 316, 321, 322, 323, 324, 339, 342, 344, 346, 350, 353, 358, 361, 362, 373, 377, 379, 382, 393, 394, 395];
const helperLines = [108, 111, 116];
const pixelLines = [511, 512, 513, 514, 521, 522, 523, 526, 527, 535, 542, 544, 545];
expect(assertionLines(source, 123, 396)).toEqual(coreLines);
expect(assertionLines(source, 91, 118)).toEqual(helperLines);
expect(assertionLines(source, 500, 552)).toEqual(pixelLines);
expect(assertionLines(source, 398, 495)).toHaveLength(25);
expect(createHash('sha256').update(source).digest('hex')).toBe(PINNED_SHA);
for (const [path, digest] of [
  ['e2e/support/app.mts', '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3'],
  ['e2e/support/account.mts', 'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594'],
])
  expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(digest);
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- edit-history-migration.spec.mjs`.** Expected: RED because the contract module and identities do not exist; source/hash assertions themselves pass.
- [ ] **Step 3: Add the exact contract.** The second tuple value is the stable suffix; prefix it with `edit-history.<stage>.` when creating an identity. Preserve tuple order as source order.

```ts
import assert from 'node:assert/strict';
const coreSites = [
  [232, 'room-ready'],
  [237, 'latest-text'],
  [244, 'marker-visible'],
  [248, 'dialog-visible'],
  [249, 'three-revisions'],
  [253, 'oldest-first-labels'],
  [263, 'insertion-visible'],
  [270, 'inserted-final'],
  [271, 'deleted-second'],
  [273, 'original-no-diff'],
  [279, 'toggle-default-on'],
  [281, 'toggle-off'],
  [282, 'no-insertions-off'],
  [283, 'exact-versions-off'],
  [286, 'insertions-restored'],
  [287, 'no-error'],
  [289, 'not-truncated'],
  [292, 'closed-first'],
  [299, 'formatted-dialog'],
  [301, 'bold-insert-mon'],
  [305, 'bold-delete-fri'],
  [306, 'bold-retain-day'],
  [311, 'bold-monday-off'],
  [312, 'formatted-no-diff-off'],
  [313, 'formatted-no-old-word'],
  [316, 'formatted-closed'],
  [321, 'plain-reopened'],
  [322, 'plain-reopened-three'],
  [323, 'two-remove-actions'],
  [324, 'original-not-removable'],
  [339, 'two-after-current-remove'],
  [342, 'final-absent-after-remove'],
  [344, 'no-error-after-remove'],
  [346, 'closed-after-current-remove'],
  [350, 'timeline-second-draft'],
  [353, 'marker-remains'],
  [358, 'reopened-two'],
  [361, 'removed-final-still-absent'],
  [362, 'second-still-present'],
  [373, 'one-after-last-remove'],
  [377, 'closed-after-last-remove'],
  [379, 'timeline-original'],
  [382, 'marker-absent'],
  [393, 'deleted-row-visible'],
  [394, 'deleted-marker-absent'],
  [395, 'deleted-body-absent'],
] as const;
const pixelSites = [
  [108, 'room-ready'],
  [111, 'latest-text'],
  [116, 'dialog-visible'],
  [511, 'dialog-box-present'],
  [512, 'fullscreen-width'],
  [513, 'fullscreen-height'],
  [514, 'close-visible'],
  [521, 'close-width-44'],
  [522, 'close-height-44'],
  [523, 'dialog-no-overflow'],
  [526, 'toggle-visible'],
  [527, 'revisions-visible'],
  [535, 'reading-no-overflow'],
  [542, 'remove-in-viewport'],
  [544, 'remove-left-inside'],
  [545, 'remove-right-inside'],
] as const;
export const EDIT_HISTORY_ASSERTION_RECORDS = 62 as const;
export const editHistoryCases = [
  { id: 'revision-lifecycle', source: 'e2e/browser/journeys/conversations/message-edit-history.spec.mts:123-396', sites: coreSites, expectedAssertionRecords: 46, assertions: coreSites.map(([, suffix]) => `edit-history.revision-lifecycle.${suffix}`) },
  { id: 'pixel5-large-text', source: 'e2e/browser/journeys/conversations/message-edit-history.spec.mts:500-552', sites: pixelSites, expectedAssertionRecords: 16, assertions: pixelSites.map(([, suffix]) => `edit-history.pixel5-large-text.${suffix}`) },
] as const;
export type EditHistoryCase = (typeof editHistoryCases)[number];
export type EditHistoryAssertion = EditHistoryCase['assertions'][number];
export function editHistoryAssertion(stage: EditHistoryCase['id'], suffix: string): EditHistoryAssertion {
  const entry = editHistoryCases.find((item) => item.id === stage)!;
  const identity = `edit-history.${stage}.${suffix}`;
  assert(entry.assertions.includes(identity as EditHistoryAssertion), `Unexpected identity ${identity}`);
  return identity as EditHistoryAssertion;
}
export function assertEditHistoryRecords(stage: EditHistoryCase['id'], actual: readonly string[]): void {
  const entry = editHistoryCases.find((item) => item.id === stage)!;
  assert.deepEqual(actual, entry.assertions);
}
```

- [ ] **Step 4: Export the identity helpers and run the guard GREEN.** `assertEditHistoryRecords` compares the actual ordered identity list with the case's exact list, not just its size; fail on duplicate, missing, extra, or reordered records. Run `pnpm nx run scripts:test -- edit-history-migration.spec.mjs` and `pnpm nx run trinity-e2e-android:typecheck`.
- [ ] **Step 5: Checkpoint the tested contract.** Inspect the two-file diff and leave it uncommitted for the local acceptance and whole-batch review in Task 9.

### Task 2: Own reversible font scale on the device lease

**Files:** Modify `e2e/android/maestro-session.mts`; modify `scripts/maestro-session.spec.mjs`.

**Interfaces:** Add `FontScaleLease { previous: string | null; applied: '1.5'; restore(): Promise<void> }` and `MaestroDevice.setFontScale(scale: '1.5'): Promise<FontScaleLease>`. The lease does not expose a general Android settings write API.

- [ ] **Step 1: Write RED tests in the existing injected-command fixture.** Model Android `settings get/put/delete system font_scale`; cover prior `1.0`, prior `null`, cancellation during `put`, a failed first restore followed by device-close fallback, readback mismatch, and borrowed-emulator closure. Assert cleanup commands receive their own bounded signal rather than the invocation signal.

```js
const controller = new AbortController();
const device = await openMaestroDevice({ ...f.options, signal: controller.signal }, commands);
const lease = await device.setFontScale('1.5');
expect(lease.previous).toBe(null);
controller.abort(new Error('cancelled'));
await device.close();
expect(operations).toContain('shell settings delete system font_scale');
expect(cleanupOptions.every((o) => o.signal !== controller.signal)).toBe(true);
expect(setting).toBeNull();
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- maestro-session.spec.mjs`.** Expected: RED because `setFontScale` is absent.
- [ ] **Step 3: Implement the focused lease.** `rawAdb` already uses a two-second independent timeout. Snapshot with it, register restoration before starting the write, have restoration await any in-flight write, verify `settings get` after put/delete, and retain a failed restorer for the close-time retry. Run restorers before app cleanup and emulator stop; collect errors while continuing the existing cleanup sequence.

```ts
import assert from 'node:assert/strict';
export interface FontScaleLease {
  readonly previous: string | null;
  readonly applied: '1.5';
  restore(): Promise<void>;
}
// Inside openMaestroDevice:
const fontScaleRestorers = new Set<() => Promise<void>>();
const setFontScale = async (scale: '1.5'): Promise<FontScaleLease> => {
  options.signal?.throwIfAborted();
  if (closing) throw new Error('Cannot change font scale on a closing device');
  const before = await rawAdb('shell', 'settings', 'get', 'system', 'font_scale');
  options.signal?.throwIfAborted();
  if (closing) throw new Error('Device closed before font-scale write');
  const previous = before === 'null' ? null : before;
  let write: Promise<string> = Promise.resolve('');
  let restored = false;
  let restoring: Promise<void> | undefined;
  const restore = (): Promise<void> => {
    if (restored) return Promise.resolve();
    return (restoring ??= (async () => {
      await write.catch(() => undefined); // a cancellation can race with put
      if (previous === null) await rawAdb('shell', 'settings', 'delete', 'system', 'font_scale');
      else await rawAdb('shell', 'settings', 'put', 'system', 'font_scale', previous);
      const after = await rawAdb('shell', 'settings', 'get', 'system', 'font_scale');
      assert.equal(after, previous ?? 'null', 'Exact prior font scale restored');
      restored = true;
      fontScaleRestorers.delete(restore);
    })().catch((error) => {
      restoring = undefined;
      throw error;
    }));
  };
  fontScaleRestorers.add(restore); // register before first write
  write = rawAdb('shell', 'settings', 'put', 'system', 'font_scale', scale);
  try {
    await write;
    assert.equal(await rawAdb('shell', 'settings', 'get', 'system', 'font_scale'), scale);
  } catch (error) {
    try {
      await restore();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Font scale apply and restore failed');
    }
    throw error;
  }
  return { previous, applied: scale, restore };
};
// In close(), before application cleanup and emulator stop:
for (const restore of [...fontScaleRestorers].reverse()) await restore().catch((error: unknown) => failures.push(error));
```

- [ ] **Step 4: Run `pnpm nx run scripts:test -- maestro-session.spec.mjs` and `pnpm nx run trinity-e2e-android:typecheck`.** Expected: GREEN, including cancellation and fallback tests.
- [ ] **Step 5: Checkpoint the device seam and tests.** Inspect the two-file diff and leave it uncommitted for Task 9.

### Task 3: Seed and verify real edit chains through private REST

**Files:** Create `e2e/android/edit-history-fixture.mts`; create `scripts/edit-history-fixture.spec.mjs`.

**Interfaces:** `createEditHistoryFixtures(resources, signal, baseFixtures, fetchImpl = fetch)` returns `lifecycle(account, roomName, txnPrefix)`, `pixel5(account, roomName, txnPrefix)`, and `serverState(account, roomId, originalId, allEditIds, expectedLiveIds)`. `LifecycleSeed` contains `roomId`, `roomName`, `plain { originalId, editIds, versions }`, `formatted { originalId, editId }`, and `doomed { originalId, body }`; `PixelSeed` contains `roomId`, `roomName`, `originalId`, `versions`. `serverState` returns only `{ removedRedacted: true, liveCount, survivorMatches: true }` after throwing on mismatch.

- [ ] **Step 1: Write RED fixture tests with an injected `fetchImpl`.** Assert the exact JSON for plain and formatted `m.replace` events, original-ID target reuse, `* ` fallback, `m.new_content`, formatted `<strong>` body, doomed-message redaction, and long Pixel 5 versions. Simulate two `/relations` pages, wrong sender/target, duplicate live edit, stale removed edit, and an unredacted direct event; each invalid state must reject. Inspect request headers but never print the bearer value.

```js
expect(sentEdit).toEqual({
  msgtype: 'm.text',
  body: `* ${versions[1]}`,
  'm.new_content': { msgtype: 'm.text', body: versions[1] },
  'm.relates_to': { rel_type: 'm.replace', event_id: originalId },
});
await expect(fixtures.serverState(account, roomId, originalId, [edit1, edit2], [edit1])).rejects.toThrow('removed edit is not redacted');
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- edit-history-fixture.spec.mjs`.** Expected: RED because the module is absent.
- [ ] **Step 3: Implement bounded, token-private requests.** Compose `createAccountFixtures` for account/room ownership; open a second password login inside this fixture, register its `/logout` cleanup before seeding, and keep its bearer token closure-private. Use `AbortSignal.any([signal, AbortSignal.timeout(15_000)])` for actions and `AbortSignal.timeout(15_000)` for logout after cancellation. Errors contain method/path/status, never headers or response bodies.

```ts
import assert from 'node:assert/strict';
import { SYNAPSE_HTTP } from '../support/synapse/start.mjs';
import type { MatrixTestResources } from '../support/test-resources.mts';
import { createAccountFixtures, type NodeWorkspaceAccount } from './account-workspace-fixtures.mts';
type FetchLike = typeof fetch;
interface LifecycleSeed {
  readonly roomId: string;
  readonly roomName: string;
  readonly plain: { readonly originalId: string; readonly editIds: readonly [string, string]; readonly versions: readonly string[] };
  readonly formatted: { readonly originalId: string; readonly editId: string };
  readonly doomed: { readonly originalId: string; readonly body: string };
}
interface PixelSeed {
  readonly roomId: string;
  readonly roomName: string;
  readonly originalId: string;
  readonly versions: readonly string[];
}
interface EditHistoryServerProof {
  readonly removedRedacted: true;
  readonly liveCount: number;
  readonly survivorMatches: true;
}
export function createEditHistoryFixtures(resources: MatrixTestResources, signal: AbortSignal, base: ReturnType<typeof createAccountFixtures>, fetchImpl: FetchLike = fetch) {
  const sessions = new Map<string, string>(); // private bearer values
  const sentContents = new Map<string, unknown>();
  const request = async (version: 'v1' | 'v3', path: string, method: 'GET' | 'POST' | 'PUT', token?: string, body?: unknown, requestSignal: AbortSignal = signal): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(`${SYNAPSE_HTTP}/_matrix/client/${version}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error(`Edit-history ${method} ${path} HTTP ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };
  resources.cleanup('Edit-history REST sessions', async () => {
    const failures: unknown[] = [];
    for (const token of sessions.values()) {
      try {
        await request('v3', '/logout', 'POST', token, {}, AbortSignal.timeout(15_000));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Edit-history logout failed');
  });
  const access = async (account: NodeWorkspaceAccount): Promise<string> => {
    const saved = sessions.get(account.userId);
    if (saved) return saved;
    const login = await request('v3', '/login', 'POST', undefined, {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: account.username },
      password: account.password,
    });
    assert(typeof login['access_token'] === 'string' && login['access_token']);
    const token = login['access_token'];
    sessions.set(account.userId, token);
    assert.equal(login['user_id'], account.userId);
    return token;
  };
  const send = async (token: string, roomId: string, txn: string, content: unknown): Promise<string> => {
    const response = await request('v3', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txn)}`, 'PUT', token, content);
    assert(typeof response['event_id'] === 'string' && response['event_id']);
    sentContents.set(response['event_id'], content);
    return response['event_id'];
  };
  const edit = (target: string, body: string) => ({
    msgtype: 'm.text',
    body: `* ${body}`,
    'm.new_content': { msgtype: 'm.text', body },
    'm.relates_to': { rel_type: 'm.replace', event_id: target },
  });
  const formattedEdit = (target: string, runId: string) => ({
    msgtype: 'm.text',
    body: `* deploy on Monday ${runId}`,
    'm.new_content': { msgtype: 'm.text', body: `deploy on Monday ${runId}`, format: 'org.matrix.custom.html', formatted_body: `deploy on <strong>Monday</strong> ${runId}` },
    'm.relates_to': { rel_type: 'm.replace', event_id: target },
  });
  const lifecycle = async (account: NodeWorkspaceAccount, roomName: string, runId: string): Promise<LifecycleSeed> => {
    const token = await access(account);
    const room = await base.createRoom(account, { name: roomName, preset: 'private_chat' });
    const versions = [`first draft ${runId}`, `second draft ${runId}`, `final wording ${runId}`];
    const originalId = await send(token, room.id, `${runId}-orig`, { msgtype: 'm.text', body: versions[0] });
    const edit1 = await send(token, room.id, `${runId}-edit1`, edit(originalId, versions[1]!));
    const edit2 = await send(token, room.id, `${runId}-edit2`, edit(originalId, versions[2]!));
    const formattedId = await send(token, room.id, `${runId}-fmt`, { msgtype: 'm.text', body: `deploy on Friday ${runId}`, format: 'org.matrix.custom.html', formatted_body: `deploy on <strong>Friday</strong> ${runId}` });
    const formattedEditId = await send(token, room.id, `${runId}-fmt-edit`, formattedEdit(formattedId, runId));
    const doomedBody = `deleted message ${runId}`;
    const doomedId = await send(token, room.id, `${runId}-doomed`, { msgtype: 'm.text', body: doomedBody });
    await send(token, room.id, `${runId}-doomed-edit`, edit(doomedId, `${doomedBody} (edited)`));
    await request('v3', `/rooms/${encodeURIComponent(room.id)}/redact/${encodeURIComponent(doomedId)}/${encodeURIComponent(`${runId}-redact`)}`, 'PUT', token, {});
    return { roomId: room.id, roomName, plain: { originalId, editIds: [edit1, edit2] as const, versions }, formatted: { originalId: formattedId, editId: formattedEditId }, doomed: { originalId: doomedId, body: doomedBody } };
  };
  const pixel5 = async (account: NodeWorkspaceAccount, roomName: string, runId: string): Promise<PixelSeed> => {
    const token = await access(account);
    const room = await base.createRoom(account, { name: roomName, preset: 'private_chat' });
    const tail = ` ${runId} `;
    const versions = ['first draft', 'second draft', 'final wording'].map((prefix) => `${prefix}${tail}${'long content '.repeat(60)}`);
    const originalId = await send(token, room.id, `${runId}-orig`, { msgtype: 'm.text', body: versions[0] });
    await send(token, room.id, `${runId}-edit1`, edit(originalId, versions[1]!));
    await send(token, room.id, `${runId}-edit2`, edit(originalId, versions[2]!));
    return { roomId: room.id, roomName, originalId, versions };
  };
  const serverState = async (account: NodeWorkspaceAccount, roomId: string, originalId: string, allEditIds: readonly string[], expectedLiveIds: readonly string[]): Promise<EditHistoryServerProof> => {
    const token = await access(account);
    const encodedRoom = encodeURIComponent(roomId);
    for (const id of allEditIds) {
      const event = await request('v3', `/rooms/${encodedRoom}/event/${encodeURIComponent(id)}`, 'GET', token);
      if (expectedLiveIds.includes(id)) assert.deepEqual(event['content'], sentContents.get(id));
      else {
        assert.deepEqual(event['content'], {}, 'Removed edit has no live content');
        assert((event['unsigned'] as Record<string, unknown>)?.['redacted_because'], 'Removed edit is redacted');
      }
    }
    const liveIds: string[] = [];
    const seenTokens = new Set<string>();
    let pages = 0;
    let from: string | undefined;
    do {
      assert(++pages <= 10, 'Edit relations have bounded pagination');
      const query = new URLSearchParams({ dir: 'b', limit: '50', ...(from ? { from } : {}) });
      const page = await request('v1', `/rooms/${encodedRoom}/relations/${encodeURIComponent(originalId)}/m.replace/m.room.message?${query}`, 'GET', token);
      assert(Array.isArray(page['chunk']));
      for (const value of page['chunk']) {
        const event = value as Record<string, unknown>;
        if ((event['unsigned'] as Record<string, unknown> | undefined)?.['redacted_because']) continue;
        assert.equal(event['type'], 'm.room.message');
        assert.equal(event['sender'], account.userId);
        assert.deepEqual((event['content'] as Record<string, unknown>)?.['m.relates_to'], { rel_type: 'm.replace', event_id: originalId });
        assert(typeof event['event_id'] === 'string');
        assert.deepEqual(event['content'], sentContents.get(event['event_id']));
        liveIds.push(event['event_id']);
      }
      from = typeof page['next_batch'] === 'string' ? page['next_batch'] : undefined;
      if (from) {
        assert(!seenTokens.has(from), 'Relations cursor advances');
        seenTokens.add(from);
      }
    } while (from);
    assert.deepEqual(liveIds, [...expectedLiveIds].reverse(), 'Exact live edit order');
    return { removedRedacted: true, liveCount: liveIds.length, survivorMatches: true };
  };
  return { lifecycle, pixel5, serverState };
}
```

Implement `serverState` by paging the `v1` relations endpoint with `dir=b&limit=50` and any `next_batch`. Require each returned live event to have type `m.room.message`, sender `account.userId`, `m.relates_to.rel_type === 'm.replace'`, and the exact original target. Compare live IDs to the expected newest-first order with no duplicates or missing pages. GET each edit directly through `v3 /rooms/{room}/event/{edit}`: expected removed IDs must have redaction metadata and no live body/relation content; expected survivors must retain exact seeded fallback and `m.new_content`. Return only booleans and counts to the journey.

- [ ] **Step 4: Run fixture tests and Android typecheck GREEN.** Add a cancellation test that calls registered cleanup after the parent signal aborts and proves logout still occurs within its own bound. Use actual server ordering (`dir=b`, newest first) for the two-edit chain; fail on missing/extra pages, unexpected edit IDs, wrong target/sender, or stale redaction.
- [ ] **Step 5: Checkpoint fixture and tests.** Inspect their diff and leave them uncommitted for Task 9.

### Task 4: Observe semantics and geometry without renderer actions

**Files:** Create `e2e/android/edit-history-observer.mts`; create `scripts/edit-history-observer.spec.mjs`; extend `scripts/edit-history-migration.spec.mjs`.

**Interfaces:** Export `readEditHistory(client): Promise<EditHistorySnapshot>`, `readPixelGeometry(client): Promise<PixelGeometry>`, `readFontProfile(client): Promise<FontProfile>`, and pure `assertHistoryOrder`, `assertPlainDiff`, `assertFormattedDiff`, `assertPixelGeometry`, `assertScaledReading(baseline, scaled)`, and `assertNativeTarget(elements)`. Snapshots contain exact labels/text/markup fragments, toggle state, error/truncation counts, bounds and overflow; they contain no credentials.

`FontProfile` is `{ width: number; height: number; dpr: number; rootPx: number; inlineRootSize: string }`. `PixelGeometry extends FontProfile` adds `dialogWidth`, `dialogHeight`, `closeVisible`, `closeWidth`, `closeHeight`, `dialogScrollWidth`, `dialogClientWidth`, `revisionsVisible`, `revisionsScrollWidth`, `revisionsClientWidth`, `toggleVisible`, `removeLeft`, `removeRight`, and `removeUnobstructed` (number/boolean as named). Reject missing or non-finite measurements rather than supplying defaults.

- [ ] **Step 1: Write RED pure-predicate tests.** Start with valid three-row and formatted snapshots; mutate order, `final`/`second`, `Mon`/`Fri` outside `strong`, stale `Fri`, toggle state, error/truncation count, 43.9px Close, 393.1px right edge, and scroll-width overflow. A zero/two-element target or one whose `unobstructedCenter` is false must reject. Each mutation rejects.

```js
expect(() => assertPixelGeometry({ ...valid, closeWidth: 43.9 })).toThrow();
expect(() => assertFormattedDiff({ ...formatted, strongInserted: [], outsideStrongInserted: ['Mon'] })).toThrow();
expect(() => assertHistoryOrder(['Original', 'Current version', 'Edited'])).toThrow();
expect(() => assertNativeTarget([{ visible: true, unobstructedCenter: false }])).toThrow();
expect(() => assertNativeTarget([{ visible: true }, { visible: true }])).toThrow();
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- edit-history-observer.spec.mjs`.** Expected: RED because the module is absent.
- [ ] **Step 3: Implement read-only snapshots and pure assertions.** Use `evaluateNative` only for queries and measurements. The source guard must reject `.click`, `.focus`, `.dispatchEvent`, `.scrollIntoView`, `scrollTop=`, root-style assignments, `Input.dispatchTouchEvent`, or navigation in observer/journey sources. Reading `document.documentElement.style.fontSize` is required to prove the root has no inline override.

```ts
export async function readEditHistory(client: AccountWorkspaceClient): Promise<EditHistorySnapshot> {
  const value = await evaluateNative(
    client.webview,
    `(() => {
    const root = document.querySelector('[data-testid="edit-history"]');
    const rows = [...(root?.querySelectorAll('.revision') ?? [])];
    return { visible: !!root && root.getBoundingClientRect().width > 0,
      rows: rows.map((row) => ({
        label: row.querySelector('.revision__label')?.textContent?.trim() ?? '',
        text: row.querySelector('.revision__text')?.textContent?.trim() ?? '',
        inserted: [...row.querySelectorAll('ins.diff-ins')].map((el) => el.textContent ?? ''),
        deleted: [...row.querySelectorAll('del.diff-del')].map((el) => el.textContent ?? ''),
        strongInserted: [...row.querySelectorAll('strong ins.diff-ins')].map((el) => el.textContent ?? ''),
        strongDeleted: [...row.querySelectorAll('strong del.diff-del')].map((el) => el.textContent ?? ''),
        strongText: [...row.querySelectorAll('strong')].map((el) => el.textContent ?? ''),
        removeCount: row.querySelectorAll('[data-testid="revision-remove"]').length,
      })),
      togglePressed: root?.querySelector('[data-testid="edit-history-toggle"]')?.getAttribute('aria-pressed') ?? null,
      errorCount: root?.querySelectorAll('[data-testid="edit-history-error"]').length ?? 0,
      truncatedCount: root?.querySelectorAll('[data-testid="edit-history-truncated"]').length ?? 0 };
  })()`,
  );
  assert(value && typeof value === 'object', 'Read-only history snapshot exists');
  return value as EditHistorySnapshot;
}
export function assertNativeTarget(elements: readonly AccountElement[]): AccountElement {
  assert.equal(elements.length, 1, 'One exact native target');
  const target = elements[0]!;
  assert(target.visible && target.unobstructedCenter && !target.disabled, 'Native target is visible, enabled and uncovered');
  assert(target.rect.width > 0 && target.rect.height > 0, 'Native target has a real box');
  return target;
}
export function assertScaledReading(baseline: FontProfile, scaled: PixelGeometry): void {
  assert.equal(scaled.width, baseline.width);
  assert.equal(scaled.height, baseline.height);
  assert.equal(scaled.dpr, baseline.dpr);
  assert.equal(scaled.inlineRootSize, '');
  assert(scaled.rootPx > baseline.rootPx && scaled.rootPx >= 24, 'Android font_scale must enlarge the real WebView root');
  assert(scaled.revisionsScrollWidth <= scaled.revisionsClientWidth, 'Large-text reading region must not overflow horizontally');
}
export function assertPixelGeometry(value: PixelGeometry): void {
  assert.equal(value.width, 393);
  assert.equal(value.height, 727);
  assert.equal(value.dpr, 2.75);
  assert(Math.abs(value.dialogWidth - 393) <= 1 && Math.abs(value.dialogHeight - 727) <= 1);
  assert(value.closeVisible && value.closeWidth >= 44 && value.closeHeight >= 44);
  assert(value.dialogScrollWidth <= value.dialogClientWidth);
  assert(value.toggleVisible && value.revisionsVisible);
  assert(value.removeUnobstructed && value.removeLeft >= 0 && value.removeRight <= 393);
}
```

`readFontProfile` measures `innerWidth/innerHeight/devicePixelRatio`, `getComputedStyle(document.documentElement).fontSize`, and `document.documentElement.style.fontSize` on any visible app screen. `readPixelGeometry` adds dialog and Close boxes from `getBoundingClientRect()`, dialog and `.revisions` `scrollWidth/clientWidth`, last Remove bounds and `elementFromPoint` exposure. Both return only finite numbers/booleans and fail if any required element is missing. The pure predicates use one-pixel fullscreen tolerance and exact 44px Close minima, then require Remove left ≥0 and right ≤393 after native scrolling.

- [ ] **Step 4: Run observer tests, focused migration guard and Android typecheck GREEN.** Assert read-only static guard catches injected DOM action and root-style/scroll-offset mutation strings.
- [ ] **Step 5: Checkpoint observer and tests.** Inspect their diff and leave them uncommitted for Task 9.

### Task 5: Implement the 46-record revision lifecycle stage

**Files:** Create `e2e/android/edit-history-journeys.mts`; extend `scripts/edit-history-migration.spec.mjs`.

**Interfaces:** `runRevisionLifecycle(context: StageContext): Promise<void>` consumes the contract, fixture seed and observer. `record(context, suffix, observation)` records exactly one validated assertion identity in source order; it throws on a duplicate or out-of-order identity. The runner calls it later in Task 7.

- [ ] **Step 1: Add RED guard tests for core action ownership and ordering.** Require native `client.login`, `tapCurrent`, and the exact dialog/Remove/confirm/close selectors; require `serverState` after each removal and a repaired timeline observation; reject DOM actions, missing server call, replaced `tapCurrent` with a fixed-point tap on the moving confirm overlay, duplicate selectors, and a record added without a passing assertion.

```js
function assertNativeRuntime(source) {
  expect(source).toContain('await client.tapCurrent(');
  expect(source).toContain('assertNativeTarget(await client.elements(');
  expect(source).toContain('await fixtures.serverState(');
  expect(source).not.toMatch(/\.(?:click|focus|scrollIntoView|dispatchEvent)\s*\(/u);
  expect(source).not.toMatch(/\.scrollTop\s*=(?!=)|documentElement\.style/u);
}
expect(journey).toContain('await client.tapCurrent(\'[data-testid="alert-confirm"]\')');
expect(journey).toContain('await fixtures.serverState(');
expect(() => assertNativeRuntime(journey.replace('await client.tapCurrent(', 'await client.tap('))).toThrow();
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- edit-history-migration.spec.mjs`.** Expected: RED because the journey is absent.
- [ ] **Step 3: Implement the stage with exact source-order records.** After fixture seeding, call `serverState` with both edits live to validate their wire content before any native removal. Then `client.reset(PIXEL_5_ACCOUNT_PROFILE)`, native login and Room navigation, use `rowSelector(seed.plain.originalId)` and the accessible marker. For each site in Task 1's `coreSites`, assert the exact source condition, then record that site's suffix once. Before native touch on a moving dialog/confirm overlay, require exactly one visible unobstructed target through `assertNativeTarget(await client.elements(selector))`; if a revision Remove is offscreen, reach it only through a bounded `client.swipeCurrent('.revisions', ...)` loop. Use native `tapCurrent` for toggle, close, Remove and nested `[data-testid="alert-confirm"]`. Observe the server after each confirmation and timeline after closing; never record server repair from dialog state alone.

```ts
const rowSelector = (eventId: string) => `.msg[data-mid=${JSON.stringify(eventId)}]`;
await fixtures.serverState(account, seed.roomId, seed.plain.originalId, seed.plain.editIds, seed.plain.editIds);
async function record(context: StageContext, suffix: string, proof: unknown): Promise<void> {
  const identity = editHistoryAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length]);
  context.records.push(identity);
  await context.client.record(identity, { assertion: identity, observation: proof });
}
await client.tapCurrent(`${rowSelector(seed.plain.originalId)} [data-testid="msg-edited"]`);
const remove = '[data-testid="edit-history"] .revision:last-child [data-testid="revision-remove"]';
for (let swipe = 0; swipe < 8; swipe++) {
  const [target] = await client.elements(remove);
  if (target?.visible && target.unobstructedCenter) break;
  const moved = await client.swipeCurrent('.revisions', { direction: 'increase-scroll-top' });
  assert(moved.afterScrollTop > moved.beforeScrollTop);
}
assertNativeTarget(await client.elements(remove));
await client.tapCurrent(remove);
const confirm = '[data-testid="alert-confirm"]';
assertNativeTarget(await client.elements(confirm));
await client.tapCurrent('[data-testid="alert-confirm"]');
// After native current-edit Remove + confirm:
const state = await fixtures.serverState(account, seed.roomId, seed.plain.originalId, seed.plain.editIds, [seed.plain.editIds[0]!]);
assert(state.removedRedacted && state.survivorMatches);
```

- [ ] **Step 4: Complete every core group and run static/unit gates GREEN.** Groups are source lines 232–273 (10 records), 279–292 (8), 299–316 (8), 321–382 (17), and 393–395 (3). Mutation tests must fail if the version order, diff, format, toggle, current/last removal, server state, timeline repair, marker, or redacted row is weakened. Run focused guard, fixture/observer tests and Android typecheck.
- [ ] **Step 5: Checkpoint the tested core stage, not a claimed migration pass.** Inspect journey and guard changes; leave them uncommitted for Task 9. Do not close #743 or push yet.

### Task 6: Implement the 16-record Pixel 5 large-text stage

**Files:** Continue `e2e/android/edit-history-journeys.mts`; extend `scripts/edit-history-migration.spec.mjs` and `scripts/edit-history-observer.spec.mjs`.

**Interfaces:** `runPixel5LargeText(context: StageContext): Promise<void>` consumes the Pixel seed and `FontScaleLease`; it records Task 1's 16 Pixel identities in source order. Additional scale/profile/native-swipe receipts are fail-closed gates, not parity-record substitutes.

- [ ] **Step 1: Add RED tests/guards.** Require exact 393×727/DPR 2.75 before and after scale, no inline root font size, a strictly larger computed root at least 24px, native `swipeCurrent('.revisions', ...)`, unchanged-offset rejection, exposed Remove bounds, and `lease.restore()` in `finally`. Remove or weaken any one requirement in a mutation and expect a failure.

```js
expect(() => assertScaledReading(baseline, { ...validScaled, rootPx: 16 })).toThrow();
expect(() => assertScaledReading(baseline, { ...validScaled, inlineRootSize: '24px' })).toThrow();
expect(() => assertPixelGeometry({ ...valid, removeRight: 393.1 })).toThrow();
```

- [ ] **Step 2: Run focused guard/observer tests.** Expected: RED on missing Pixel stage and scale/scroll behavior.
- [ ] **Step 3: Implement baseline and large-text phases.** Seed the helper's long versions, native-open history, record three helper-expanded and nine baseline geometry identities, close natively, call `device.setFontScale('1.5')`, then `client.relaunch(PIXEL_5_ACCOUNT_PROFILE)` and native-reopen Room/history. Measure root/viewport/DPR; use a bounded native-swipe loop until the trailing Remove is unobstructed and fully in the viewport; record four large-text identities. Restore in `finally`, relaunch and verify baseline when not cancelled, and aggregate restoration with stage failure.

```ts
const baseline = await readPixelGeometry(client);
const initialFont = await readFontProfile(client);
let scale: FontScaleLease | undefined;
let stageFailure: unknown;
try {
  scale = await client.device.setFontScale('1.5');
  await client.relaunch(PIXEL_5_ACCOUNT_PROFILE);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.tapCurrent('.channel', { text: seed.roomName });
  await client.tapCurrent(`${rowSelector(seed.originalId)} [data-testid="msg-edited"]`);
  let scaled = await readPixelGeometry(client);
  assertScaledReading(baseline, scaled);
  for (let attempt = 0; attempt < 8 && !scaled.removeUnobstructed; attempt++) {
    const proof = await client.swipeCurrent('.revisions', { direction: 'increase-scroll-top' });
    assert(proof.afterScrollTop > proof.beforeScrollTop);
    scaled = await readPixelGeometry(client);
  }
  assertPixelGeometry(scaled);
} catch (error) {
  stageFailure = error;
} finally {
  const cleanupFailures: unknown[] = [];
  try {
    await scale?.restore(); // lease verifies the exact Android settings readback
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (scale && !client.signal.aborted) {
    try {
      await client.relaunch(PIXEL_5_ACCOUNT_PROFILE);
      const restored = await readFontProfile(client);
      assert.equal(restored.rootPx, initialFont.rootPx);
      assert.equal(restored.inlineRootSize, initialFont.inlineRootSize);
      assert.equal(restored.width, initialFont.width);
      assert.equal(restored.height, initialFont.height);
      assert.equal(restored.dpr, initialFont.dpr);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (stageFailure !== undefined && cleanupFailures.length) throw new AggregateError([stageFailure, ...cleanupFailures], 'Pixel stage and font restoration failed');
  if (stageFailure !== undefined) throw stageFailure;
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Pixel font restoration failed');
}
```

- [ ] **Step 4: Run focused guard/observer tests and Android typecheck GREEN.** Require 16 unique Pixel records and all additional scale/cleanup gates; do not claim the installed-Android run yet.
- [ ] **Step 5: Checkpoint the tested Pixel stage.** Inspect journey and tests; leave them uncommitted for Task 9.

### Task 7: Add failure-safe run reporting and secret-safe diagnostics

**Files:** Continue `e2e/android/edit-history-journeys.mts`; create `e2e/android/edit-history-artifacts.mts`; create `scripts/edit-history-artifacts.spec.mjs`; extend `scripts/edit-history-migration.spec.mjs`.

**Interfaces:** `scrubEditHistoryArtifacts(output, secrets): Promise<void>` redacts text and removes raster files even if secrets were not collected; `scanEditHistoryArtifacts(output, secrets): Promise<void>` rejects raw/JSON-escaped secrets, bearer strings, native-storage payloads and residual raster files. `secrets` is a `Readonly<Record<string, string>>` containing account username/user ID/password, room names and seeded event IDs, never the closure-private REST token. The runner emits `journeys.json` with `expectedStages: 2`, `expectedUniqueAssertions: 62`, `expectedAssertionRecords: 62`, `attempt: 1`, `retries: 0`, stage records and provenance. A `publication-safe` marker is written only after the final scrub and scan pass.

- [ ] **Step 1: Write RED artifact tests.** Test raw/escaped password, access token, `Bearer`, unredacted `SecureStorage`/`Preferences`, PNG with no secrets collected, and a scrub failure; each must reject. A clean text report must pass.

```js
await writeFile(join(output, 'early-failure.png'), Buffer.from([0x89, 0x50]));
await expect(scanEditHistoryArtifacts(output, {})).rejects.toThrow('raster');
await scrubEditHistoryArtifacts(output, {});
await expect(access(join(output, 'early-failure.png'))).rejects.toThrow();
await writeFile(join(output, 'leak.json'), '{"authorization":"Bearer syth_test"}');
await expect(scanEditHistoryArtifacts(output, {})).rejects.toThrow('Authorization');
```

- [ ] **Step 2: Run `pnpm nx run scripts:test -- edit-history-artifacts.spec.mjs`.** Expected: RED because the module is absent.
- [ ] **Step 3: Implement redaction scan and run ownership.** Register scan first, scrub second, device cleanup third, then fixture cleanups; reverse cleanup retires fixtures, closes device, scrubs, then scans. Register a started-stage row before entering its try block. On every exit, capture pass/failure if safe, close UI/client, restore font scale, clear app data, update stage status from all failures, and write the report. Wrap namespace cleanups so a post-stage device/scrub/scan failure marks the run and last stage failed before rethrowing; a provisional pass cannot remain an accepted artifact. Scan creates `publication-safe` only after success; CI requires that marker before upload.

```ts
import assert from 'node:assert/strict';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { nativeStorageMethodDataIsRedacted, redactMaestroArtifacts } from './maestro-session.mts';
const raster = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
export async function scrubEditHistoryArtifacts(output: string, secrets: Readonly<Record<string, string>>): Promise<void> {
  await redactMaestroArtifacts(output, secrets, true);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const path = join(output, entry.name);
    if (entry.isDirectory()) await scrubEditHistoryArtifacts(path, secrets);
    else {
      assert(entry.isFile(), 'Diagnostics entry is a regular file');
      if (raster.has(extname(path).toLowerCase())) await unlink(path);
    }
  }
}
export async function scanEditHistoryArtifacts(output: string, secrets: Readonly<Record<string, string>>): Promise<void> {
  const values = Object.values(secrets)
    .filter(Boolean)
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const path = join(output, entry.name);
    if (entry.isDirectory()) {
      await scanEditHistoryArtifacts(path, secrets);
      continue;
    }
    assert(entry.isFile() && !raster.has(extname(path).toLowerCase()), 'No unsafe diagnostic raster');
    const value = await readFile(path, 'utf8');
    for (const secret of values) assert(!value.includes(secret), 'No raw credential or identifier in diagnostics');
    assert(!/\bBearer\s+\S+|\bsyt_[A-Za-z0-9._~-]+/u.test(value), 'Authorization absent');
    assert(nativeStorageMethodDataIsRedacted(value, 'Preferences'));
    assert(nativeStorageMethodDataIsRedacted(value, 'SecureStorage'));
  }
}
const report = { status: 'running' as 'running' | 'passed' | 'failed', expectedStages: 2, expectedUniqueAssertions: 62, expectedAssertionRecords: 62, attempt: 1, retries: 0, stages };
let scrubFailed = false;
const markCleanupFailure = async (label: string): Promise<void> => {
  report.status = 'failed';
  const last = stages.at(-1);
  if (last) {
    last.status = 'failed';
    last.failureCount++;
    last.error = `Cleanup failed: ${label}`;
  }
  await writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
};
const guardedCleanup = (label: string, work: () => Promise<void>) =>
  matrixResources.cleanup(label, async () => {
    try {
      await work();
    } catch (error) {
      await markCleanupFailure(label);
      throw error;
    }
  });
guardedCleanup('Scan edit-history diagnostics', async () => {
  assert(!scrubFailed, 'A failed scrub cannot authorize artifact publication');
  await scanEditHistoryArtifacts(output, secrets);
  await writeFile(join(output, 'publication-safe'), 'scanned\n');
});
guardedCleanup('Scrub edit-history diagnostics', async () => {
  try {
    await scrubEditHistoryArtifacts(output, secrets);
  } catch (error) {
    scrubFailed = true;
    throw error;
  }
});
const device = await openMaestroDevice({ workspaceRoot: session.workspaceRoot, artifactDirectory: output, signal, serial: process.env['TRINITY_ANDROID_SERIAL'] });
guardedCleanup('Edit-history Android device', () => device.close());
```

- [ ] **Step 4: Run artifact tests, migration guard and Android typecheck GREEN.** Add negative controls that delete scan registration or skip setting restoration and prove the guard fails. A failed scrub or scanner must leave no `publication-safe` marker. Check `journeys.json` never contains raw event IDs, passwords, bearer values or fixture room names.
- [ ] **Step 5: Checkpoint the tested runner/artifact boundary.** Inspect the three-file diff and leave it uncommitted for Task 9.

### Task 8: Register the suite and run the installed Android gate

**Files:** Modify `e2e/android/project.json`, `package.json`, `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`, `.github/workflows/ci.yml`, `e2e/android/MIGRATION.md`, `scripts/e2e-suite-registry.spec.mjs`, and `scripts/edit-history-migration.spec.mjs`.

**Interfaces:** `android.edit-history` is a required current suite; `trinity-e2e-android:edit-history` is uncached/serial and holds `android-avd` + `synapse`. CI shard 2 runs it immediately after message-action-sheet and uploads `android-edit-history` diagnostics only if started and scrub/scan produced `publication-safe`.

- [ ] **Step 1: Add RED wiring tests.** Require project/package/registry/command/CI/docs entries to agree on suite ID, entrypoint, source files, resources, shard order, bounded wrapper and started-plus-safe artifact path. Require predecessor retention and no duplicate suite registration.

```js
expect(project.targets['edit-history'].cache).toBe(false);
expect(project.targets['edit-history'].parallelism).toBe(false);
expect(workflow.indexOf('trinity-e2e-android:edit-history')).toBeGreaterThan(workflow.indexOf('trinity-e2e-android:message-action-sheet'));
expect(workflow).toContain("edit-history-started == 'true'");
expect(workflow).toContain("edit-history-safe == 'true'");
```

- [ ] **Step 2: Run focused migration and registry guards.** Expected: RED because the target and workflow entries are absent.
- [ ] **Step 3: Add target, registry and CI wiring.** Match the preceding target's `build-prebuilt` dependency and manifest verification. Set Node timeout to 2,400,000ms and CI wrapper to 2,700,000ms; preserve the shard's existing job timeout and do not suppress a budget failure. Add the started marker before invoking the target and a post-target safety marker check; diagnostic upload requires both markers. A failed scrub/scan must prevent artifact upload, including on an early failed stage.

```json
"edit-history": {
  "cache": false,
  "parallelism": false,
  "dependsOn": [{ "projects": ["trinity-android"], "target": "build-prebuilt" }],
  "outputs": ["{workspaceRoot}/dist/.playwright/trinity-e2e-android"],
  "executor": "nx:run-commands",
  "options": {
    "command": "TRINITY_E2E_PROJECT=trinity-e2e-android TRINITY_E2E_PREBUILT_WWW=1 node scripts/web-bundle-manifest.mjs verify dist/web-bundle-manifest.json www && TRINITY_E2E_PROJECT=trinity-e2e-android TRINITY_E2E_PREBUILT_WWW=1 node e2e/support/run-node.mts --suite=android.edit-history --timeout-ms=2400000 --entrypoint=e2e/android/edit-history-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse",
    "cwd": "{workspaceRoot}"
  }
}
```

```ts
// Add to e2e/registry/suites/runners.mts beside android.message-action-sheet:
{
  id: 'android.edit-history', environment: 'android',
  capabilities: ['conversations'], contractTypes: ['host', 'journey'],
  runner: 'node-test', currentTarget: 'trinity-e2e-android:edit-history',
  targetProject: 'trinity-e2e-android',
  prerequisites: ['android-avd', 'android-sdk', 'docker', 'java-21', 'kvm', 'maestro', 'node-24'],
  availabilityPolicy: 'required', ciTier: 'pull-request', cachePolicy: 'never',
  serializationKeys: ['android-avd', 'synapse'], timeoutClass: 'host',
  canonicalScript: 'e2e:android:edit-history',
  currentArtifactRoot: artifactRoot('trinity-e2e-android'),
  targetArtifactRoot: artifactRoot('trinity-e2e-android'),
  sourceEntrypoints: ['e2e/android/edit-history-journeys.mts',
    'e2e/android/edit-history-contract.mts', 'e2e/android/edit-history-fixture.mts',
    'e2e/android/edit-history-observer.mts', 'e2e/android/edit-history-artifacts.mts'],
}
```

```bash
# In the existing shard-2 Android steps, after message-action-sheet:
if [ "${{ matrix.shard }}" = "2" ]; then echo 'edit-history-started=true' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 2700000 -- pnpm nx run trinity-e2e-android:edit-history; fi
# Separate always-running, started-gated check after the target:
if find dist/.playwright/trinity-e2e-android -type f -name publication-safe -path '*/android.edit-history/*' -print -quit | rg -q .; then echo 'edit-history-safe=true' >> "$GITHUB_OUTPUT"; fi
# Artifact upload condition: !cancelled() && steps.android.outputs.edit-history-started == 'true' && steps.edit-history-artifact-gate.outputs.edit-history-safe == 'true'
# Artifact surface: android-edit-history
# Artifact path: dist/.playwright/trinity-e2e-android/*/android.edit-history/**
```

- [ ] **Step 4: Document exact coverage and run focused gates GREEN.** `MIGRATION.md` records 46+16 identities, the desktop exclusion, Matrix/native/WebView ownership, real font-scale proof and restore, local commands, diagnostics and predecessor retention. Run `pnpm nx run scripts:test -- edit-history-migration.spec.mjs e2e-suite-registry.spec.mjs edit-history-artifacts.spec.mjs`, `pnpm nx run scripts:test`, and `pnpm nx run trinity-e2e-android:typecheck`.
- [ ] **Step 5: Run one installed-Android development attempt before the acceptance run.** Rebuild production `www` and its manifest with `pnpm nx run trinity:build` then `pnpm nx run scripts:record-renderer`; run `pnpm nx run trinity-e2e-android:edit-history --skipNxCache` alone. Fix the owning boundary on failure and repeat, preserving first-failure diagnostics. Keep wiring and docs uncommitted until Task 9.

### Task 9: Verify the unchanged batch, publish, audit hosted evidence

**Files:** No new files expected. If a validation failure requires a fix, return to its owning task, add a regression test, repeat local acceptance at the new revision, and update `MIGRATION.md` evidence.

- [ ] **Step 1: Run the unchanged browser predecessor sequentially.** Use `pnpm nx run trinity-e2e-browser:e2e -- conversations/message-edit-history.spec.mts --workers=1 --retries=0`; require 3/3 definitions on first attempt, then recheck all three pinned hashes. Do not run this concurrently with the Android/Synapse target.
- [ ] **Step 2: Rebuild immutable production renderer and verify native provenance.** After the browser run, use `pnpm nx run trinity:build`, `pnpm nx run scripts:record-renderer`, and manifest verification before Android. Do not reuse the browser run's development `www` output as the APK renderer.
- [ ] **Step 3: Run three consecutive unchanged installed-Android first attempts.** Use `pnpm nx run trinity-e2e-android:edit-history --skipNxCache` three times sequentially without source/fixture edits; require 2/2 stages and 62/62 records, attempt 1/retries 0, exact built/installed APK digest, Pixel 5 profile, native and server receipts, font setting readback, no secrets/rasters and clean resource teardown each time.
- [ ] **Step 4: Run repository validation and review.** Run focused guards and negative controls, `pnpm nx run scripts:test`, `pnpm nx run trinity-e2e-android:typecheck`, `pnpm test`, `pnpm nx run-many -t typecheck`, `pnpm lint`, `pnpm stylelint`, `pnpm format:check`, `pnpm build`, and `pnpm architecture:check`. Report command, exit status, unavailable checks and artifacts separately; a unit pass does not stand in for type safety or installed layout. Review the complete diff, fix findings at their owner, and rerun changed gates.
- [ ] **Step 5: Commit the verified batch and push only the authorized branch.** Stage only #743 files, inspect staged diff and `git diff --cached --check`, then make one implementation-batch commit. Push `test/676-android-sidebar-filter`; do not force-push, merge, or alter unrelated untracked plans.
- [ ] **Step 6: Audit the original hosted run, not a replacement rerun.** Check original-attempt Android dedicated artifact, browser and production-renderer artifacts, merge SHA, built/installed APK hash, 2/2 stages, all 62 identities, retry zero, server and native receipts, redaction and cleanup. If shard 2 exceeds the job's 180-minute budget, preserve the failure and move this suite to a separately bounded Android shard/job with registry and started-and-safety-gated diagnostics, then repeat local/hosted acceptance at the revised commit; do not increase retries or silently accept a cancelled shard.
- [ ] **Step 7: Publish evidence after it exists.** Add links, commands, statuses and artifact IDs to #743, #660, #653 and PR #677. Close #743 only after its original-attempt hosted evidence and review pass; leave #744 blocked until then. PR #677 stays draft/open and unmerged.
