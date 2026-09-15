# Android Room Address Lifecycle Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one installed-Android Maestro/Node replacement for the canonical Room address add, primary-address, cancel/remove, and rejected-add draft-retention definition while keeping the Playwright predecessor enabled.

**Architecture:** Add a dedicated one-stage `android.room-address-lifecycle` suite using the existing installed APK, desktop WebView profile, `AccountWorkspaceClient`, and finite Matrix fixtures. Maestro owns every product interaction; CDP is limited to read-only observations and one exact first-request transport fault for the rejected alias. The fixture API observes directory and canonical-alias state without exposing credentials, and the suite records one artifact per inherited or direct assertion identity.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Android WebView/CDP observation and Fetch interception, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

**Spec:** https://github.com/quwisky/trinity-matrix-client/issues/715

## Global Constraints

- Base all work on consolidated prerequisite head `7864731f2464b1c452ead0fb8fa0c7ad99bc5f5b`; do not publish until #714 has accepted original-attempt hosted Android evidence.
- Preserve `e2e/browser/journeys/room-administration/room-members-and-addresses.spec.mts` byte-for-byte at SHA-256 `f306f5bfffca9f7a476966d7d2ff678a227fa7b2fae6e2f4934fb46c6c218ff5`.
- Preserve `e2e/browser/support/room-settings-journey.mts` byte-for-byte at SHA-256 `bc759b432e2880d8c93de8f6b31fc891d0d156f6944b1c2ce031d56c2a4420a7`.
- Preserve `e2e/support/app.mts` byte-for-byte at SHA-256 `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`.
- Own the 15 direct `expect` sites on definition lines 439, 448, 457, 463, 473, 477, 480, 496, 499, 501, 509, 510, 511, 530, and 535 plus the `openRoom` and `openSettingsTab` helper sites: exactly 17 unique identities.
- Use `DESKTOP_ACCOUNT_PROFILE` (`1280x720`, non-mobile, non-touch, scale factor 1) because the canonical definition uses the default desktop viewport.
- REST may create and observe finite fixtures. CDP may observe and fail the first exact retry-alias `PUT`; neither may click, focus, submit, navigate, or mutate product DOM/application state.
- Preserve one attempt, zero retries, serialized `android-avd` and `synapse` resources, renderer/APK/profile provenance, bounded teardown, and secret redaction.
- Keep the Playwright predecessor enabled. Never merge PR #677.

---

### Task 1: Pin source shape and exact parity ownership

**Files:**

- Create: `scripts/room-address-lifecycle-migration.spec.mjs`
- Create: `e2e/android/room-address-lifecycle-contract.mts`

**Interfaces:**

- Produces `ROOM_ADDRESS_LIFECYCLE_SOURCES` with exact definition/helper spans.
- Produces `roomAddressLifecycleHelperAssertions`, `roomAddressLifecycleDirectAssertions`, `roomAddressLifecycleAssertions`, and `RoomAddressLifecycleAssertion`.
- Direct identities, in source order: `address.panel-visible`, `address.row-visible`, `address.directory-resolves`, `address.primary-visible`, `address.canonical-state`, `address.settings-within-viewport`, `address.primary-toast-hidden`, `address.remove-joining-effect`, `address.remove-room-retained`, `address.cancel-keeps-row`, `address.row-removed`, `address.directory-removed`, `address.canonical-cleared`, `address.rejected-toast-visible`, `address.retry-draft-retained`.
- Helper identities: `address.room-timeline-visible`, `address.addresses-panel-visible`.

- [x] **Step 1: Write the failing source-shape test**

Add a Vitest contract that hashes all three sources, pins definition lines 403–536, helper lines 36–44 and 228–248, counts exactly 15+1+1 expectation sites, and requires exact source mappings:

```js
expect(definition[402]).toContain("test('an admin adds a room address and makes it the main one'");
expect(definition[535]).toBe('  });');
expect(expectSites(definition, 403, 536)).toBe(15);
expect(expectSites(openRoom, 36, 44)).toBe(1);
expect(expectSites(openSettingsTab, 228, 248)).toBe(1);
```

- [x] **Step 2: Require the stable contract and one desktop stage**

Require all 17 ordered identities, in-module 15/2/17 count assertions, uniqueness, a single `DESKTOP_ACCOUNT_PROFILE` case, all 17 `assertions.<key>` references, and no raw identity literals in the journey.

- [x] **Step 3: Require interaction, observation, and lifecycle boundaries**

Require native `fill`, `focused`, `key('enter')`, `tapCurrent`, `alert-cancel`, and keyboard-confirmation calls; exact selectors and messages; finite account/Room setup; directory/canonical observations; exact transport target/outcome; pass/fail capture; device/WebView cleanup; redaction; registry/CI wiring; and predecessor retention. Reject DOM clicks/focus/submission/navigation and product mutations with the established forbidden-mutation expressions.

- [x] **Step 4: Verify RED**

Run: `pnpm nx test scripts -- room-address-lifecycle-migration.spec.mjs`

Expected: FAIL because both the contract and journey are absent.

- [x] **Step 5: Add the minimal contract module**

```ts
export const roomAddressLifecycleAssertions = {
  ...roomAddressLifecycleHelperAssertions,
  ...roomAddressLifecycleDirectAssertions,
} as const;
export type RoomAddressLifecycleAssertion = (typeof roomAddressLifecycleAssertions)[keyof typeof roomAddressLifecycleAssertions];
assert.equal(Object.values(roomAddressLifecycleDirectAssertions).length, 15);
assert.equal(Object.values(roomAddressLifecycleHelperAssertions).length, 2);
assert.equal(Object.values(roomAddressLifecycleAssertions).length, 17);
assert.equal(new Set(Object.values(roomAddressLifecycleAssertions)).size, 17);
```

- [x] **Step 6: Re-run the focused contract**

Expected: remain red only for the missing fixture/fault/journey/registration requirements.

### Task 2: Add exact canonical-state and directory-fault support

**Files:**

- Modify: `e2e/android/account-workspace-fixtures.mts`
- Modify: `scripts/account-workspace-fixtures.spec.mjs`
- Modify: `e2e/android/matrix-http-fault.mts`
- Modify: `scripts/matrix-http-fault.spec.mjs`

**Interfaces:**

- Extends `WorkspaceRoomStateEventType` with `'m.room.canonical_alias'`; existing `roomState(...)` then returns `{ alias }` or `{}` for the canonical state event.
- Adds `MatrixRoomAliasTarget { readonly alias: string }`.
- Extends `MatrixHttpFaultOptions` with `{ kind: 'room-alias'; alias: string; status: number; responseError?: string }`.
- Adds `isMatrixRoomAliasRequest(value, target): boolean`, matching only exact `PUT /_matrix/client/<version>/directory/room/<encoded-alias>` requests.

- [x] **Step 1: Add failing canonical-state fixture coverage**

Exercise `fixtures.roomState(owner, '!room:localhost', 'm.room.canonical_alias')`, require the authenticated encoded GET path, `{ alias: '#address:localhost' }` parsing, and token-free returned/serialized evidence.

- [x] **Step 2: Add failing exact alias matcher coverage**

```js
const target = { alias: '#retry:localhost' };
expect(
  isMatrixRoomAliasRequest(
    {
      request: {
        method: 'PUT',
        url: 'https://localhost/_matrix/client/v3/directory/room/%23retry%3Alocalhost',
      },
    },
    target,
  ),
).toBe(true);
```

Reject GET, wrong alias, missing alias, extra segments, non-Matrix paths, malformed encoding, and prefix/suffix aliases.

- [x] **Step 3: Add failing first-request fault coverage**

Install `{ kind: 'room-alias', alias: '#retry:localhost', status: 500, responseError: 'retry me' }`; emit adjacent and exact requests; require the first exact request fulfilled with HTTP 500 and the exact Matrix JSON body, adjacent requests continued, a later exact request continued, and `attempts === 2`.

- [x] **Step 4: Verify focused RED**

Run: `pnpm nx test scripts -- account-workspace-fixtures.spec.mjs matrix-http-fault.spec.mjs`

Expected: FAIL for unsupported canonical-alias typing and missing alias-fault matcher/options.

- [x] **Step 5: Implement the narrow fixture and fault extensions**

```ts
export function isMatrixRoomAliasRequest(value: unknown, target: MatrixRoomAliasTarget): boolean {
  const request = fetchRequest(value);
  if (!request || request.method !== 'PUT') return false;
  const match = new URL(request.url).pathname.match(/^\/_matrix\/client\/[^/]+\/directory\/room\/([^/]+)\/?$/);
  return !!match && decodeURIComponent(match[1]!) === target.alias;
}
```

Route alias options through `fetchPattern()` and `matchesFaultRequest()` without changing invite, join, room-state, create-room, delay, or outcome behavior.

- [x] **Step 6: Re-run focused tests green**

Run: `pnpm nx test scripts -- account-workspace-fixtures.spec.mjs matrix-http-fault.spec.mjs`

Expected: PASS with the updated exact counts.

### Task 3: Implement the faithful installed-Android journey

**Files:**

- Create: `e2e/android/room-address-lifecycle-journeys.mts`

**Interfaces:**

- Consumes all Task 1 identities, `DESKTOP_ACCOUNT_PROFILE`, `createAccountFixtures`, `installFirstMatrixHttpFailure`, and the existing `AccountWorkspaceClient` native actions.
- Produces one case, `id: 'address-lifecycle'`, and `journeys.json` with `expectedStages: 1`.

- [x] **Step 1: Add observation helpers that always record evidence**

Implement `observedElements(...)`, `observedServerValue(...)`, `focusByNativeTab(...)`, and `exactFeedbackDuringNativeAction(...)`. Each helper must record success and last observation, record diagnostic error state before rethrow, respect `client.signal`, and use only read-only `evaluateNative` sampling.

- [x] **Step 2: Create finite setup and enter Room Addresses natively**

Create one owner and one private Room with invocation-unique name and `localpart = \`addr-${resources.aliasLocalpart('ral')}\``. Log in, tap `rail-rooms`, open the exact `.channel`, record `roomTimelineVisible`, tap the desktop `open-room-settings`action, tap`room-settings-tab-addresses`, record `addressesPanelVisible`, and record `panelVisible`on`room-aliases`.

- [x] **Step 3: Add the alias and prove UI plus directory state**

Fill `room-alias-input`, assert it is focused, press native Enter, prove one visible `room-alias` containing the exact alias, and poll `fixtures.resolveRoomAlias(owner, alias)` until it equals `room.id`. Record the exact alias and room ID without tokens.

- [x] **Step 4: Set primary and prove canonical/geometry/toast outcomes**

Use native Tab until `room-alias-set-main` is focused, press Enter, prove `room-alias-main` text `Primary`, and poll canonical state until `state?.alias === alias`. Observe and record settings geometry with this exact predicate:

```ts
surface.right <= viewport.width;
```

Then poll the exact primary-address toast beneath `[aria-label="Notifications alt+T"]` until its element count is zero and record the absence.

- [x] **Step 5: Prove cancellation and confirmed removal**

Tap `room-alias-remove`; prove `alert-surface` contains the exact joining/linking sentence and `This does not delete the Room.`; tap `alert-cancel`; prove the exact row remains. Tap remove again, focus `alert-confirm` with native Tab, press Enter, then prove the row absent, directory resolution undefined, and canonical content has no string `alias`.

- [x] **Step 6: Inject one exact rejected add and retain the draft**

Install the fault before input using:

```ts
const fault = await installFirstMatrixHttpFailure(client.webview, {
  kind: 'room-alias',
  alias: retryAlias,
  status: 500,
  responseError: 'retry me',
});
```

Fill the retry localpart, assert focus, and press Enter inside `exactFeedbackDuringNativeAction`; require exact `Could not add ${retryAlias}.` feedback. Await one exact transport attempt and a first outcome with `responseStatus === 500` and `bodyMatchesInjected === true`; include that transport evidence in the rejected-toast record. The pinned Room-alias component reports the rejection through the exact toast rather than the shared console diagnostic, so do not require `handlerReported`. Close the controller in `finally`, then prove the input value remains the exact retry localpart.

- [x] **Step 7: Preserve one-attempt diagnostics and teardown**

Use the established suite harness: install the built APK once; reset to `DESKTOP_ACCOUNT_PROFILE`; record all 17 identity files; capture `passed` or `failed`; write stage status/duration/failure count; redact account passwords; close WebView/device and clean Matrix resources on every exit.

- [x] **Step 8: Re-run the focused migration contract green**

Run: `pnpm nx test scripts -- room-address-lifecycle-migration.spec.mjs account-workspace-fixtures.spec.mjs matrix-http-fault.spec.mjs`

Expected: journey/fixture/fault requirements pass; only registration requirements may remain red.

### Task 4: Register the suite, hosted artifact, and migration ledger

**Files:**

- Modify: `e2e/android/project.json`
- Modify: `package.json`
- Modify: `e2e/registry/commands.mts`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Modify: `scripts/ci-workflow.spec.mjs`
- Modify: `e2e/android/MIGRATION.md`

**Interfaces:**

- Produces Nx target `trinity-e2e-android:room-address-lifecycle` and script `e2e:android:room-address-lifecycle`.
- Produces suite ID `android.room-address-lifecycle`, source entrypoint `e2e/android/room-address-lifecycle-journeys.mts`, and serialized resources `android-avd` plus `synapse`.
- Adds the suite to Android shard 3 after `room-roster-live-authority` and before `member-moderation`, with started-only artifact surface `android-room-address-lifecycle`.

- [x] **Step 1: Add failing registry/workflow assertions**

Require the target/script/entrypoint, exact suite ID, no-cache one-attempt runner, resource declarations, bounded target and host timeouts, shard ordering, started flag, exact report path `android.room-address-lifecycle/**`, artifact surface, and the corresponding Android upload-count increment.

- [x] **Step 2: Verify registration RED**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs room-address-lifecycle-migration.spec.mjs`

Expected: FAIL only for absent target/registry/workflow/ledger wiring.

- [x] **Step 3: Add target, script, registry, and hosted wiring**

Use `--timeout-ms=780000` in the Node runner, a `900000` hosted wrapper, and the same prebuilt-bundle verification as the neighboring one-stage Room suites. Do not change accepted suite budgets or composition.

- [x] **Step 4: Document exact parity and boundaries**

Add a #715 section to `e2e/android/MIGRATION.md` with the three pinned source hashes/spans, 15+2 ownership table, native/CDP/REST boundaries, command, artifact path, shard placement, deliberate controls, local stability gate, predecessor gate, and hosted acceptance gate.

- [x] **Step 5: Re-run focused registration tests green**

Run: `pnpm nx test scripts -- e2e-suite-registry.spec.mjs ci-workflow.spec.mjs room-address-lifecycle-migration.spec.mjs`

Expected: PASS.

### Task 5: Static gates, deliberate controls, runtime stability, and publication

**Files:**

- Modify checkboxes and acceptance evidence in this plan after each completed gate.
- Modify `e2e/android/MIGRATION.md` only to record immutable hosted acceptance evidence.

- [x] **Step 1: Run focused and full script tests**

Run the focused Task 2/4 commands, then `pnpm nx test scripts --skipNxCache`. Require every script test to pass.

- [x] **Step 2: Run static Nx and diff gates**

Run Android and browser typecheck/lint, `pnpm format:check`, `git diff --check`, inspect the task-owned diff, and confirm the three pinned sources retain their exact hashes.

- [x] **Step 3: Run at least five effective deliberate negative controls**

Temporarily mutate and restore one direct identity, one helper identity, an exact alias matcher into a broad directory matcher, one Maestro-native action into a DOM click/focus, and one exact removal/transport assertion into a weaker check. Each mutation must fail its intended guard; the restored tree must pass the focused contract.

- [x] **Step 4: Run three unchanged native first attempts sequentially**

Run `pnpm nx run trinity-e2e-android:room-address-lifecycle --skipNxCache` three times without source/build/input changes. For each run require one passed stage, 17 identity records, one suite attempt, zero retries, only completed native commands, exact UI/server/transport evidence, desktop renderer/APK/profile provenance, redaction, and clean Synapse/device teardown.

Local evidence: invocations `mu2b3egj-daac8db9-422e-4406-8a2d-8abd28277432`, `mu2b8uou-3a631fca-38ee-4d62-8d69-b3f63811ab62`, and `mu2bcxmz-a82f0291-e232-4e6f-ac75-7efdb41ddff0` each passed one original attempt with zero retries, 17 records, 14 successful native commands, the exact HTTP 500/body/toast/draft evidence, no secret matches, and clean teardown.

- [x] **Step 5: Run the exact unchanged Playwright predecessor**

Run the exact title from the pinned definition with `--workers=1 --retries=0`. Require one first-attempt pass and clean Synapse teardown.

Local evidence: invocation `mu2bhdmw-ff1ad4cd-390a-405e-8b49-1ce042dd62b4` passed the exact title once in 8.3 seconds with one worker, zero retries, and clean Synapse teardown.

- [ ] **Step 6: Review and publish only after #714 acceptance**

Require no unresolved review findings. Commit/push `test/715-android-room-address-lifecycle`, cherry-pick the verified commit onto `test/676-android-sidebar-filter`, re-run composed-tree script/static gates, and push the consolidated branch. Never merge PR #677.

- [ ] **Step 7: Audit original-attempt hosted evidence**

Require the exact consolidated source head, green hosted predecessor at retry 0, and immutable Android artifact proving one passed stage, all 17 identity records, completed native commands, exact UI/server/fault outcomes, desktop renderer/APK/profile provenance, redaction, and teardown. Record run/job/artifact IDs and digest in the ledger; update and close #715 only then; update #660, #653, and PR #677 without merging it.
