# Android Message Receipts Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical read-receipt
rendering definition while preserving its Playwright predecessor and binding
the exact accessible avatar cluster and geometry to an authoritative Matrix
receipt.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, the exact four-identity ownership and every forbidden shortcut. A
fixture layer arranges three disposable Accounts, membership, one author event
and one seer receipt, then independently verifies the receipt relation and
seer profile/membership before launch. One serial Node/Maestro stage logs in as
the reader and opens the Room; read-only renderer observations prove the exact
event-scoped cluster, accessible identity and non-overlap geometry.

**Issue:** #751, blocked on #750 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-receipts predecessor, application-login and
  account sources unchanged.
- Record exactly four unique identities in one stage: expanded Room readiness,
  visible event-scoped receipt cluster, exact accessible seer name and measured
  cluster/text non-intersection.
- Use three real Accounts with distinct reader, author and seer roles. Set the
  seer's exact display name before Room membership activity.
- Matrix REST may arrange and observe Accounts, profile, Room, membership,
  author message and receipt. Maestro owns all product actions: reader login
  and Room navigation.
- Renderer inspection is read-only. It may observe exact identity,
  accessibility and used geometry but may not invoke handlers, focus, fill,
  submit, scroll or navigate.
- Prove the authoritative seer/event `m.read` relation and exact membership/
  display-name state before app launch. Never fake receipt state in the
  renderer or accept another user's avatar.
- Measure real installed bounding boxes. CSS declarations or screenshots do
  not prove non-overlap.
- Use one attempt, zero retries, finite observation and bounded three-Account/
  Room/application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials and access tokens.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-receipts-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact definition/API-token/Room-helper spans
      plus application-login and account source hashes.
- [ ] Prove exactly three direct assertions plus one expanded Room-readiness
      identity and require exactly four globally unique contract identities.
- [ ] Require three exact Account roles, pre-membership display-name update,
      Room joins, one exact author event, exact seer/event `m.read` submission
      and independent authoritative relation/profile/membership proof before
      launch.
- [ ] Require native reader login/Room navigation, exact event-row scoping,
      first visible read-receipt cluster, exact accessible seer label and real
      cluster/message-text box non-intersection.
- [ ] Reject renderer-injected receipt state, wrong user/event/avatar,
      unscoped Room-wide avatar evidence, label-only evidence without the Matrix
      relation, CSS/screenshot geometry, DOM click/focus/fill/submit/navigation,
      retries, unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for role identity, profile timing/name,
      membership, message event id/body/sender, receipt user/event/type,
      event-row cluster scope/visibility/label, every intersection edge,
      cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/message-receipts-migration.spec.mjs`
      and preserve the expected RED result.

## Task 2: Add the exact contract and authoritative receipt fixture

**Files:**

- Create `e2e/android/message-receipts-contract.mts`.
- Create `e2e/android/message-receipts-fixtures.mts`, reusing lower-level
  account helpers where exact behavior already exists.

- [ ] Export exact source mappings and all four identities; assert count and
      uniqueness at module load.
- [ ] Register fresh reader, author and seer Accounts; set the exact run-scoped
      seer display name before creating/joining the Room.
- [ ] Create the Room as reader, join author and seer, send one exact author
      text event and retain its ready event id.
- [ ] Submit the seer's real `m.read` receipt for that exact event id, then use a
      bounded independent reader observation to prove the ephemeral receipt
      maps the seer to the exact event.
- [ ] Independently prove Room membership for all three user ids and the exact
      seer display name in authoritative membership/profile state before app
      launch.
- [ ] Keep credentials/tokens closure-private and return only sanitized role,
      Room/event, receipt and profile facts; aggregate cleanup must cover all
      three Accounts and the Room even after partial failure.
- [ ] Extend the focused guard so wrong role/event/relation/name/membership,
      observation after app launch, unbounded polling or leaked secrets fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native receipt-rendering stage

**Files:**

- Create `e2e/android/message-receipts-journeys.mts`.

- [ ] Complete and retain the authoritative pre-launch fixture receipt, sign in
      as the exact reader and open the exact Room through native actions.
- [ ] Record expanded Room readiness, then scope every renderer observation to
      the exact author message event-id row—not the first avatar or receipt in
      the Room.
- [ ] Prove the row's first `[data-testid="read-receipts"]` cluster is visible
      and its accessible label names the exact run-scoped seer.
- [ ] Read the cluster and exact owning `.msg__text` bounding rectangles from
      the installed renderer and prove all four separating-axis intersection
      conditions yield `intersects = false` with non-zero boxes.
- [ ] Record all four identities exactly once and write started-stage reports,
      pass/failure secret-safe captures, exact assertion accounting and
      authoritative fixture/accessibility/geometry receipts.
- [ ] Scan aggregate diagnostics for credentials/access tokens; always clear
      application data, close the client and release all Account/Room/device
      resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-receipts` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-receipts` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-quote with a bounded
      wrapper and started marker; add started-only `android-message-receipts`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, four identities, three Account roles,
      authoritative receipt/profile/membership proof, event-scoped accessible
      avatar and used geometry, secrets, teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-receipts --skipNxCache`
      three times sequentially on unchanged inputs; require 1/1 stage, 4/4
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens and bearer patterns; require no raster artifacts
      and clean three-Account/Room/application/device teardown.
- [ ] Run the complete unchanged message-receipts browser predecessor with one
      worker and `--retries=0`; require the exact definition to pass and recheck
      all three pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls and artifacts in the ledger.

## Task 6: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor, dedicated Android artifact, 1/1 stage, 4/4
      identities, attempt 1/retries 0, authoritative receipt/profile/
      membership plus event-scoped accessibility/geometry receipts, redaction,
      teardown and clean worktree.
- [ ] Post evidence to #751, #660, #653 and PR #677; close #751 only after all
      acceptance evidence is complete, then continue with #752.
