# Android Matrix Links Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for all six Android-applicable
canonical Matrix Room/user-link definitions while preserving every Playwright
predecessor and using real federation, native taps and production Appearance
controls.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
sources, the exact six-stage/63-identity ownership and every forbidden
shortcut. A dedicated fixture layer arranges and observes disposable state on
the primary and federated secondary Synapse servers. One serial Node/Maestro
journey runs the joined, public-federated, inaccessible, join-race, portrait
sheet and user-mention stages. Maestro owns all product actions, including link
activation, preview actions and Light/Dark selection; bounded read-only
renderer observations prove exact state, focus, geometry and contrast.

**Issue:** #747, blocked on #746 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned message-links predecessor, application-login and account
  sources unchanged.
- Record exactly 63 globally unique identities across six stages, preserving
  the source expansion as 38 direct plus 25 helper-expanded records. Stage
  totals are 6 joined, 16 federated public, 9 unavailable, 12 join race, 14
  portrait sheet and 6 user mention.
- Use the real primary and secondary Synapse packages. Do not model federation
  with one homeserver or infer server membership from UI text.
- Matrix REST may arrange, mutate and observe exact local/federated state.
  Maestro owns every reachable product action: login, Room/link/preview actions
  and Appearance Light/Dark selection.
- Renderer inspection and contrast measurement are read-only. They may observe
  exact content, geometry, focus and computed colours, but may not toggle
  classes, invoke handlers, focus controls, press keys, fill, submit, scroll or
  navigate.
- Replace the predecessor's Android focus/Enter workaround with real native
  taps and its direct `dark` class mutation with the production Appearance
  path.
- Use one attempt, zero retries, finite observation and bounded two-server/
  application/device teardown.
- Preserve exact renderer, APK and portrait-profile provenance; remove raster
  diagnostics and redact credentials, access tokens, Room/user secrets and
  federation authorization.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/message-links-migration.spec.mjs`.

- [ ] Pin the predecessor hash and exact six definition/helper spans plus
      application-login/Preferences and account source hashes.
- [ ] Prove exactly 38 direct assertion sites and helper expansion through four
      local API logins, three remote registrations, eight Room creations, four
      room-link sends and six Room opens.
- [ ] Require the exact six stages and 63 unique identities with stage counts
      `6 + 16 + 9 + 12 + 14 + 6`.
- [ ] Require exact local joined target, remote public alias/name/topic,
      inaccessible remote id, public-to-invite race, portrait local target and
      user permalink fixtures across the two real servers.
- [ ] Require native link/preview/theme actions, real remote membership proof,
      focused retry/open actions, Light/Dark WCAG AA contrast, production
      portrait geometry and Android dialog/no-navigation semantics.
- [ ] Reject one-server federation, synthetic membership, keyboard Enter/focus
      activation, theme-class mutation, generic modal evidence, hidden-only
      unavailable evidence, preview-as-navigation, DOM click/focus/fill/
      submit/navigation, retries, unbounded waits and weak cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for every fixture identity, membership,
      preview/action state, error/retry state, contrast mode/ratio, portrait
      edge/footer measure, dialog model, active Room, two-server cleanup and
      redaction.
- [ ] Run `pnpm exec vitest run scripts/message-links-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and two-server fixture layer

**Files:**

- Create `e2e/android/message-links-contract.mts`.
- Create `e2e/android/message-links-fixtures.mts`.
- Modify `e2e/android/account-workspace-fixtures.mts` only if exact reusable
  local operations are missing.

- [ ] Export exact source mappings, six stage ids, per-stage counts and all 63
      identities; assert totals and global uniqueness at module load.
- [ ] Provide bounded local login, remote registration, Room creation and exact
      formatted Matrix Room/user-link send operations with sanitized receipts.
- [ ] Arrange the joined source/target pair; public remote alias/name/topic;
      inaccessible private remote Room; raceable public remote Room; portrait
      source/target; and named mention target exactly as owned by each stage.
- [ ] Expose a single authoritative operation that changes the race Room's
      remote `m.room.join_rules` from public to invite after preview resolution.
- [ ] Observe exact local membership for the remote Room through Matrix state,
      not UI copy, and retain the joined user/Room/server identity receipt.
- [ ] Keep all credentials, tokens and federation authorization closure-private;
      return only sanitized ids/names/aliases/topics/rules/membership facts.
- [ ] Track every created account and Room on both homeservers and perform
      bounded aggregate cleanup even after partial setup or stage failure.
- [ ] Extend the focused guard so server substitution, wrong alias/via/link
      encoding, fixture leakage, unbounded REST work or incomplete two-server
      cleanup fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement joined, federated and unavailable stages

**Files:**

- Create `e2e/android/message-links-journeys.mts`.

- [ ] Joined stage: open the source Room and tap its exact link natively; prove
      preview visible, exact target name, `Open room`, source composer still
      active, then tap Open natively and prove exact target navigation. Record
      its six identities exactly once.
- [ ] Public-federated stage: resolve the exact remote alias and prove remote
      name/topic, `Join room` and unchanged source; tap Join natively, prove
      authoritative remote membership, `Room joined`, action transition to
      focused `Open room`, then record the owned Light/Dark contrast identities
      through the production theme path.
- [ ] Reopen the same preview through native actions as needed without losing
      its exact remote identity; tap Open natively and prove remote Room
      navigation. Record all 16 stage identities exactly once.
- [ ] Unavailable stage: tap the exact inaccessible remote link natively and
      prove visible exact not-found/unavailable guidance plus absence of any
      primary action. Record all nine identities exactly once.
- [ ] Never activate a preview action by focus/Enter, infer remote membership
      from success text, or use renderer input/mutation.

## Task 4: Implement race, portrait and mention stages

- [ ] Join-race stage: resolve the exact valid public remote preview and prove
      initial `Join room`; change the authoritative secondary-server rule to
      invite, tap Join natively, then prove visible action error while the same
      preview remains visible and its focused `Join room` action is retryable.
      Record all 12 identities exactly once.
- [ ] Portrait stage: use the pinned production portrait device profile, open
      the exact joined target preview natively, and prove visible phone-sheet
      class, exact `Open room`, portrait orientation, full viewport-width and
      bottom alignment within one pixel, and a wholly reachable action footer.
      Record all 14 identities exactly once.
- [ ] Mention stage: tap the exact named user permalink natively and prove the
      exact user card/name, Android dialog model, zero connected-position
      popover containers and unchanged original Room. Record all six identities
      exactly once.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting, fixture/membership/rule/theme/contrast/geometry
      receipts and aggregate cleanup/redaction scans.
- [ ] Always restore/close observers, clear installed application data and
      release both Matrix servers and device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 5: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `message-links` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.message-links` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after message-linkify with a bounded
      wrapper and started marker; add started-only `android-message-links`
      diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, 63 identities/six stages, two-server
      federation, native/REST/renderer boundaries, membership/race proof,
      production themes/contrast, portrait/dialog contracts, secrets, teardown
      and predecessor coexistence.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 6: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:message-links --skipNxCache` three
      times sequentially on unchanged inputs; require 6/6 stages, 63/63
      identities, attempt 1 and retries 0 each time.
- [ ] Scan every retained text/binary diagnostic path for credentials,
      access/session tokens, bearer/federation authorization and exact Room/
      user secrets; require no raster artifacts and clean two-server/
      application/device teardown.
- [ ] Run the complete unchanged message-links browser predecessor with one
      worker and `--retries=0`; require the five canonical-browser definitions
      to pass and only the explicitly Android-WebView-only portrait definition
      to skip, while all six installed stages pass, then recheck all three
      pinned source hashes.
- [ ] Run full repository validation selected by the migration change,
      including typecheck, lint, format, architecture, production renderer,
      Android APK/host and documentation checks.
- [ ] Record exact commands, revisions, renderer/APK/profile hashes,
      invocation IDs, durations, negative controls and artifacts in the ledger.

## Task 7: Review, publish and hosted acceptance

- [ ] Review the complete feature diff for correctness, security boundaries,
      source preservation, test quality and recoverability; resolve every
      finding.
- [ ] Re-run publication checks and confirm clean status plus unchanged source
      hashes.
- [ ] Commit only task-owned files, push the consolidated branch, and keep PR
      #677 draft/open and unmerged.
- [ ] Audit the first hosted merge SHA, renderer manifest, Android APK/profile,
      exact browser predecessor, dedicated Android artifact, 6/6 stages, 63/63
      identities, attempt 1/retries 0, two-server fixture/membership/race,
      theme/contrast, portrait/dialog receipts, redaction, teardown and clean
      worktree.
- [ ] Post evidence to #747, #660, #653 and PR #677; close #747 only after all
      acceptance evidence is complete, then continue with #748.
