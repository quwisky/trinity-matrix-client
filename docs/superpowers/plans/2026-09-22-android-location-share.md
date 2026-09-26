# Android Location Share Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the canonical location-share journey to one deterministic installed-Android Maestro stage without weakening or removing its browser predecessor.

**Architecture:** A focused Vitest guard pins the exact predecessor and native-location fixture sources, enforces eight assertion identities, and rejects renderer-driven interaction or fabricated Matrix events. A bounded Android location adapter grants only Trinity's coarse/fine permissions, owns a pulsed GPS test provider at `40.7128,-74.006`, and restores every changed device setting. One Node/Maestro stage arranges only the Account and private Room via REST, performs login, Room navigation, tray selection, permission handling, and long-press natively, then uses Matrix REST and read-only renderer observations to prove the real server echo and UI result.

**Tech Stack:** TypeScript/Node test runner, Maestro CLI, Android adb, Matrix Client-Server REST, Playwright Android WebView observation, Vitest, Nx.

**Spec:** https://github.com/quwisky/trinity-matrix-client/issues/740

## Global Constraints

- Preserve `e2e/browser/journeys/conversations/location-share.spec.mts` at SHA-256 `86e673e5bd86e014a6f5ee4b4eb1da11eb979013b6629a452153367405e76244` and map lines 19-33 plus 38-97.
- Preserve `e2e/android/fixtures.mts` at SHA-256 `30f3489a4cac27685b03812e957a599d9ae4bef90985a55760f463fc702bfe8a` as the pinned native-location behavior source.
- Preserve `e2e/support/app.mts` at SHA-256 `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` and `e2e/support/account.mts` at SHA-256 `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
- Record exactly eight unique assertions: Room readiness, exact server echo, card visibility, coordinate text, OpenStreetMap destination, action-sheet readiness, Copy link presence, and Edit absence.
- Matrix REST may create the fresh Account and private Room and observe the event. It must not inject or manufacture an `m.location` event.
- Maestro must own login, Rooms-rail and Room navigation, composer tray and Location selection, any Android permission prompt, and the message-row long press.
- Drive a native GPS test provider at exactly latitude `40.7128` and longitude `-74.006`; never stub browser geolocation.
- The server echo must be the user's own `m.room.message` with `msgtype: m.location`, exact `geo_uri`, exact MSC3488 location URI, exact sender, and one event identity.
- Renderer access is read-only and may only observe the exact echoed row, card, coordinates, href, and action-sheet state.
- Use one stage, one attempt, zero retries, bounded waits, serialized `android-avd` and `synapse` resources, and started-only CI diagnostics.
- Teardown must stop the pulse and restore the GPS provider, shell mock-location app-op, and Trinity location permissions on success, failure, or cancellation.
- Remove raster diagnostics and redact credentials, Matrix identifiers, Room names, event IDs, and message/location data before publication.
- Keep PR #677 draft/open and unmerged.

## Review Focus

- A pre-existing GPS test provider or non-default shell mock-location mode must be restored rather than blindly removed/reset; test both baseline states in the adapter unit seam.
- A package permission that was already granted must remain granted, while a permission granted by this journey must be revoked; test mixed coarse/fine baselines.
- A duplicate or stale location event must not satisfy the echo proof; require exactly one event from the current user with the exact location content and retain its event ID.
- The location card and long-press must be scoped to that exact event row, so another visible location cannot satisfy the UI checks; mutation-test event-id scoping.
- Cleanup must run after setup, Maestro, Matrix, assertion, or cancellation failures; unit-test aggregate restoration and require cleanup registrations before mutating the device.

---

### Task 1: Focused migration contract in RED

**Files:**

- Create: `scripts/location-share-migration.spec.mjs`

**Interfaces:**

- Consumes: the four pinned sources, existing registry/workflow files, and eventual migration modules as source text.
- Produces: source-shape and mutation gates for the runtime, Android adapter, registration, documentation, and forbidden shortcuts.

- [ ] **Step 1: Write the source-pin and predecessor-ownership tests.** Pin all four SHA-256 values; extract predecessor lines 19-33 and 38-97; require the deterministic coordinates, private Room, native branch, five direct `expect` assertions, Room readiness, server-echo readiness, and action-sheet readiness for eight total records.
- [ ] **Step 2: Write runtime and adapter contract tests.** Require exact GPS coordinates, native permission/provider commands, baseline capture and restoration, a bounded pulse, one exact Matrix echo, event-row scoping, native product actions, read-only renderer checks, exact accounting, artifact redaction, and aggregate cleanup.
- [ ] **Step 3: Write negative controls.** Mutate coordinates, permission restoration, provider restoration, event type/sender/URI, event-id row selector, Copy/Edit checks, native action ownership, retry counts, scan calls, and teardown calls; every mutation must fail the contract helper.
- [ ] **Step 4: Write registration tests.** Require an uncached serial Nx target, canonical package/registry command, `android-avd` plus `synapse` serialization, shard-2 execution after link-preview, bounded wrapper, started marker, dedicated started-only diagnostics, ledger entry, and retained predecessor.
- [ ] **Step 5: Run RED.** Run `pnpm exec vitest run scripts/location-share-migration.spec.mjs`; expect failures only because the migration contract/runtime/registration do not yet exist.

### Task 2: Bounded native-location adapter

**Files:**

- Create: `e2e/android/native-location-adapter.mts`
- Test: `scripts/location-share-migration.spec.mjs`

**Interfaces:**

- Consumes: `MaestroDevice.adb(...args: string[]): Promise<string>`, application id `eu.qwky.trinity`, and `{ latitude: 40.7128, longitude: -74.006 }`.
- Produces: `openNativeLocationAdapter(device, applicationId, position, signal): Promise<NativeLocationAdapter>` where `NativeLocationAdapter` exposes `close(): Promise<void>` and sanitized setup/restoration proof.

- [ ] **Step 1: Extend RED tests for baseline permutations.** Use a fake adb seam to cover absent/present GPS provider, default/allow shell mock-location app-op, granted/denied coarse and fine permissions, command failure, and idempotent close.
- [ ] **Step 2: Capture exact baselines before mutation.** Read provider state, shell `android:mock_location` mode, and both package permission states without storing unrelated dumps.
- [ ] **Step 3: Configure only required native state.** Grant `ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION`, allow shell mock location, add/enable the GPS test provider when needed, inject the exact fix, and pulse it every second for late Capacitor listeners with no overlapping command.
- [ ] **Step 4: Restore in bounded reverse order.** Stop and await the pulse, restore or remove the provider to its baseline, restore the shell app-op mode, and revoke only permissions the adapter granted. Aggregate primary and cleanup failures.
- [ ] **Step 5: Run focused tests GREEN through the adapter boundary.** Run the focused Vitest file and Android typecheck; expect only journey/registration failures.

### Task 3: Exact location contract and Matrix observation

**Files:**

- Create: `e2e/android/location-share-contract.mts`
- Modify: `e2e/android/account-workspace-fixtures.mts`
- Test: `scripts/location-share-migration.spec.mjs`

**Interfaces:**

- Consumes: `createAccountFixtures(...)` and the exact Matrix Room/message schema.
- Produces: eight unique assertion IDs, exact source mappings/constants, `WorkspaceLocationEvent`, and `latestLocationEvents(account, roomId): Promise<readonly WorkspaceLocationEvent[]>` returning sanitized matching event facts only.

- [ ] **Step 1: Define the eight-identity contract.** Export source locations, exact latitude/longitude/coordinate text/geo URI/OSM matcher, and assert identity count and uniqueness at module load.
- [ ] **Step 2: Add a read-only location-event query.** Fetch a bounded latest Room message window and return only events whose type/msgtype are `m.room.message`/`m.location`, including event ID, sender, body, `geo_uri`, MSC3488 location URI, and asset type.
- [ ] **Step 3: Keep setup incapable of event injection.** The journey may call `account()` and `createRoom()` but must never call `sendMessage()` or a state/event insertion endpoint for the location.
- [ ] **Step 4: Add mutation tests.** Wrong type, sender, body, geo URI, MSC3488 URI, asset type, zero events, or two matching events must fail the runtime contract.
- [ ] **Step 5: Run focused tests and Android typecheck.** Expect only the absent journey/registration boundary to remain RED.

### Task 4: One native Maestro location-share stage

**Files:**

- Create: `e2e/android/location-share-journeys.mts`
- Test: `scripts/location-share-migration.spec.mjs`

**Interfaces:**

- Consumes: `openNativeLocationAdapter`, `AccountWorkspaceClient`, `createAccountFixtures`, `PIXEL_5_ACCOUNT_PROFILE`, and the location contract.
- Produces: one `android.location-share` Node stage with exactly eight assertion records and a secret-safe `journeys.json` receipt.

- [ ] **Step 1: Arrange only the Account and private Room.** Register the cleanup/scanner before mutation, create a fresh account and `private_chat` Room, record secrets for redaction, reset the installed app, and open the native-location adapter.
- [ ] **Step 2: Perform all product actions natively.** Login, tap the Rooms rail, open the exact Room, prove composer readiness, tap `composer-insert`, tap `insert-location`, and handle an Android permission prompt only if visible.
- [ ] **Step 3: Prove one real server echo.** Poll the bounded REST observer until exactly one current-user event matches exact `m.location`, body, `geo_uri`, MSC3488 URI, and asset type; retain its event ID and record the exact echo assertion once.
- [ ] **Step 4: Prove the exact rendered result read-only.** Scope to `[data-mid=<eventId>]`, require one visible `location-card`, exact text `40.71280, -74.00600`, and an OpenStreetMap href whose `mlat` is exactly `40.7128`.
- [ ] **Step 5: Prove native message actions.** Long-press that exact echoed row with the existing measured 750 ms native gesture, require the action-sheet surface and Copy link, and require zero Edit elements.
- [ ] **Step 6: Enforce accounting and teardown.** Persist started/passed/failed stage state, 8/8 unique records, attempt 1/retries 0, detach the WebView before restoring permissions (Android may kill the package on revoke), then close the location adapter before app/device teardown; redact then scan every retained artifact and reject raster files.
- [ ] **Step 7: Run focused tests and typecheck.** Expect only registration/ledger assertions to remain RED.

### Task 5: Nx, registry, hosted CI, and migration ledger

**Files:**

- Modify: `e2e/android/project.json`
- Modify: `e2e/registry/commands.mts`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/ci-workflow.spec.mjs`
- Modify: `e2e/android/MIGRATION.md`
- Test: `scripts/location-share-migration.spec.mjs`

**Interfaces:**

- Consumes: `e2e/android/location-share-journeys.mts` and shared Android CI shard 2.
- Produces: `trinity-e2e-android:location-share`, `e2e:android:location-share`, suite `android.location-share`, and diagnostic surface `android-location-share`.

- [ ] **Step 1: Add the uncached serial Nx target and package script.** Depend on the prebuilt Android APK, use the verified renderer, a 1,200,000 ms node timeout, and `--resource=android-avd --resource=synapse`.
- [ ] **Step 2: Register the canonical suite and command.** Set required current Android coverage, no cache, host timeout, exact source entrypoints, and both serialization keys.
- [ ] **Step 3: Add ordered shard-2 CI.** Execute immediately after link-preview through the 1,500,000 ms wrapper, set `location-share-started=true`, and upload its exact report path only when started and not cancelled.
- [ ] **Step 4: Extend workflow guards and the ledger.** Pin ordering, timeout, marker, surface/path, ownership boundaries, exact eight-record contract, redaction, teardown, predecessor coexistence, and hosted-evidence pending status.
- [ ] **Step 5: Run focused and full static gates.** Run the migration and CI workflow specs, `pnpm nx test scripts`, Android typecheck/lint, format check, docs check, and `git diff --check`.

### Task 6: Local runtime acceptance

**Files:**

- Modify: `e2e/android/MIGRATION.md` with measured evidence only.

**Interfaces:**

- Consumes: the fully registered local suite, production renderer, debug APK, Pixel 5 API 36 profile, and unchanged browser predecessor.
- Produces: three unchanged-input Android invocations, exact browser parity evidence, hashes, durations, and clean teardown scans.

- [ ] **Step 1: Build and verify production inputs.** Run production-renderer, verify its manifest, build the Android debug APK, and hash renderer manifest/APK/profile plus all pinned sources.
- [ ] **Step 2: Run Android three times sequentially.** Run `pnpm nx run trinity-e2e-android:location-share --skipNxCache` three times with unchanged inputs; require 1/1 stage, 8/8 records, attempt 1, retries 0, and exact GPS/event/card/action receipts each time.
- [ ] **Step 3: Audit every artifact.** Require no credentials, tokens, Matrix identifiers, Room/message/event/location secrets, authorization/cookie data, raster files, active pulse, changed provider/app-op/permission state, live application, or dirty worktree.
- [ ] **Step 4: Run the exact browser predecessor.** Use one worker and `--retries=0`; require the complete location-share definition to pass and recheck all pinned hashes.
- [ ] **Step 5: Re-run repository acceptance.** Run focused/full scripts, typecheck, lint, format, docs, production renderer/APK verification, and source pins; update the ledger with only observed evidence.

### Task 7: Review, commit, push, and hosted acceptance

**Files:**

- Modify: `e2e/android/MIGRATION.md` only for final hosted evidence.

**Interfaces:**

- Consumes: clean reviewed local changes and the sequential acceptance state of issues #737-#739.
- Produces: a conventional commit on `test/676-android-sidebar-filter`, hosted CI evidence, issue/PR comments, and issue #740 closure only after acceptance.

- [ ] **Step 1: Review the complete task diff.** Check correctness, native/REST/renderer ownership, Matrix authenticity, device-state recoverability, redaction, source preservation, and test mutation strength; resolve every finding.
- [ ] **Step 2: Commit task-owned files.** Stage only the location-share migration and use `test(android): migrate location share flow to Maestro` after all local checks pass.
- [ ] **Step 3: Preserve the active hosted gate.** Do not push while an earlier issue's exact-source hosted job is active; after it reaches an audited terminal state, publish the already verified sequential commits without force-pushing.
- [ ] **Step 4: Audit original-attempt hosted evidence.** Verify merge SHA, renderer manifest, APK/profile hashes, exact predecessor, dedicated Android artifact, 1/1 stage, 8/8 identities, attempt 1/retries 0, exact native GPS/echo/card/sheet receipts, redaction, teardown, and clean worktree.
- [ ] **Step 5: Update trackers without merging.** Post evidence to #740, parent migration issues, and PR #677; close #740 only after every acceptance item passes, keep PR #677 draft/open and unmerged, then continue to the next open migration issue.
