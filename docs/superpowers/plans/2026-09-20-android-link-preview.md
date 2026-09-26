# Android Link Preview Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical link-preview
definition while preserving its complete Playwright predecessor and hermetic
server-side Open-Graph boundary.

**Architecture:** A focused Vitest guard pins the predecessor, Caddy fixture
and shared login sources, their exact assertion ownership and every forbidden
shortcut. One serial Node/Maestro stage arranges a disposable Matrix Account,
an explicitly plaintext private Room and one exact URL message. Maestro owns
login and Room navigation. A bounded read-only CDP Network observer proves the
WebView requests the authenticated Matrix preview endpoint and never contacts
the private Caddy URL directly; Synapse fetches the pinned fixture and the
renderer exposes the resulting exact card title and destination.

**Issue:** #739, blocked on #738 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned link-preview predecessor, Caddy fixture,
  application-login and account sources unchanged.
- Record exactly three unique identities in one stage: visible preview card,
  exact title and exact destination.
- Matrix REST may arrange the Account, explicitly unencrypted Room and exact
  message event. Maestro owns every product action: login and Room navigation.
- Renderer/CDP access is read-only. It may observe exact card state and
  sanitized Network request facts, but may not intercept or fulfill requests,
  invoke handlers, focus, fill, submit or navigate.
- Prove the WebView calls the exact homeserver preview API for the seeded URL
  and makes no direct request to `http://caddy:8080/og` or its netns loopback
  equivalent. Do not rely on card content alone for server-side provenance.
- Require the Room to remain plaintext; do not enable encryption, bypass URL
  eligibility or call any public preview service.
- Use one attempt, zero retries, finite observation and bounded Network,
  Matrix/application/device teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials, access tokens and request authorization.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/link-preview-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact OG URL constant/definition spans, the
      Caddy hash and exact `/og` fixture span, plus application-login and
      account source hashes.
- [ ] Prove exactly three direct predecessor assertions and require three
      globally unique contract identities in the exact stage.
- [ ] Require an explicitly plaintext private Room, one exact run-scoped
      message containing only the copy plus pinned OG URL, and its exact event
      identity.
- [ ] Require native login/Room actions, a bounded Network observer, one exact
      authenticated Matrix preview request for the seeded URL, zero direct
      private-OG requests, and one visible card with exact title and href.
- [ ] Reject E2EE setup, public preview services, WebView interception or
      fulfillment, broad retained Network data, DOM click/focus/fill/submit/
      navigation, retries, unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for plaintext eligibility, fixture URL,
      message shape, Matrix preview path/query, direct-fetch absence, card
      scoping/title/href, native ownership, observer close, cleanup and
      redaction.
- [ ] Run `pnpm exec vitest run scripts/link-preview-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and bounded Network observer

**Files:**

- Create `e2e/android/link-preview-contract.mts`.
- Create `e2e/android/link-preview-network-observer.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if an exact missing
  plaintext-Room/message operation cannot be composed from existing helpers.

- [ ] Export exact source mappings and the three-identity assertion map; assert
      count and uniqueness at module load.
- [ ] Arrange a private Room without `m.room.encryption`, send exactly one
      `m.room.message` containing the run-scoped copy and selected hermetic OG
      URL, retain its event id and independently prove no encryption state.
- [ ] Keep credentials/tokens inside the fixture closure and return only
      sanitized Account/Room/event/URL facts.
- [ ] Add a bounded CDP Network observer that records sanitized request URL,
      method and initiator category only; recognize the exact Matrix
      `preview_url` endpoint with an exact decoded `url` query and count any
      direct Caddy/netns OG request.
- [ ] Never retain headers, cookies, authorization, response bodies or full
      unrelated URLs; always disable Network and unsubscribe in `close()`.
- [ ] Extend the focused guard so wrong Room encryption, URL/body/event shape,
      broad observation, interception, missing Matrix request, any direct OG
      request or leaked authorization fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement the native preview stage

**Files:**

- Create `e2e/android/link-preview-journeys.mts`.

- [ ] Select the exact Caddy or netns loopback OG URL for the active harness,
      arrange the plaintext Room/message and prove the encryption state absent.
- [ ] Start the bounded Network observer, sign into the installed app and open
      the exact Room through native actions.
- [ ] Wait for exactly one visible `[data-testid="link-preview"]` belonging to
      the exact seeded message row; prove its rendered title is exactly
      `Trinity E2E Preview` and its `href` equals the seeded OG URL.
- [ ] Prove the observer captured the exact homeserver preview request with the
      seeded URL and captured zero WebView requests to the private OG origin.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, plaintext/event receipts, sanitized Network facts
      and aggregate cleanup and redaction scans.
- [ ] Always close the Network observer before the client/device, clear
      installed application data and release Matrix/device resources,
      including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 4: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `link-preview` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.link-preview` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after jump-to-latest with a bounded
      wrapper and started marker; add started-only `android-link-preview`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, three identities, plaintext eligibility,
      native/REST/renderer/Network boundaries, server-side fixture provenance,
      exact card proof, secrets, teardown and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 5: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:link-preview --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 3/3
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens, bearer patterns, authorization/cookie data and
      unrelated Network URLs; require no raster artifacts, no live Network
      observer and clean emulator/application teardown.
- [ ] Run the complete unchanged link-preview browser predecessor with one
      worker and `--retries=0`; require the exact definition to pass and recheck
      all four pinned source hashes.
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
      3/3 identities, attempt 1/retries 0, plaintext/event/Network receipts,
      exact card/provenance proof, redaction, teardown and clean worktree.
- [ ] Post evidence to #739, #660, #653 and PR #677; close #739 only after all
      acceptance evidence is complete, then continue with #740.
