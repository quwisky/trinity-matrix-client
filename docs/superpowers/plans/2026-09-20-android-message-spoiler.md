# Android Message Spoiler Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical spoiler
conceal/reveal definition while preserving its Playwright predecessor and
retaining safe visual evidence of both real paint states.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, the exact six-identity ownership and every forbidden shortcut. A
fixture layer arranges one exact formatted Matrix spoiler event in a disposable
Room. One serial Node/Maestro stage logs in, opens the Room and taps the exact
spoiler natively. Read-only renderer observations prove exact leaf identity,
class and computed colour before/after; narrowly scoped ignored/artifact-only
captures preserve the black-bar and revealed visual states without serving as
the assertion oracle.

**Issue:** #753, blocked on #752 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-spoiler predecessor, application-login and
  account sources unchanged.
- Record exactly six unique identities in one stage: five direct plus expanded
  Room readiness.
- Matrix REST may arrange the exact formatted spoiler fixture. Maestro owns
  every product action: login, Room navigation and spoiler activation.
- Renderer inspection is read-only. It may observe exact text, count,
  visibility, class and computed colour but may not call handlers, mutate
  class/style, focus, fill, submit, scroll or navigate.
- Prove initial concealment and final reveal from computed paint plus state.
  Markup, secret presence, class change or screenshot alone is insufficient.
- Retain exact conceal/reveal visual captures in ignored run output and hosted
  artifacts only—never commit them. Crop/scope them to the message surface and
  scan associated metadata so unrelated credentials or tokens cannot appear.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; redact
  credentials and access tokens while retaining the required scoped raster
  evidence for this suite.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-spoiler-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact definition/fixture/Room-helper spans,
      exact formatted-message shape plus application-login and account hashes.
- [ ] Prove exactly five direct assertions plus one Room-readiness identity and
      require six globally unique contract identities.
- [ ] Require one exact run-scoped `data-mx-spoiler` fixture, one exact visible
      rendered leaf, initial no-revealed state/fully transparent text, native
      activation and final revealed/non-transparent text.
- [ ] Require exact scoped conceal/reveal PNG captures in ignored diagnostic
      output and hosted artifacts, with capture metadata/redaction scans and no
      repository tracking.
- [ ] Reject handler calls, class/style mutation, DOM click/focus/fill/submit/
      navigation, secret-presence-as-exposure, markup/class/screenshot-only
      paint proof, broad full-app credential captures, retries, unbounded waits
      and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics, explicit raster allowlist
      and predecessor retention.
- [ ] Add effective mutation controls for fixture body/HTML, leaf count/text/
      visibility, initial/final class and colour alpha, native tap ownership,
      capture state/order/scope/metadata, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/message-spoiler-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and spoiler fixture

**Files:**

- Create `e2e/android/message-spoiler-contract.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if exact formatted
  message creation cannot be composed from existing fixture operations.

- [ ] Export exact source mappings and all six identities; assert count and
      uniqueness at module load.
- [ ] Arrange one fresh Account/private Room and send exactly one
      `m.room.message` with run-scoped body `the secret is …`,
      `format = org.matrix.custom.html` and formatted body containing exactly
      one unadorned `data-mx-spoiler` span around the exact secret.
- [ ] Retain the ready event id and sanitized body/HTML-shape receipt while
      keeping credentials/tokens closure-private.
- [ ] Reject duplicate spoiler spans, pre-revealed classes/styles, extra markup
      that changes the owned leaf or any renderer-state seeding.
- [ ] Define the two allowed capture names/states and metadata schema; ensure
      their output path is ignored and never included by source globs.
- [ ] Extend the focused guard so wrong fixture, duplicate/missing event,
      capture tracking, unbounded setup or leaked secrets fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement native conceal/reveal and visual evidence

**Files:**

- Create `e2e/android/message-spoiler-journeys.mts`.

- [ ] Sign in and open the exact Room natively; record expanded Room readiness
      and scope the renderer to the exact event-id row.
- [ ] Prove exactly one visible `.mx-spoiler` leaf has the exact secret text,
      initially lacks `is-revealed` and has computed text colour alpha exactly
      zero.
- [ ] Capture the exact message-surface conceal state after all initial
      assertions, preserving the black bar without login/settings surfaces.
- [ ] Tap the exact spoiler through native touch; never dispatch a renderer
      event or modify its state.
- [ ] Re-scope the same leaf and prove it gains `is-revealed` and its computed
      text colour alpha is strictly greater than zero.
- [ ] Capture the same exact message-surface rectangle after final assertions
      so conceal/reveal evidence is geometrically comparable.
- [ ] Record all six identities exactly once and write started-stage reports,
      pass/failure secret-safe captures, exact assertion accounting and
      fixture/paint/capture receipts including hashes and dimensions.
- [ ] Scan all text metadata for credentials/tokens and validate the raster
      allowlist contains only the required scoped states (plus one failure
      capture only when the stage fails); always clear application data and
      release Matrix/device resources.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-spoiler` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-spoiler` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-source with a bounded
      wrapper and started marker; add started-only `android-message-spoiler`
      diagnostics preserving the explicit scoped raster allowlist.
- [ ] Extend registry/workflow guards for exact ordering, timeout, artifact path
      and capture retention.
- [ ] Document pinned ownership, six identities, fixture/native/renderer
      boundaries, computed paint proof, capture scope/retention, secrets,
      teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-spoiler --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 6/6 identities,
      attempt 1 and retries 0 each time.
- [ ] Audit each run's exact conceal/reveal capture pair for matching scope,
      black-bar/revealed states, safe metadata, hashes/dimensions and ignored
      status; require no unallowlisted raster and clean Matrix/application/
      device teardown.
- [ ] Run the complete unchanged message-spoiler browser predecessor with one
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
      hashes and ignored-only raster evidence.
- [ ] Commit only task-owned source/docs files, push the consolidated branch,
      and keep PR #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor, dedicated Android artifact, 1/1 stage, 6/6
      identities, attempt 1/retries 0, fixture/native/paint/capture receipts,
      scoped visual evidence, redaction, teardown and clean worktree.
- [ ] Post evidence to #753, #660, #653 and PR #677; close #753 only after all
      acceptance evidence is complete, then continue with #754.
