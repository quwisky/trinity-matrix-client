# Android Media Retention Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical retained
conversation-media definition while preserving its complete Playwright
predecessor.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, all helper expansions, exact call order and every forbidden shortcut.
One serial Node/Maestro stage arranges a disposable Matrix Account and two
Rooms, uploads the pinned PNG once as plaintext and once as a correctly
AES-CTR-encrypted v2 attachment, and sends two distinct `m.image` events into
Room A. Maestro owns login, five Room opens, six image opens and six lightbox
closes. Read-only renderer observations prove bubble readiness, decoded image
dimensions and exact lightbox lifecycle across the initial visit and two full
A → B → A rounds. Encryption secrets stay closure-private and are scrubbed
from all retained artifacts.

**Issue:** #741, blocked on #740 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned media-retention predecessor, application-login and
  account sources unchanged.
- Record exactly 47 unique identities in one stage and exact call order: five
  Room-readiness expansions, six ready-image groups of three and six lightbox
  groups of four.
- Matrix REST may arrange Accounts, Rooms, media and events. Maestro owns every
  product action: login, all five Room opens, all six image opens and all six
  lightbox closes.
- Renderer access is read-only and may observe exact bubble state, image
  decode/dimensions and dialog visibility. It may not invoke handlers, click,
  focus, fill, submit or navigate.
- Use two distinct exact events and media objects. The encrypted image must use
  AES-CTR-256 bytes with an exact v2 JWK, IV and SHA-256 ciphertext hash; never
  substitute plaintext or reuse the plaintext event.
- Complete both full A → B → A rounds and repeat every plaintext/encrypted
  ready-image and lightbox proof after each return.
- Use one attempt, zero retries, finite observation and bounded attachment,
  Matrix/application/device/resource teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access tokens, media authorization,
  attachment keys, IVs, hashes and raw ciphertext.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/media-retention-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact PNG/encryption/two-Room fixture,
      Room/ready-image/lightbox helper and definition spans, plus application
      and account source hashes.
- [ ] Prove exact definition call order: five `openRoom`, six
      `expectReadyImage` and six `openAndCloseLightbox` calls with both complete
      loop iterations.
- [ ] Require 47 globally unique round/filename/operation-specific contract
      identities grouped 5 + 18 + 24 in one exact stage.
- [ ] Require the exact PNG bytes, separate plaintext/encrypted uploads and
      events, AES-CTR-256/v2 key/IV/ciphertext-hash metadata, exact filenames
      and ready server event receipts.
- [ ] Require five native Room opens, six native exact image-button taps and six
      native Close taps; require exact ready bubble, complete image, positive
      natural width, named dialog visibility and post-close hiding proofs in
      every visit.
- [ ] Reject plaintext substitution, shared media/event ids, skipped rounds,
      filename/placeholder/pending-only proof, DOM click/focus/fill/submit/
      navigation, retries, unbounded waits and weak resource cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for bytes/content types, encryption
      algorithm/key/IV/hash, event separation, call order/count, every
      round/file readiness/decode/dialog/close proof, native ownership,
      cleanup and secret redaction.
- [ ] Run `pnpm exec vitest run scripts/media-retention-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and attachment fixture

**Files:**

- Create `e2e/android/media-retention-contract.mts`.
- Create `e2e/android/media-retention-fixture.mts`.

- [ ] Export exact source mappings and generate explicit unique identities for
      initial A, round 1 B/A and round 2 B/A, plus both filenames and every
      ready/decode/lightbox/close observation; assert 47 and uniqueness at
      module load.
- [ ] Arrange a fresh Account plus Room A and Room B with closure-private
      credentials/token and exact sanitized Room identities.
- [ ] Upload the pinned decodable PNG as `image/png`, capture its MXC, and send
      a distinct ready `m.image` event named `retained-plain.png`.
- [ ] Generate a 256-bit extractable AES-CTR key and random 16-byte IV with its
      lower counter half zero, encrypt the same PNG, hash the ciphertext with
      SHA-256, upload as `application/octet-stream` and send a distinct ready
      `m.image` event named `retained-encrypted.png` with exact v2 file metadata.
- [ ] Keep token, JWK material, IV, hash, raw PNG/ciphertext and media
      authorization inside the fixture closure. Return only sanitized event,
      filename, byte-length and separation/integrity receipts.
- [ ] Add bounded cleanup that drops all fixture references and zeroes mutable
      secret buffers where possible; never persist secret attachment metadata.
- [ ] Extend the focused guard so wrong bytes/content type/algorithm/counter,
      non-random or malformed key/IV, plaintext hashing, shared MXC/event ids,
      incomplete responses or leaked secret material fail.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native retention stage

**Files:**

- Create `e2e/android/media-retention-journeys.mts`.

- [ ] Arrange both Rooms and exact attachment events, sign into the installed
      app and open Room A through native actions; prove Room readiness.
- [ ] For each exact filename, prove the scoped media bubble has
      `data-media-state="ready"`, the exact image is complete and its natural
      width is positive.
- [ ] For each filename, tap the exact `Open image <filename>` button natively,
      prove the exact named dialog visible, its lightbox image complete with
      positive natural width, tap Close natively and prove the dialog hidden.
- [ ] Perform exactly two rounds of native Room B then Room A opening. After
      each Room A return, repeat all six ready-image records and all eight
      lightbox records for plaintext and encrypted filenames.
- [ ] Record event-id-scoped observations so a filename elsewhere or stale
      placeholder cannot satisfy a proof; keep renderer URLs summarized rather
      than retaining blob/media authorization values.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, sanitized media/event/resource receipts and
      aggregate cleanup and redaction scans.
- [ ] Always close any open lightbox, clear installed application data, close
      the client and release fixture/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `media-retention` target with the Android APK
      build, a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.media-retention` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after location-share with a bounded
      wrapper and started marker; add started-only `android-media-retention`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, 47 identities/call order, exact plaintext and
      encrypted attachment construction, native/REST/renderer boundaries, two
      navigation rounds, secret/resource teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:media-retention --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 47/47
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens, bearer patterns, media authorization, JWK/IV/hash
      material, raw ciphertext and blob/media URLs; require no raster artifacts
      and clean application/device/resource teardown.
- [ ] Run the complete unchanged media-retention browser predecessor with one
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
      the exact browser predecessor, dedicated Android artifact, 1/1 stage,
      47/47 identities, attempt 1/retries 0, exact attachment/event/resource
      receipts, both rounds, secret redaction, teardown and clean worktree.
- [ ] Post evidence to #741, #660, #653 and PR #677; close #741 only after all
      acceptance evidence is complete, then continue with #742.
