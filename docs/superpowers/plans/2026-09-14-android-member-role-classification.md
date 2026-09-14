# Android Member Role Classification Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a four-stage installed-Android Maestro/Node replacement for the shared open-room helper and every direct assertion in the four canonical member-role classification definitions while keeping all predecessors enabled.

**Architecture:** Reuse the invocation-owned Pixel 5 device, `AccountWorkspaceClient`, finite Matrix account/Room fixtures, and the established read-only WebView observation boundary. Seed ordinary role rooms by setting profile names before membership events and applying exact power levels after join. Extend the direct-room fixture narrowly to support `trusted_private_chat`, so the DM stage proves the canonical equal-admin case. A source-pinned contract owns 27 stable identities: three shared helper sites and 24 direct sites.

**Tech Stack:** TypeScript ESM, Node test runner, Maestro 2.10 flows, Playwright Android WebView/CDP observation, Matrix client-server API, Vitest policy tests, Nx, GitHub Actions.

---

### Task 1: Pin source shape and parity identities

**Files:**

- Create: `scripts/member-role-classification-migration.spec.mjs`
- Create: `e2e/android/member-role-classification-contract.mts`

**Interfaces:**

- Consume `e2e/browser/journeys/room-administration/member-roles.spec.mts`, SHA-256 `58f0cacf00feb7a2587545b8261164632af83b24e0b839cc4be889af6a52b20f`.
- Pin shared helper lines 173–193 and definitions at lines 205–281, 283–361, 363–393, and 395–433.
- Produce exactly three `open-members.*`, nine `grouping.*`, eight `direct-message.*`, three `owner-panel.*`, and four `owner-admin.*` identities.

- [x] **Step 1: Write the failing source-shape and contract test**

Require the exact source hash, helper/title/span ownership, all 27 identities, four mandatory stages, Pixel 5 profile, real Matrix fixtures, compact native navigation and row selection, read-only CDP boundaries, lifecycle/cleanup, redaction, and predecessor retention.

- [x] **Step 2: Verify RED**

Run: `pnpm nx test scripts -- member-role-classification-migration.spec.mjs`

Expected: FAIL because the contract and journey modules do not exist.

- [x] **Step 3: Add the minimal contract module**

Define all 27 stable identities and exact source metadata; assert count and uniqueness in-module.

- [x] **Step 4: Re-run the focused contract**

Expected: remain red only for missing journeys and registration.

### Task 2: Implement four faithful native stages

**Files:**

- Create: `e2e/android/member-role-classification-journeys.mts`
- Modify: `e2e/android/account-workspace-fixtures.mts`

- [x] **Step 1: Extend the direct-room fixture narrowly**

Allow `createDirectRoom` to select `private_chat` or `trusted_private_chat` while preserving the existing default and `m.direct` account-data write. Do not expose fixture access tokens or add application-side state mutation.

- [x] **Step 2: Implement shared native navigation and observation helpers**

Reuse measured Maestro taps for login, Rooms, Room selection, compact Members navigation, and member-row selection. Record the three shared open-room assertions once in the contract and prove them in every applicable stage. Keep WebView/CDP read-only except for existing trusted-event receipt observers.

- [x] **Step 3: Implement role grouping**

Seed owner/moderator/member power levels 100/50/0. Prove three visible rows, exact ordered section labels and accessible group names, 34 px headers, 44 px rows, exact member placement, and moderator display name.

- [x] **Step 4: Implement trusted direct-message equality**

Create a real `trusted_private_chat` DM, join both accounts, publish `m.direct`, open it by counterpart display name, and prove two rows in one `Admin — 2` section, no Owner section, and exact Admin role in member info.

- [x] **Step 5: Implement creator owner panel and owner/admin separation**

For the owner-panel stage, prove the creator's panel role is Owner. For the separation stage, give the peer exact power 100 and prove ordered `Owner — 1` / `Admin — 1` sections with the correct person in each.

- [x] **Step 6: Run focused contract and Android typecheck green**

Run: `pnpm nx test scripts -- member-role-classification-migration.spec.mjs`

Run: `pnpm nx run trinity-e2e-android:typecheck --skipNxCache`

### Task 3: Register target, CI, and migration ledger

**Files:**

- Modify: `e2e/android/project.json`
- Modify: `package.json`
- Modify: `e2e/registry/commands.mts`
- Modify: `e2e/registry/suites/runners.mts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/e2e-suite-registry.spec.mjs`
- Modify: `scripts/ci-workflow.spec.mjs`
- Modify: `e2e/android/MIGRATION.md`

- [x] **Step 1: Add failing registry/workflow assertions**

Require suite `android.member-role-classification`, target/script/entrypoint, serialized resources, four-stage host budget, shard-2 placement after `member-details-promotion`, started flag, artifact surface, and upload-count change.

- [x] **Step 2: Verify RED**

Run focused registry/workflow tests and confirm they fail only for missing registration.

- [x] **Step 3: Add target, script, registry, and hosted shard wiring**

Use uncached serial execution, `android-avd` plus `synapse`, a 30-minute Node-test bound, 33-minute target bound, and 35-minute CI wrapper bound. Upload diagnostics only when the suite started.

- [x] **Step 4: Document exact 27-site parity and provisional bounds**

Add a `Member role classification batch` section with #711, source hash/spans, 27-identity table, native/read-only boundaries, command, artifact path, shard placement, and acceptance gates.

- [x] **Step 5: Re-run focused registry/workflow tests green**

### Task 4: Static gates and deliberate controls

- [x] **Step 1: Run focused and full script tests**

Run the migration contract test, registry/workflow tests, then `pnpm nx test scripts --skipNxCache`.

- [x] **Step 2: Run typecheck, lint, formatting, and diff checks**

Run Android and browser typecheck/lint, `pnpm format:check`, `git diff --check`, and inspect status.

- [x] **Step 3: Run at least five effective failing controls and restore after each**

Cover an omitted identity, false Members readiness, 43 px row, `private_chat` substituted for the trusted DM preset, and swapped Owner/Admin placement. Every mutation must fail its intended guard and the restored check must pass.

### Task 5: Native stability, predecessors, review, and publication

- [x] **Step 1: Run three complete unchanged-input native first attempts sequentially**

Run: `pnpm nx run trinity-e2e-android:member-role-classification --skipNxCache`

Require four passed stages, 27 unique identities, 33 stage-local assertion records, one suite attempt, zero retries, completed native commands, exact profile/renderer/APK receipts, and clean teardown each time.

Fresh post-review invocations
`mu1qxkn7-5b3ccfe0-b27f-4b90-807f-2098e62711a3`,
`mu1r84pg-dcdda97d-6319-40af-bfe1-83a040b0cf54`, and
`mu1ric7b-d5e3591a-7807-41d4-84a7-1baf39225c28` each passed all four
stages on one attempt with zero retries, all 33 stage-local records / 27 unique
identities, 37 command files / 181 completed Maestro entries, redacted secrets,
and clean teardown.

- [x] **Step 2: Run all four unchanged Playwright predecessors sequentially**

Run the four exact titles with `--workers=1 --retries=0`; require one first-attempt pass for each.

Fresh invocations `mu1rsqnu-77d02982-137a-44b0-857b-c050db77df90`,
`mu1rtacj-5b84a081-ca27-4915-8484-7d0a1b787910`,
`mu1rttpm-0d2f0ec0-aacf-47db-9418-a3adb36cd40e`, and
`mu1rud7f-15b894b3-a34d-44ae-8b7e-64bae38ee3ce` each passed their exact
definition on the first attempt with one worker, zero retries, and clean
teardown.

- [x] **Step 3: Review the final diff and evidence**

Require no unresolved findings and confirm the canonical Playwright source remains unchanged.

Independent re-review found no remaining Critical, Important, or Minor issues
after the canonical `.scroll` readiness correction and evidence-write failure
aggregation were pinned by focused regression guards. The Playwright source
remains unchanged at SHA-256
`58f0cacf00feb7a2587545b8261164632af83b24e0b839cc4be889af6a52b20f`.

- [x] **Step 4: Publish only after #710 hosted acceptance and fresh verification**

Commit and push `test/711-android-member-role-classification`, cherry-pick onto `test/676-android-sidebar-filter`, verify the identical tree, and push. Never merge PR #677.

- [ ] **Step 5: Audit original-attempt hosted evidence before closing #711**

Require green owned Android shard evidence and exact hosted predecessor passes at retry 0. Audit the immutable suite artifact for four stages, 27 identities, completed native commands, exact classification/geometry receipts, renderer/APK/profile provenance, secret redaction, and teardown. Track unrelated job-level reliability separately on #665, then update #711, #660, #653, and PR #677.
