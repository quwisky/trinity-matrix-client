# Android GIF Picker Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for all four canonical GIF
configuration, availability, send and Account-isolation definitions while
preserving their complete Playwright predecessor.

**Architecture:** A focused Vitest guard pins the predecessor, navigation and
shared login sources, their exact assertion expansion and every forbidden
shortcut. Four serial Node/Maestro stages use closure-private Matrix fixtures,
native Settings/Account/Room/composer actions, direct observation of Android
Preferences, and one bounded CDP Fetch controller scoped only to KLIPY and its
CDN. Real 1×1 GIF bytes upload through Synapse and produce an independently
observed `m.image` event from the exact active Account.

**Issue:** #735, blocked on #734 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned GIF predecessor, Android navigation helper,
  application-login and account sources unchanged.
- Record exactly 24 unique identities grouped 10 + 4 + 3 + 7: 17 direct
  predecessor assertions, one Add-account readiness expansion, three Room
  readiness expansions and three inherited Android Settings-navigation
  identities.
- Maestro owns Settings, provider/key entry, save/clear, Account addition and
  switching, Room/tray/picker navigation and result selection.
- Matrix REST may arrange Accounts/Rooms and observe image events. Native
  storage access may only seed or observe the exact preference. CDP Fetch may
  only intercept `api.klipy.com` and `media.klipy.com`; renderer access remains
  read-only.
- Never call a real third-party GIF service, substitute local storage for
  native Preferences, accept a preview as proof of `m.image`, or accept an
  arbitrary sender in place of Account B.
- Use one attempt, zero retries, finite observations, a single non-overlapping
  network controller and bounded controller/Matrix/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact API keys, credentials, access tokens and media
  request secrets.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/gif-picker-migration.spec.mjs`.

- [ ] Pin the GIF source hash and exact constants/helper/definition spans,
      plus the navigation, application-login and account source hashes.
- [ ] Prove 17 direct assertion sites and the exact helper expansion of one
      Add-account, three Room-readiness and three Android Settings-navigation
      identities.
- [ ] Require the exact four stage IDs and 10 + 4 + 3 + 7 grouped contract
      identities with global uniqueness.
- [ ] Require native Settings/Account/Room/tray/picker actions, exact native
      `trinity.gif.config` storage, exact provider/CDN interception, real GIF
      bytes, real ready media state and exact Matrix sender proof.
- [ ] Reject DOM click/focus/fill/submit/navigation, WebView local-storage
      proof, broad Fetch patterns, real third-party traffic, overlapping
      controllers, retries, unbounded waits, weak cleanup and missing
      redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for provider/key persistence, clear
      semantics, cold-relaunch label, unconfigured omission, exact fixture
      targeting/body/content type, ready `m.image`, global configuration,
      Account B sender, native ownership, controller cleanup, redaction and
      teardown.
- [ ] Run `pnpm exec vitest run scripts/gif-picker-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add exact contract and bounded fixture seams

**Files:**

- Create `e2e/android/gif-picker-contract.mts`.
- Create `e2e/android/gif-provider-fixture.mts`.
- Create `e2e/android/gif-native-preference.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts`.

- [ ] Export exact source mappings and four grouped assertion maps; assert 24
      identities and uniqueness at module load.
- [ ] Prove a secret-safe, repeatable pre-launch write of the exact
      `trinity.gif.config` value into installed Android Preferences, followed
      by a cold launch whose production initialization reads it. Preserve
      atomic file shape, XML escaping and package ownership; never expose the
      API key in a retained command or diagnostic.
- [ ] Add exact native preference observation that reports provider/key
      equality and key length without returning or retaining the secret.
- [ ] Add a single bounded CDP Fetch fixture whose patterns cover only
      `https://api.klipy.com/*` and `https://media.klipy.com/*`, returns the
      pinned one-result JSON and exact decodable 1×1 GIF bytes, continues all
      unexpected traffic, records bounded sanitized request facts and always
      disables Fetch/unsubscribes in `close()`.
- [ ] Add closure-private `latestImageEvent` observation that walks newest
      Room messages and returns only sanitized `m.room.message` / `m.image`
      sender and event identity facts.
- [ ] Extend focused source-shape tests so wrong storage, host, payload, GIF
      bytes, sender selection, controller overlap or secret retention fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the four native stages

**Files:**

- Create `e2e/android/gif-picker-journeys.mts`.

- [ ] Implement `settings-lifecycle`: sign into the installed app, navigate
      natively through Settings to GIFs, prove native preference absence,
      choose GIPHY, enter/save the exact secret, prove provider/key persistence
      and visible Clear, clear natively, prove provider remains GIPHY while the
      key is empty and Clear disappears, then cold-relaunch and navigate back
      to prove exact `GIPHY API key` label text.
- [ ] Implement `unconfigured-tray`: open a disposable Room natively, prove
      composer readiness, open the insert tray, prove Attach visible and GIF
      absent.
- [ ] Implement `send-image`: seed native KLIPY configuration before production
      initialization, install the exact provider fixture, open the disposable
      Room/tray/GIF picker natively, prove search and exact result, select it by
      native touch, then prove a ready media bubble backed by a real Synapse
      `m.image` event.
- [ ] Implement `active-account-send`: seed global KLIPY configuration, sign in
      as A, add B through the installed UI, prove B active, open B-only Room,
      prove GIF remains available, select the exact fixture result natively,
      prove ready `m.image`, and independently prove its sender is exactly B.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, sanitized controller/native-storage receipts and
      aggregate cleanup and redaction scans.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add uncached serial `gif-picker` target with the Android APK build, a
      bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.gif-picker` as required current hosted Android coverage
      and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after composer typing with a bounded
      wrapper and started marker; add started-only `android-gif-picker`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, 24 identities, native/REST/renderer/CDP
      boundaries, exact provider fixture, Account isolation, secrets, teardown
      and retained predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:gif-picker --skipNxCache` three times
      sequentially on unchanged inputs; require 4/4 stages, 24/24 identities,
      attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for GIF API keys,
      credentials, access/session tokens, bearer patterns and provider request
      secrets; require no raster artifacts, no live Fetch controller, clean
      Matrix/account state and clean emulator/application teardown.
- [ ] Run the complete unchanged GIF browser predecessor with one worker and
      `--retries=0`; require all four tests to pass and recheck all four pinned
      source hashes.
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
      all four exact browser predecessors, dedicated Android artifact, 4/4
      stages, 24/24 identities, attempt 1/retries 0, native-storage/controller
      receipts, redaction, teardown and clean worktree.
- [ ] Post evidence to #735, #660, #653 and PR #677; close #735 only after all
      acceptance evidence is complete, then continue with #736.
