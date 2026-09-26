# Android Image Pack Lifecycle Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful dual-client installed-Android parity for the canonical
MSC2545 Room image-pack lifecycle while preserving its Playwright predecessor
and shared journey unchanged.

**Architecture:** A focused Vitest guard pins the predecessor, shared image-pack
journey and login/account sources, the exact one-stage/42-identity ownership and
every forbidden shortcut. One serial Node/Maestro journey reuses the repository
primary/secondary installed-package infrastructure with isolated app storage,
arranges real Synapse media and stable/legacy/local pack state, and drives all
install, persistence, usage, picker, send and removal actions natively. Read-
only renderer observations prove exact text, counts, values, focus, geometry,
visibility and blob attributes; server observers prove the outgoing sticker,
account-data removal and publisher-state retention.

**Issue:** #763, blocked on #762 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned stickers-custom-emoji predecessor, shared image-pack
  helper, application-login/remote-echo and account sources unchanged.
- Record exactly 42 globally unique identities in one stage: 28 main-helper
  direct assertions, five Room-readiness expansions (four primary and one
  secondary), six Settings expansions (three leave and three open), one
  `waitForSent` remote-echo expansion and two secondary-client assertions.
- Arrange fresh consumer/publisher Accounts, one private chat Room and one
  public pack-source Room through real Synapse. Upload the exact pinned 1×1 PNG
  as `image/png`/`party.png`; do not replace media or state with local fixtures.
- Publish exact stable `m.room.image_pack/fun`, same-key legacy
  `im.ponies.room_emotes/fun`, second stable `m.room.image_pack/other` and the
  inline custom-emoticon message. Stable discovery must win without a duplicate
  Fun row.
- Use the real separately installed secondary Android package and clear its
  isolated app storage before login. A second renderer/profile in shared
  primary storage is invalid cross-client evidence.
- Maestro/native device input owns every reachable action in both packages:
  login, Room/Settings/picker navigation, alias input/blur, install, usage
  toggles, close/Back, pack removal/confirmation and Party selection.
- Renderer inspection is read-only. It may observe exact text/count/value/
  focus/geometry/visibility/blob attributes but may not click, focus, fill,
  submit, navigate, invoke handlers or assign input/focus/state.
- REST may arrange/observe real Matrix media/state and publish/clear the local
  pack, but may not install account data on the user's behalf or seed the
  outgoing sticker.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device/settings/dual-package teardown.
- Preserve exact renderer, APK and device-profile provenance for both packages;
  remove raster diagnostics and redact both passwords, both access tokens,
  media/event identifiers and secondary storage details.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/image-pack-lifecycle-migration.spec.mjs`.

- [ ] Pin the predecessor and shared-helper hashes/spans, exact PNG bytes/MIME/
      name, pack state shapes and application/account source hashes.
- [ ] Prove the exact 42-record expansion: 28 direct + five Room + six Settings + one remote echo + two secondary-client identities, with source call
      counts and global uniqueness.
- [ ] Require real primary/secondary package ids, isolated storage, separate
      renderer/APK provenance and primary reactivation after secondary proof.
- [ ] Require stable-over-legacy discovery, exact alias/value/validation,
      exactly two candidates, Stable Fun selection, coarse-pointer 44 px source
      and install controls, native install and all-Room notice.
- [ ] Require cross-client Fun/All rooms persistence, native disable/re-enable
      notices and Room-surface absence, global/local scope distinction, live
      local removal, native Party selection and real sticker/blob/remote echo/
      exact-server-event proof.
- [ ] Require native Fun removal/confirmation, row disappearance, focus
      transfer, notice, empty account-data Room map, unchanged publisher source
      state and final Room-surface absence.
- [ ] Reject DOM click/focus/fill/submit/navigation, assigned alias/focus,
      handler invocation, shared-storage second client, local media/state
      fixtures, cached-only persistence, seeded outgoing sticker, retries,
      unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only dual-package diagnostics and predecessor
      plus shared-helper retention.
- [ ] Add effective mutation controls for every fixture/state/media field,
      identity/helper count, native action, target geometry, package/storage
      isolation, scope/usage/live-removal state, sticker/MXC/echo, uninstall
      focus/account data/source retention, cleanup and redaction.
- [ ] Run
      `pnpm exec vitest run scripts/image-pack-lifecycle-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and Matrix media/state fixture

**Files:**

- Create `e2e/android/image-pack-lifecycle-contract.mts`.
- Create `e2e/android/image-pack-lifecycle-fixtures.mts`, reusing exact lower-
  level Account/Room/media operations where possible.

- [ ] Export the exact source mappings, single stage id/count and all 42
      identities; assert totals and global uniqueness at module load.
- [ ] Register/login fresh consumer and publisher Accounts; create the private
      chat Room for the consumer and a public aliased pack-source Room for the
      publisher.
- [ ] Upload the exact base64 PNG bytes as `party.png`/`image/png`; retain its
      MXC internally and validate the returned media identity without exposing
      authorization or raw identifiers in diagnostics.
- [ ] Publish exact Fun stable state (sticker + emoticon use, attribution,
      Party pixel metadata), same-key legacy duplicate, and Other stable state;
      seed only the exact inline custom-emoticon message in the chat Room.
- [ ] Provide finite real-server operations to publish and later clear the
      exact Local pack in the chat Room only when the journey reaches that
      phase.
- [ ] Provide finite observers for the exact outgoing `m.sticker` with the
      uploaded MXC, the consumer's final `m.image_pack.rooms` value
      `{ rooms: {} }`, and unchanged publisher Fun source state.
- [ ] Retain only sanitized Account/Room/alias/media/pack facts; keep both
      passwords, both access tokens, media/event ids and authorization closure-
      private.
- [ ] Aggregate cleanup must handle partial setup plus both package sessions,
      clear installed package data, restore settings and release Matrix/device
      state within bounds.
- [ ] Extend the focused guard so wrong bytes/type/name, alias/preset/state key/
      content/scope, premature local state, seeded sticker, weak server
      observers, unbounded work or leaked secrets fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement primary inline, discovery and installation flow

**Files:**

- Create `e2e/android/image-pack-lifecycle-journeys.mts`.

- [ ] Install/clear/launch the primary package, sign in as the consumer and open
      the exact chat Room natively, recording the first Room-readiness identity.
- [ ] Prove the inline emoticon is visible with a real `blob:` URL, open the
      insert surface natively, prove Sticker is absent before installation and
      dismiss through Android Back.
- [ ] Navigate natively to Settings → Stickers and record the first Settings-
      open identity. Enter the exact Room alias through native keyboard input,
      observe the exact value, blur natively and prove validation help hides.
- [ ] Find packs through native touch; prove exactly two candidates, distinguish
      Fun pack as Stable and observe source/install control heights at least
      44 px under the production coarse pointer.
- [ ] Install Fun natively and prove the installed row plus notice naming Fun
      availability in all Rooms.

## Task 4: Prove isolated secondary-client persistence

- [ ] Install and clear the repository's secondary package with its distinct
      application id; record exact secondary APK/renderer/profile provenance
      and demonstrate storage separation from primary.
- [ ] Launch the secondary package, sign into the same consumer Account, open
      the exact chat Room natively and record the secondary-owned Room-readiness
      expansion within the five-record helper total.
- [ ] Open the insert surface and Sticker picker natively; prove Sticker is
      present and Fun pack reports exact `All rooms` scope, recording the two
      secondary callback identities.
- [ ] Reactivate the primary package through the device/app lifecycle helper and
      prove the subsequent controls belong to its process/profile.

## Task 5: Prove usage toggles, scopes, live removal and sticker send

- [ ] In primary Settings, disable Fun sticker usage natively and prove the
      exact update notice; leave Settings natively, record the first leave
      expansion and second primary Room readiness, then prove Sticker absent
      from the Room insert surface while disabled and dismiss through Back.
- [ ] Reopen Sticker settings natively for the second open expansion, re-enable
      usage through the real control and prove the update notice; leave for the
      second leave expansion and reopen the exact Room for the third primary
      readiness.
- [ ] Publish the exact Local pack into this active Room through the fixture,
      open insert and picker natively, and prove Sticker plus pack-management
      controls are visible.
- [ ] Prove Fun has `All rooms` scope and Local has `This room`; clear only the
      Local state through Synapse and prove its picker row disappears live.
- [ ] Select exact Party through native touch. Prove the real sticker row and
      image/blob, expanded remote-echo identity and authoritative server
      `m.sticker` event with the exact uploaded MXC.

## Task 6: Remove the installed pack and prove source retention

- [ ] Return natively to Sticker settings for the third open expansion, tap
      Fun's real Remove control and confirm through the real native dialog.
- [ ] Prove the installed row disappears, focus transfers to the installed-
      packs title without assigned focus, and the removal notice names account
      removal.
- [ ] Prove the consumer account-data Room map is exactly empty while the
      publisher's stable Fun source state remains available and unchanged.
- [ ] Leave Settings natively for the third leave expansion, open the exact Room
      for the fourth primary readiness, open insert and prove Sticker is absent.
- [ ] Record all 42 identities exactly once and write started-stage reports,
      pass/failure secret-safe captures, exact assertion accounting and media/
      state/native-action/package-isolation/settings/scope/sticker/echo/removal
      receipts.
- [ ] Scan aggregate diagnostics for both passwords/tokens, media/event ids and
      secondary storage details; always clear/stop both packages, restore
      settings and release Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 7: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `image-pack-lifecycle` target with primary and
      secondary Android APK builds, a bounded Node timeout and `android-avd` +
      `synapse` resources.
- [ ] Register `android.image-pack-lifecycle` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after slash-command with a bounded
      wrapper and started marker; add started-only
      `android-image-pack-lifecycle` dual-package diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout, artifact path
      and both-package provenance/cleanup requirements.
- [ ] Document pinned ownership, 42 identities/one stage, exact Matrix media/
      state, native lifecycle, isolated secondary persistence, usage/scope/live
      removal, real sticker, uninstall/source retention, secrets and teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 8: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run
      `pnpm nx run trinity-e2e-android:image-pack-lifecycle --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 42/42
      identities, attempt 1 and retries 0 each time.
- [ ] Audit exact media/state, every native action, helper expansion, control
      geometry, primary/secondary process/storage/provenance, persistence,
      usage/scope/local removal, sticker/blob/echo/server event and uninstall/
      account-data/source-retention receipts; require no raster artifacts and
      clean dual-package/Matrix/settings/device teardown.
- [ ] Run the unchanged stickers-custom-emoji browser predecessor with one
      worker and `--retries=0`; require its sole definition to pass, then
      recheck all four pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      both Android APK/host variants and documentation checks.
- [ ] Record exact commands, revisions, both renderer/APK/profile hashes,
      invocation IDs, durations, negative controls and artifacts in the ledger.

## Task 9: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, both renderer/APK/profile manifests,
      exact browser predecessor and dedicated Android artifact; require 1/1
      stage, 42/42 identities, attempt 1/retries 0, exact media/state/native/
      dual-package/persistence/usage/scope/sticker/removal/server receipts,
      redaction, teardown and clean worktree.
- [ ] Post evidence to #763, #660, #653 and PR #677; close #763 only after all
      acceptance evidence is complete, then continue with #764.
