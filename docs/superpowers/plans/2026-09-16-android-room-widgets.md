# Android Room Widget Journeys Migration Plan

> **For Codex:** Follow this plan task by task. Keep native Maestro input as the
> product-action owner, use CDP only for bounded observation/fixture transport
> and the two source-pinned adversarial bridge probes, and do not retire the
> Playwright predecessors in this batch.

**Goal:** Migrate issue #719's Room widget journeys to one deterministic Android
Maestro suite while preserving all 86 direct and 7 inherited assertions.

**Architecture:** A source-pinned contract enumerates the 93 identities. One
Android journey runs four isolated stages: mobile layout, restricted Widget API
bridge, opening-admin management across an Account switch, and live authority.
`AccountWorkspaceClient` owns native taps, text entry, keys, and scrolling.
Finite Matrix REST fixtures arrange rooms and power levels. An exact-host CDP
Fetch controller serves the widget peer without public-network traffic and
records requests/referrers; CDP reads assertions and performs only the two
explicit adversarial frame probes. The existing Matrix HTTP fault controller
fails the first exact widget state write. Every identity is recorded once in
the artifact evidence.

**Tech stack:** TypeScript ESM, Node assertions, Maestro, Android WebView CDP,
Synapse Matrix REST fixtures, Nx/Vitest, GitHub Actions.

---

## Task 1: Lock the source and executable contract

**Files:**

- Create: `scripts/room-widget-migration.spec.mjs`
- Create: `e2e/android/room-widget-contract.mts`

1. Add a migration guard that pins all six predecessor/helper SHA-256 hashes,
   declares the expected 86 direct plus 7 inherited identities, and requires
   the Android journey, fixture, registration, CI upload, ledger, and native
   interaction evidence.
2. Run `pnpm nx test scripts --skipNxCache room-widget-migration.spec.mjs`
   and preserve the expected RED caused by the missing contract/journey.
3. Add the contract with the four source ranges and exactly 93 unique identity
   values, then rerun the focused guard. It must remain RED only for the next
   missing implementation seam.

## Task 2: Build the exact widget transport fixture

**Files:**

- Create: `e2e/android/room-widget-fixture.mts`
- Modify: `scripts/room-widget-migration.spec.mjs`
- Test: `scripts/room-widget-migration.spec.mjs`

1. Extend the guard with exact host/path, request accounting, referrer capture,
   fixture markup, delayed capability negotiation, and cleanup expectations.
2. Prove RED.
3. Implement a persistent CDP Fetch controller that fulfills only
   `https://widgets.example/**` and the exact changed-origin peer, serves the
   source-pinned fixture HTML, records only real widget requests/referrers, and
   continues every unrelated request.
4. Ensure close drains pending work, unsubscribes, and disables Fetch without
   hiding the actionable failure. Prove the focused guard GREEN.

## Task 3: Implement the four-stage Android journey

**Files:**

- Create: `e2e/android/room-widget-journeys.mts`
- Modify: `scripts/room-widget-migration.spec.mjs`

1. Guard native ownership, exact viewport profiles, finite timeouts, artifact
   identity coverage, secret redaction, and the two narrowly permitted CDP
   adversarial actions.
2. Prove RED.
3. Arrange unique users/rooms/widgets with Matrix REST fixtures and run each
   stage from a reset installed app.
4. Reproduce the 24 mobile checks with Pixel 5 geometry/theme/scale evidence.
5. Reproduce the 34 bridge checks, including sibling-forgery rejection,
   changed-origin rejection, sandbox/referrer/feature-policy evidence, and
   blocked mixed content.
6. Reproduce the 20 management checks while retaining the opening admin after
   the allowed Account-runtime continuity switch. Fail only the first exact
   widget state write, retry natively, then remove the exact widget.
7. Reproduce the 8 live-authority checks after REST grants and revocations,
   proving controls update live and no widget is eagerly requested.
8. Record each of the 93 contract identities exactly once and prove the focused
   guard GREEN.

## Task 4: Register the Nx suite and hosted shard

**Files:**

- Modify: `e2e/android/project.json`
- Modify: `package.json`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `e2e/registry/commands.mts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Modify: `scripts/ci-workflow.spec.mjs`

1. Add `android.room-widget-settings`, target `room-widget-settings`, and
   `e2e:android:room-widget-settings` with Android AVD and Synapse resources.
2. Put the suite on the shortest suitable Android shard based on the latest
   completed hosted run, with its own start marker and always-on artifact upload.
3. Update registry/workflow guards first, observe RED, then update the runtime
   registrations and prove the focused guards GREEN.

## Task 5: Document and validate locally

**Files:**

- Modify: `e2e/android/MIGRATION.md`
- Modify: this plan

1. Document scope, permitted fixture/adversarial CDP use, 93 identities,
   invocation, artifact location, one-attempt policy, and predecessor retention.
2. Run format/type/lint and all focused guard tests selected by repository
   policy.
3. Run the migrated suite three consecutive times with zero retries, auditing
   artifacts for identity uniqueness, native actions, redaction, provenance,
   and cleanup.
4. Run the two Playwright predecessor files once each with zero retries.
5. Mark only completed plan items.

## Task 6: Review, publish, and obtain hosted acceptance

1. Review the complete diff and run the final selected verification set.
2. Commit only issue #719 files with a Conventional Commit and push
   `test/719-android-room-widgets`.
3. Cherry-pick the verified commit to `test/676-android-sidebar-filter` and
   push it without merging PR #677.
4. Trigger/observe exact-head hosted CI. Require the new Android shard and
   retained browser predecessors to pass on attempt 1 with zero retries.
5. Audit the downloaded artifact and logs for all 93 identities, fixture
   request/referrer evidence, redaction, provenance, Synapse teardown, emulator
   shutdown, and exact branch/head.
6. Record acceptance in this plan and the migration ledger, commit/push that
   documentation to both branches, comment on #719, #660, #653, and PR #677,
   then close #719 only. Never merge PR #677.

## Local acceptance evidence

- [x] Seven deliberate controls each failed their intended guard and were
      restored: direct identity, inherited identity, exact write target,
      changed-origin Fetch pattern, opening-Account retention, live power grant and
      secret redaction.
- [x] Three unchanged-input installed-Android invocations passed all four
      stages on their original attempt with zero retries and 93/93 identities:
      `mu3vjerh-a6833afd-e177-43c3-8b97-2238304fb7ee`,
      `mu3w0hzs-c388abb8-b55f-4ede-9712-d8446acb3821` and
      `mu3whdzw-2bd84f86-500a-4a2c-824c-ee22e71da8c1`.
- [x] The final Android artifact contained 38 redacted `SECRET_TEXT`
      environment values and 19 redacted evaluated inputs, with no failed native
      JUnit or capture and clean resource teardown.
- [x] The four exact Playwright definitions passed sequentially with one worker
      and zero retries in `mu3wylhu-c1d4c7d2-e940-4324-9f8e-1a29964d97d1`,
      `mu3wz7iy-67782616-d349-4f8a-a1db-74c981ee5c6e`,
      `mu3wzuc8-69724043-c87f-43e6-ac45-962e2a990fc5` and
      `mu3x0gm1-d7421f55-adb4-4b0c-9b6c-6182bfac00d0`.
- [ ] Publish the reviewed issue commit and consolidated cherry-pick, then
      audit the original-attempt hosted Android/browser/renderer artifacts.
