# Android Recovery Reset Migration Design

- **Issue:** #726
- **Status:** Approved
- **Target branch:** `test/726-android-recovery-reset`
- **Integration branch:** `test/676-android-sidebar-filter`

## Purpose

Replace all four password-account recovery-reset definitions with faithful
installed-Android Maestro/Node coverage while preserving the complete
Playwright predecessor. The native suite must exercise real cross-signing,
secret storage, key backup, conditional password UIA, destructive reset,
cancel atomicity, original-key recovery, and the second-device Settings escape
hatch without product hooks or renderer actions.

This is test infrastructure only. Product code and canonical predecessors stay
unchanged.

## Canonical ownership

The contract pins these sources:

- `e2e/browser/journeys/trust/recovery-reset.spec.mts`, SHA-256
  `fad6cee0f80c92770978a672129c66a1ab22c9a7504a1068970673cbca08b848`:
  lines 27–74 own conditional UIA and encryption setup; lines 79–180,
  182–242, 244–313 and 315–362 own the four stages and exactly
  22 + 12 + 15 + 5 = 54 direct assertion sites.
- `e2e/support/app.mts`, SHA-256
  `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`:
  owns UI login and Rooms readiness.
- `e2e/support/account.mts`, SHA-256
  `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`:
  owns server default-key, key-backup-version and master-key observations.

`e2e/android/recovery-reset-contract.mts` exports the exact source map and 54
stable direct identities grouped by stage. Setup-helper expansion is required
for all four stages, and the original-key stage separately proves final Rooms
readiness. Helper obligations remain explicit runtime steps rather than
inventing extra direct identities.

## Architecture

### Contract and focused guard

`scripts/recovery-reset-migration.spec.mjs` pins all three source hashes,
source boundaries, assertion-site counts, helper calls and two-device
ownership. It requires native actions, REST-only setup/observation, read-only
renderer observation, both application packages, exact registration and
predecessor retention.

The guard rejects DOM click/focus/fill/submit/navigation, renderer reload or
handler invocation, mock Trust state, missing non-vacuity checks, retries,
unbounded observation, incomplete two-package teardown, and any diagnostic
path that can publish passwords, tokens, UIA material or recovery keys.
Effective mutations cover the irreversible warning, four rendered lines,
wrong-word feedback and pointer stability, pre-state non-vacuity, replacement
key uniqueness, cancel atomicity, original-key unlock, escape-hatch ownership,
cleanup and redaction.

### Real lost-key topology

Each stage uses one disposable password account and two installed packages:

1. The primary package signs in and establishes real cross-signing, secret
   storage and key backup through the product UI.
2. The recovery key is observed only in process memory, registered immediately
   as a secret, acknowledged natively, and never written to diagnostics.
3. Server default-key, backup-version and master-key state is observed through
   bounded authenticated REST calls whose token remains private to the fixture.
4. The clean secondary package signs into the same account. It naturally
   reaches `needs-recovery`, so Settings and the Rooms banner expose the real
   unlock/reset product actions without direct route navigation.

This topology is more faithful than the predecessor's direct
`/encryption/unlock` navigation: reset belongs to a device that cannot recover,
while the primary device remains an independent ready-posture witness.

### Native stages

`e2e/android/recovery-reset-journeys.mts` reuses a package-configurable
`AccountWorkspaceClient`, account fixtures, Maestro lifecycle, and read-only
WebView observation.

The `replacement-key-reset` stage:

- establishes non-empty original recovery/default/backup/master state;
- opens the secondary unlock flow through native Settings navigation;
- proves the exact irreversible warning and four rendered consequence lines;
- enters a wrong word natively and proves the reset stayed atomic with explicit
  RESET feedback;
- enters exact RESET, answers conditional password UIA natively, and proves a
  non-empty different replacement key;
- proves the acknowledgement button disabled/enabled gate, changed server
  pointer, and ready Security posture after a package relaunch.

The `password-cancel-atomicity` stage:

- records non-vacuous default-key, backup and master state;
- reaches the password gate after exact RESET and cancels natively;
- proves no recovery key, reset re-enabled, unchanged backup/default state,
  and unchanged ready posture on the primary package.

The `original-key-after-cancel` stage repeats the authenticated cancel, then
enters the exact original recovery key natively on the secondary package. It
requires Account-qualified Rooms, no unlock error, ready Security posture, and
unchanged master/default/backup identifiers.

The `secondary-settings-escape-hatch` stage opens Settings → Security on the
clean secondary package, proves Enter recovery key and the lost-key action
coexist, opens the reset gate through the lost-key action, then cancels and
remains on the owning unlock surface.

Maestro owns every reachable product action. REST may create accounts and read
server state. Renderer inspection may read text, visibility, disabled state,
focus and URL only; it may not click, focus, fill, submit, invoke handlers,
reload or navigate.

### Shared harness changes

`AccountWorkspaceClient` receives an immutable application ID defaulting to
`eu.qwky.trinity`. Every clear, grant, launch, flow, keyboard, paste, swipe and
capture operation uses that ID. A focused guard proves the default remains
backward compatible and that `eu.qwky.trinity.secondary` reaches the same
native-action path.

`createAccountFixtures` adds bounded `defaultKeyId`, `keyBackupVersion` and
`masterKey` observations. Access tokens remain closure-private and never enter
assertion or diagnostic values.

### Secrets, artifacts and cleanup

The recovery key, password, access token and any UIA/session material are
registered before an action can write diagnostics. Assertions record only
booleans, opaque equality/change outcomes and stable identity names. Raw key
values and server bearer material never appear in ledgers or logs.

Pass/failure proof uses secret-safe capture. If a one-time recovery key is
visible, the suite records a redacted structural snapshot and does not persist
a raw WebView/device screenshot. Ordinary surfaces retain device and WebView
captures. Text artifacts are redacted and then scanned for every registered
secret and bearer/key patterns.

Cleanup is aggregate and bounded: close the active WebView/viewport, force-stop
and clear both packages, logout REST sessions, close Maestro and stop Synapse.
A cleanup failure fails the suite.

### Nx, registry and hosted execution

Register suite `android.recovery-reset`, Nx target `recovery-reset`, and package
command `e2e:android:recovery-reset`. The uncached, non-parallel target owns
serialized `android-avd` and `synapse` resources and depends on both verified
primary and secondary APK targets.

Place it after Security settings on Android shard 4 with a started-only
`android-recovery-reset` artifact. Hosted evidence must preserve the renderer
manifest plus both APK hashes and exact device/profile provenance.

## Validation and acceptance

Implementation is test-first: the focused guard starts RED, then contract,
harness, journey, wiring and documentation make it GREEN. Run focused and full
script tests, registry/workflow guards, Android/browser typecheck and lint,
formatting, architecture, production renderer/manifest, Android host and
documentation gates.

Then run three sequential unchanged installed-Android first attempts with zero
retries. Run the four exact unchanged recovery-reset Playwright predecessors
sequentially with retries disabled. After independent review, publish the
feature branch and verified commits to `test/676-android-sidebar-filter`, audit
original-attempt hosted Android/browser/renderer artifacts, and update #726,
#660, #653 and PR #677. Keep PR #677 draft/open and unmerged.

## Rejected alternatives

- **Direct CDP/router navigation:** explicitly forbidden and would bypass the
  real product entry point.
- **Add reset to the ready Security posture:** changes product behavior and
  contradicts the existing ownership model.
- **Counterfeit Trust state or mock crypto:** cannot prove server pointers,
  key backup, cross-signing or actual key viability.
- **Use unchanged pointers as key proof:** misses the user-facing failure where
  the original key can no longer unlock.
- **Persist raw key screenshots and redact later:** binary artifacts can retain
  the secret; secret-safe capture must prevent the write.
