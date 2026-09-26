# Android Slash Command Migration Implementation Plan

> **Execution:** Use `superpowers:executing-plans`,
> `superpowers:test-driven-development` and
> `superpowers:verification-before-completion`; subagent delegation is not part
> of this plan.

**Goal:** Add faithful installed-Android parity for the canonical slash-command
definition while preserving its Playwright predecessor and proving real native-
keyboard command entry, autocomplete completion and sends.

**Architecture:** A focused Vitest guard pins the predecessor and shared login
and account sources, the exact one-stage/fourteen-identity ownership and every
forbidden shortcut. One serial Node/Maestro journey arranges a fresh creator
and private Room through Synapse, then drives `/shrug`, `/plain` and `/me`
entirely through native Android composer/keyboard actions. Read-only renderer
observations prove exact send readiness, outputs, autocomplete counts and
completion value without assigning input state or invoking handlers.

**Issue:** #762, blocked on #761 original-attempt hosted acceptance until the
implementation phase begins.

## Global constraints

- Preserve the pinned slash-commands predecessor, application-login and
  account sources unchanged.
- Record exactly fourteen globally unique identities in one stage: eleven
  static assertion sites, with the local send-readiness site executing at three
  call sites, plus one Room-readiness expansion.
- The exact identity sequence is Room readiness; `/shrug` send readiness and
  output; `/plain` send readiness and literal output; bare-menu visibility and
  option count; narrowed option count and `/me` text; completion menu hidden
  and exact `/me ` composer value; final send readiness; `waves` output; and
  literal `/me` absence.
- Arrange one fresh creator Account and private Room through real Synapse. Do
  not seed any owned command result.
- Maestro/native device input owns every reachable product action: login, Room
  navigation, exact composer entry/replacement, native Enter completion and all
  sends.
- Renderer inspection is read-only. It may observe exact text/count/value/
  visibility/enabled state but may not click, focus, fill, submit, navigate,
  invoke completion/send handlers or assign composer values.
- Native Enter on narrowed `/m` must complete the composer to exact `/me ` and
  close autocomplete without sending. Only the later native entry of `waves`
  and send may create the emote result.
- Use one attempt, zero retries, finite observation and bounded Matrix/
  application/device/keyboard teardown.
- Preserve exact renderer, APK and device-profile provenance; remove raster
  diagnostics and redact credentials plus the access token.
- Keep PR #677 draft/open and unmerged.

## Task 1: Add the focused migration guard in RED

**Files:**

- Create `scripts/slash-command-migration.spec.mjs`.

- [ ] Pin the predecessor hash, exact definition/Room-helper spans, eleven
      static assertion sites, three send-readiness calls, Room-helper call and
      both shared-source hashes.
- [ ] Require exactly one stage with the fourteen globally unique identities in
      their pinned source-to-record mapping and order.
- [ ] Require native entry/send for exact `/shrug oh well` and
      `/plain **not bold**`, exact expanded/literal timeline outputs and a real
      enabled production send control before each send.
- [ ] Require native bare `/` and replacement with `/m`, exact autocomplete
      visibility/count/text, native Enter completion-without-send, menu closure
      and exact `/me ` composer value.
- [ ] Require native `waves` continuation, third send readiness/send, positive
      `waves` output and zero literal `/me` timeline matches.
- [ ] Reject REST-seeded results, direct composer assignment, DOM click/focus/
      fill/submit/navigation, completion/send handler invocation, synthetic
      keyboard events, completion that sends, retries, unbounded waits and weak
      cleanup/redaction.
- [ ] Require Nx/package/registry/CI/docs wiring, serialized `android-avd` +
      `synapse` resources, started-only diagnostics and predecessor retention.
- [ ] Add effective mutation controls for exact command/argument/kaomoji/
      Markdown strings, all three readiness calls, bare/narrow option counts,
      option text, Enter action, no-send boundary, `/me ` value, final output/
      absence, native ownership, cleanup and redaction.
- [ ] Run `pnpm exec vitest run scripts/slash-command-migration.spec.mjs` and
      preserve the expected RED result.

## Task 2: Add the exact contract and empty-Room fixture

**Files:**

- Create `e2e/android/slash-command-contract.mts`.
- Create `e2e/android/slash-command-fixtures.mts`, reusing exact lower-level
  Account/Room operations where possible.

- [ ] Export the exact source mapping, single stage id/count and all fourteen
      identities; assert the total and global uniqueness at module load.
- [ ] Create/login one fresh creator Account and create one private Room without
      seeding any message or command output.
- [ ] Retain sanitized exact Account/Room facts while keeping the password and
      access token closure-private.
- [ ] Provide finite optional Matrix observers only for authoritative sent-
      event receipts; renderer timeline output remains required and server
      content may not replace product-visible command proof.
- [ ] Aggregate cleanup must handle partial setup and release the Account/Room
      through bounded real-server operations.
- [ ] Extend the focused guard so any seeded message, wrong Room/account,
      server-only outcome substitution, unbounded Matrix work or leaked secret
      fails.
- [ ] Run the focused guard to the journey-only RED boundary and run Android
      typecheck.

## Task 3: Implement native shrug and plain commands

**Files:**

- Create `e2e/android/slash-command-journeys.mts`.

- [ ] Sign in/open the exact Room natively and record its expanded readiness
      identity.
- [ ] Enter exact `/shrug oh well` through native Android input, prove the real
      send control is enabled, send natively and prove exact
      `oh well ¯\_(ツ)_/¯` timeline text.
- [ ] Replace the composer content through native keyboard editing only, enter
      exact `/plain **not bold**`, prove send readiness and send natively.
- [ ] Prove exact literal `**not bold**` remains visible in the real timeline,
      including the asterisks rather than bold Markdown rendering.

## Task 4: Implement native autocomplete and emote completion

- [ ] Enter a bare `/` natively and prove autocomplete visible with more than
      one option.
- [ ] Replace it natively with `/m`; prove exactly one option whose text
      contains `/me`.
- [ ] Press native Enter once and prove the menu closes while the composer
      becomes exactly `/me `; also prove no new timeline event appeared at this
      completion boundary.
- [ ] Enter exact `waves` through native continuation input, prove the send
      control is enabled and send through native input.
- [ ] Prove `waves` appears in the real timeline while literal `/me` text has
      zero matches. Record all fourteen identities exactly once.
- [ ] Write started-stage reports, pass/failure secret-safe captures, exact
      assertion accounting and native-input/send-readiness/output/autocomplete/
      completion/no-send/emote receipts.
- [ ] Scan aggregate diagnostics for credentials/access tokens; always dismiss
      the keyboard, clear application data, close the client and release
      Matrix/device resources, including on failure.
- [ ] Run the focused guard to the wiring-only RED boundary and run Android
      typecheck.

## Task 5: Register Nx, registry, CI and documentation

**Files:**

- Modify `e2e/android/project.json`, `package.json`,
  `e2e/registry/suites/runners.mts`, `e2e/registry/commands.mts`,
  `.github/workflows/ci.yml`, registry/workflow guard tests and
  `e2e/android/MIGRATION.md`.

- [ ] Add an uncached serial `slash-command` target with the Android APK build,
      a bounded Node timeout and `android-avd` + `synapse` resources.
- [ ] Register `android.slash-command` as required current hosted Android
      coverage and add exact command metadata.
- [ ] Invoke it on shard 2 immediately after seen-by with a bounded wrapper and
      started marker; add started-only `android-slash-command` diagnostics.
- [ ] Extend registry/workflow guards for exact ordering, timeout and artifact
      path.
- [ ] Document pinned ownership, fourteen identities/one stage, native command
      entry/send, exact shrug/plain outputs, real autocomplete, Enter no-send
      completion, emote result, secrets and keyboard/device teardown.
- [ ] Run focused migration, registry and workflow tests GREEN, then the full
      scripts test target.

## Task 6: Local runtime and repository acceptance

- [ ] Run the focused guard and all source-selected static gates.
- [ ] Run `pnpm nx run trinity-e2e-android:slash-command --skipNxCache` three
      times sequentially on unchanged inputs; require 1/1 stage, 14/14
      identities, attempt 1 and retries 0 each time.
- [ ] Audit all native command/edit/Enter/send actions, three readiness checks,
      exact outputs, autocomplete counts/text, completion no-send boundary and
      emote receipts; require no raster artifacts and clean Matrix/keyboard/
      application/device teardown.
- [ ] Run the unchanged slash-commands browser predecessor with one worker and
      `--retries=0`; require its sole definition to pass, then recheck all three
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
      exact browser predecessor and dedicated Android artifact; require 1/1
      stage, 14/14 identities, attempt 1/retries 0, native command/send/
      autocomplete/completion/emote receipts, redaction, teardown and clean
      worktree.
- [ ] Post evidence to #762, #660, #653 and PR #677; close #762 only after all
      acceptance evidence is complete, then continue with #763.
