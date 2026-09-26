# Android Security Settings Migration Design

- **Issue:** #725
- **Status:** Approved
- **Target branch:** `test/725-android-security-settings`
- **Integration branch:** `test/676-android-sidebar-filter`

## Purpose

Replace the two Android-applicable Security settings paths with deterministic
installed-Android Maestro/Node coverage while preserving the complete
Playwright predecessor. The migration proves the fresh first-device trust
posture, setup routing, narrow verification routing, close behavior and focus
restoration without adding production hooks or claiming the browser-only Trust
fault injection as Android coverage.

This is test infrastructure only. Product code and canonical predecessors stay
unchanged.

## Canonical ownership

The contract pins these sources:

- `e2e/browser/journeys/trust/security-settings.spec.mts`, SHA-256
  `7da77f2e6b8d2091709ca6565bd54a08ed97115cce71e887ad1c46b6f5767fd9`:
  lines 51–84 own the fresh posture/setup path, lines 86–136 own the
  narrow-surface path with Android lines 105–121, and lines 138–223 remain the
  browser-only production-hook exclusion.
- `e2e/support/journeys/navigation.mts`, SHA-256
  `43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81`:
  lines 11–60 own the three inherited Android Settings obligations consumed by
  each stage.
- `e2e/support/app.mts`, SHA-256
  `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`.
- `e2e/support/account.mts`, SHA-256
  `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.

The contract has 15 unique stage-local identities: five posture assertions,
four narrow verification assertions, and three inherited navigation
assertions for each stage. Route transitions are carried by the action-adjacent
identity that owns them, preserving the predecessor's nine direct assertion
sites without inflating the count.

## Architecture

### Contract and focused guard

`e2e/android/security-settings-contract.mts` exports exact source spans and the
15 stable identities. `scripts/security-settings-migration.spec.mjs` pins the
four hashes, source boundaries, 5 + 4 direct shape, six inherited identities,
Android route branches, and the exact production-hook exclusion.

The guard rejects DOM click/focus/submit/navigation, product debug hooks,
counterfeit transport-fault coverage, missing account registration, retry
paths, unbounded observation, and missing redaction/cleanup. Effective mutation
controls cover posture cards/CTAs, setup routing, narrow verification routing,
both focused headings, the exclusion, and teardown/redaction.

### Native stages

`e2e/android/security-settings-journeys.mts` reuses
`AccountWorkspaceClient`, account fixtures, Maestro lifecycle and the existing
read-only WebView observation seam.

The `fresh-posture-setup` stage uses the established 1280×720 profile:

1. Create a fresh account through the disposable Synapse REST fixture.
2. Sign in through the installed app and prove the Account-qualified Rooms URL.
3. Tap Settings and Security natively while proving navigation and non-empty
   detail readiness.
4. Prove Security settings, session and backup cards, Verify with another
   device, and Set up recovery are visible.
5. Tap Set up recovery natively and prove `/encryption/setup` with exact
   `/settings/security` return target.

The `narrow-verification-return` stage uses the predecessor's exact 700×760
viewport with desktop media/input traits:

1. Create and sign in a separate fresh account.
2. Open Settings → Security through native actions and prove the same inherited
   navigation obligations.
3. Prove Verify with another device visible, tap it natively, and require exact
   `/encryption/verify` full-page routing.
4. Prove the verify surface and focused exact `Verify device` heading.
5. Tap Close natively, require exact `/settings/security`, and prove the exact
   `Security` heading regained focus.

REST only arranges disposable accounts. Renderer observation may read URL,
visibility, text, focus and geometry. Neither may invoke handlers, focus a
control, submit a form, or navigate the application.

### Browser-only fault ownership

`labels failed Trust reads and recovers through the scoped action` remains
enabled in the browser predecessor. Its exact Android skip reason—Angular
development hooks are absent from the production APK—is source-pinned and
guarded. The native suite neither imports Angular hooks nor substitutes an
unrelated HTTP failure.

### Artifacts and cleanup

The suite records a started-stage ledger, 15 assertion artifacts exactly once,
pass/failure device and WebView captures, attempt 1, zero retries, source spans,
durations and renderer/APK/profile provenance. Account passwords and any
session values are registered with `redactMaestroArtifacts`; assertion records
contain no credentials.

Cleanup is aggregate and bounded: leave/forget fixture memberships, logout REST
sessions, close WebView/viewport ownership, close Maestro, stop Synapse, and
preserve every cleanup error. A cleanup failure fails the suite.

### Nx, registry and hosted execution

Register suite `android.security-settings`, Nx target `security-settings`, and
package command `e2e:android:security-settings`. The uncached, non-parallel
target owns serialized `android-avd` and `synapse` resources and depends on the
verified prebuilt Android app.

Place it after the accepted OIDC suite on Android shard 4 with a started-only
`android-security-settings` artifact. Current hosted shard-4 evidence leaves
enough capacity for this two-stage batch; later migrations must rebalance based
on measured timings rather than weaken this suite.

## Validation and acceptance

Implementation is test-first: the focused guard starts RED, then the contract,
journey, wiring and documentation make it GREEN. Run focused and full script
tests, registry/workflow guards, Android/browser typecheck and lint, formatting,
architecture, production build/manifest, Android host and documentation gates.

Then run three sequential unchanged installed-Android first attempts with zero
retries. Run the complete unchanged Security settings Playwright file with one
worker and retries disabled, proving both Android-applicable predecessors and
the retained browser-only Trust fault path.

After review, push the feature branch, cherry-pick only verified commits into
`test/676-android-sidebar-filter`, prove identical trees, and audit the first
hosted Android/browser/renderer artifacts before closing #725. Update #660,
#653 and PR #677. Keep PR #677 draft/open and unmerged.

## Rejected alternatives

- **Add production Trust fault hooks:** violates the explicit production-APK
  boundary and changes product behavior for a browser-only test.
- **Use DOM actions:** would not prove installed-host/native interaction.
- **Reuse one account for both stages:** would couple verification state and
  make the fresh-session posture non-deterministic.
- **Broaden `AccountWorkspaceClient`:** Security behavior has no second shared
  consumer; local helpers keep the existing client stable.
