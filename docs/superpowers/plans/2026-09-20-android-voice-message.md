# Android Voice Message Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the Android-applicable core
of the canonical voice-message definition while preserving its Playwright
predecessor, Chromium fake-microphone coverage and desktop keyboard-focus
assertions.

**Architecture:** A focused Vitest guard pins the predecessor, Room helper and
shared login/account sources, exact seven-identity Android ownership and every
forbidden shortcut. One serial Node/Maestro journey arranges a fresh private
Room through real Synapse and drives login, Room navigation, insert tray, voice
selection, Android permission and send through native touch. A bounded host/
emulator microphone harness feeds a deterministic PCM tone into the emulator's
real audio-input route without patching Web APIs. Read-only renderer
observations prove exact geometry, replacement and status semantics; direct
Synapse observation proves the resulting encrypted upload metadata is a
non-empty `m.audio` event with the MSC3245 voice marker. The audio path fails
closed into a reviewed capability-exclusion artifact when real capture cannot
be established.

**Issue:** #769, blocked on #768 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned voice-message predecessor, application-login and account
  sources unchanged.
- Record exactly seven globally unique stage-local identities: Room readiness,
  positive resting-field height, recording surface visible, equal recording
  height, normal composer field hidden, exact live-status semantics and visible
  rendered voice player.
- Retain Chromium fake-media launch flags and the cancel/send/composer keyboard-
  focus assertions as browser/desktop coverage only. Do not claim them from a
  touch-first Android run.
- Arrange one fresh creator Account and private Room through real Synapse; stop
  fixture mutation before the installed observation begins.
- Feed a deterministic bounded tone through the host audio server and the real
  Android emulator microphone route. Do not patch `getUserMedia`, replace
  `MediaRecorder`, inject a `Blob`, seed an outgoing event or use Chromium fake-
  media flags as Android evidence.
- Run a fail-closed capability probe for host source liveness, emulator audio-
  input routing, Android/WebView recording support and permission ownership
  before claiming product parity. Requested configuration is not evidence of
  captured audio.
- Maestro/native device input owns every reachable product action: login, Room
  navigation, tray/voice selection, permission handling, send and cancel during
  cleanup.
- Renderer inspection is read-only. It may observe visibility, exact text/role,
  geometry and player presence but may not click, focus, fill, submit, navigate,
  invoke handlers or create/replace media APIs.
- REST may arrange and observe Matrix state. The sent-event proof must come from
  real Synapse and include non-empty uploaded media plus exact `m.audio` and
  `org.matrix.msc3245.voice` content semantics.
- Use one attempt, zero retries, finite observation and bounded Matrix/device/
  microphone/permission/application teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster and
  captured-audio diagnostics and redact credentials, access tokens, media URLs,
  Room/event ids and host-audio endpoint details.
- Keep PR #677 draft/open and unmerged.

## Exact Android runtime identity map

1. `voice-message.room-ready`
2. `voice-message.resting-field-height-positive`
3. `voice-message.recording-visible`
4. `voice-message.recording-height-equal`
5. `voice-message.composer-field-hidden`
6. `voice-message.recording-status-live`
7. `voice-message.player-visible`

Server-side non-empty `m.audio`/MSC3245 proof and microphone capability evidence
are mandatory supporting receipts, not extra parity identities. The three
desktop focus assertions remain exclusively in the unchanged predecessor.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/voice-message-migration.spec.mjs`.

- [ ] Pin the predecessor hash, exact definition and Room-helper spans,
      application/account hashes, six Android-applicable direct assertion sites,
      one Room-readiness expansion and the three retained focus assertions.
- [ ] Require the exact seven ids above, one stage, exact count/global
      uniqueness and one-to-one source mappings.
- [ ] Require one fresh creator/private Room fixture, sealed mutation boundary
      and native login/Room/tray/voice/permission/send ownership.
- [ ] Require a deterministic host tone, real emulator audio-input route,
      explicit bounded capability probe and exact source restoration.
- [ ] Require positive resting geometry, visible equal-height recording surface
      within the predecessor's strict `< 1 px` delta, hidden normal field, exact
      `Voice recording started` role `status` semantics and real player.
- [ ] Require direct Synapse proof of a new non-empty uploaded `m.audio` event
      with an own-property MSC3245 voice marker after approximately 1.2 seconds
      of real capture.
- [ ] Reject Web API monkey patches, injected media/blob/events, Chromium fake-
      device Android proof, DOM click/focus/fill/submit/navigation, invoked
      handlers, surface-only recording claims, touch focus assertions, retries,
      unbounded waits and weak cleanup/redaction.
- [ ] Require an effective microphone capability fault control and a structured
      exclusion artifact that cannot be reported as seven passing identities.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for Account/Room ownership, each identity,
      tone/source/route/capability facts, native action ownership, permission,
      geometry/status, duration, media bytes/content/marker, cleanup and
      redaction.
- [ ] Run `pnpm exec vitest run scripts/voice-message-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and sealed Matrix fixture

**Files:**

- Create `e2e/android/voice-message-contract.mts`.
- Create `e2e/android/voice-message-fixtures.mts`, reusing exact lower-level
  Account/Room operations where possible.

- [ ] Export exact source mappings, one stage id and all seven identities;
      assert totals and global uniqueness at module load.
- [ ] Create/login one fresh creator Account, create one uniquely named private
      Room and observe it through real Synapse before sealing fixture mutation.
- [ ] Capture the pre-journey event boundary so only a later real `m.room.message`
      can satisfy the sent voice-event receipt.
- [ ] Poll the creator's real Room history after send, select only the new event,
      and prove exact `msgtype: m.audio`, own MSC3245 marker, media reference,
      positive declared size and retrievable non-empty media bytes.
- [ ] Retain only sanitized boolean/cardinality/byte-count facts while keeping
      password, access token, Room/event ids and media URL/content closure-
      private.
- [ ] Aggregate cleanup must handle partial setup and release the Account/Room,
      media access, application and device state within bounds.
- [ ] Extend the focused guard so wrong role/preset/event boundary/type/marker,
      zero/missing media, seeded event, mutation after seal, unbounded Matrix
      work or leaked secret fails.
- [ ] Run the focused guard to the microphone-only RED boundary and run Android
      typecheck.

## Task 3: Implement the real emulator microphone harness and capability gate

**Files:**

- Create `e2e/android/voice-message-microphone.mts`.
- Modify `e2e/android/maestro-session.mts` only where an owned emulator needs an
  explicit audio-capable launch mode.
- Modify CI prerequisite/workflow setup only as needed to expose the same real
  audio route to the borrowed hosted emulator.
- Add focused harness tests under `scripts/`.

- [ ] Generate a bounded deterministic PCM tone in ignored output and route it
      through a harness-owned host audio sink/source; do not commit audio media.
- [ ] Snapshot the prior host default input/source/modules, make the harness
      source the emulator input for this journey and restore the exact prior
      state in `finally`.
- [ ] Launch or borrow the API 36 emulator with real audio input enabled; reject
      `-no-audio`/`-noaudio` for this capability while leaving unrelated runner
      behavior unchanged.
- [ ] Prove host tone heartbeat/amplitude, emulator audio-input route and
      Android microphone feature before opening the product recording surface.
- [ ] Prove the installed WebView exposes unmodified `getUserMedia` and
      `MediaRecorder` support without calling or replacing either API from the
      observer.
- [ ] Query Android permission state before the product request; allow the real
      permission dialog to appear and require native handling when not already
      granted.
- [ ] Emit only sanitized capability facts, exact emulator/profile provenance
      and bounded timing. Never persist tone/capture bytes, source endpoint
      names or raw audio-server dumps.
- [ ] If host source, emulator route, WebView capability or native permission
      ownership cannot be proven, stop before parity assertions and write a
      machine-readable reviewed capability-exclusion artifact. Do not fall back
      to a JavaScript oscillator, fake launch flag or fixture event.
- [ ] Extend the focused guard through the journey-only RED boundary, including
      fault controls for every probe fact and exact source teardown; run harness
      tests and Android typecheck.

## Task 4: Implement native recording and rendering parity

**Files:**

- Create `e2e/android/voice-message-journeys.mts`.

- [ ] Start the microphone harness/probe, sign in as the creator and open the
      exact Room through native Maestro actions; record Room readiness once.
- [ ] Read the real resting `composer-field` geometry and prove positive height;
      record identity 2 once.
- [ ] Tap the composer insert control and exact Voice message item natively. If
      Android presents the microphone permission surface, select the required
      grant natively and prove the app owns the resulting permission.
- [ ] Through one settled read-only observation, prove the recording surface is
      visible, its height differs from the resting field by strictly less than
      1 px, the normal composer field is not visible and exact text
      `Voice recording started` has role `status`; record identities 3–6.
- [ ] Keep the deterministic real source recording for a measured interval of
      approximately 1.2 seconds, then tap the production send control natively.
- [ ] Prove the real timeline's first new `voice-message` player is visible and
      record identity 7; Room-list previews or injected rows cannot satisfy it.
- [ ] Poll the sealed Matrix fixture for the new event and non-empty media,
      recording the mandatory `m.audio`/MSC3245/positive-byte supporting receipt.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting and fixture/microphone/permission/native-action/
      geometry/status/media receipts.
- [ ] Scan aggregate diagnostics for credentials, tokens, Room/event/media ids,
      audio endpoints and raw bytes; always cancel an active recording natively,
      revoke/restore permission state, stop/restore the source, clear application
      data, close the client and release Matrix/device resources on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 5: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `voice-message` target with the Android APK build,
      a bounded Node/audio timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.voice-message` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Make the hosted emulator audio-capable without installing a fake WebView
      device; start the bounded deterministic host source only for this target
      and guarantee started-only source restoration on every exit path.
- [ ] Invoke the target on shard 2 immediately after timeline-virtualization
      with a bounded wrapper and started marker; add started-only
      `android-voice-message` diagnostics and the structured capability artifact.
- [ ] Extend registry/workflow guards for exact ordering, timeout, audio-capable
      launch, source lifecycle, artifact path, no-audio/no-raster policy,
      capability-exclusion semantics and teardown requirements.
- [ ] Document pinned ownership, seven identities/one stage, retained desktop
      coverage, real host/emulator microphone route, permission/native actions,
      exact geometry/status and server media proof.
- [ ] Run focused migration, microphone harness, registry and workflow tests
      GREEN, then the full scripts test target.

## Task 6: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:voice-message --skipNxCache` three
      times sequentially on unchanged inputs; require one stage, 7/7 identities,
      attempt 1 and retries 0 each time.
- [ ] If the real microphone hard gate is triggered, require three unchanged
      matching exclusion artifacts and explicit review before accepting that
      limitation; no run may silently omit or pass the infeasible identities.
- [ ] Audit sealed fixture/event boundaries, real source/route/probe, native Room/
      tray/voice/permission/send actions, strict geometry, replacement/status,
      real player and Synapse `m.audio`/MSC3245/non-empty-media receipts. Require
      no raster or audio artifacts and clean source/permission/Matrix/
      application/device teardown.
- [ ] Run the complete unchanged voice-message browser predecessor with one
      worker and `--retries=0`; require its recording, fake-device and desktop
      focus coverage to pass, then recheck all three pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls, capability disposition and
      artifacts in the ledger.

## Task 7: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor and dedicated Android artifact; require one
      stage, every feasible identity, attempt 1/retries 0, exact fixture/audio/
      permission/native-action/geometry/status/media receipts, reviewed
      capability disposition, redaction, teardown and clean worktree.
- [ ] Post evidence to #769, #660, #653 and PR #677; close #769 only after all
      acceptance evidence is complete, then continue with #770.
