# Android Clear-All-Data Migration Design

## Scope

Issue #721 migrates the Android-applicable obligations from
`e2e/browser/journeys/accounts/clear-all-data.spec.mts` into an installed-app
Maestro/Node suite. The browser predecessor remains enabled and unchanged. The
suite owns two functional stages and four visual stages:

1. A signed-in installation with live Matrix clients and open sync/crypto
   IndexedDB databases.
2. A signed-out installation with the exact dead push-gateway preference.
3. Trinity light, Trinity dark, Amethyst light and Amethyst dark rest-state
   destructive styling.

The source owns 14 direct assertion sites. The functional helper expands once
in each functional stage, and the three visual sites expand across four visual
definitions, producing exactly 25 stage-local Android parity identities.

## Source ownership

- `e2e/browser/journeys/accounts/clear-all-data.spec.mts`, SHA-256
  `271c63f2e49f27d7c99d4d0d75c7b844d466d70afe69afda71d1335bcc0b1e9c`
  - lines 37–80: storage/database observation and confirmation helpers
  - lines 85–151: signed-in wipe
  - lines 153–176: signed-out wedged-preference wipe
  - lines 193–253: four generated visual definitions
- `e2e/support/app.mts`, SHA-256
  `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
- `e2e/browser/support/contrast.mts`, SHA-256
  `5c5561a7cd599679a95735fe82cbe14b95faf93c359f3f4ef7e85aa386b2b7f3`

## Architecture

`clear-all-data-contract.mts` owns source mappings, 25 stable identities and
the precise Android hover exclusion. `clear-all-data-observer.mts` is a
read-only host/renderer observer: it enumerates IndexedDB, reads authoritative
`CapacitorStorage.xml`, seeds setup preferences only through Capacitor's real
Preferences bridge, observes the Android media profile and measures rendered
danger-token contrast with the same canvas/compositing model as the browser
helper. It cannot click, focus, fill, submit, navigate or invoke product
handlers.

`clear-all-data-journeys.mts` owns the six stages and every reachable product
action through `AccountWorkspaceClient` native Maestro taps/fills. The
signed-in stage creates a disposable account, signs in, proves the account
preference plus sync and crypto databases, opens Add account through the real
account menu, proves the exact mistype feedback and unchanged state, then
confirms with lower-case `reset trinity`. After the application replaces its
document, it proves the login surface, deletion of every observed database and
an empty native preference namespace. The signed-out stage seeds the exact
dead push gateway, proves it on disk, confirms with uppercase `RESET TRINITY`,
then proves the fresh signed-out document and empty native namespace.

Each visual stage seeds `trinity.appearance.mode` and
`trinity.appearance.theme` through the bridge, then proves the applied root
state, equality between the rendered label and `--trinity-danger`, and a WCAG
AA normal-text contrast ratio of at least 4.5:1.

## Native hover feasibility

The installed Android viewport already proves the real media profile
`hover: none` and `pointer: coarse`. Touch can create trusted pointer input but
does not expose a supported persistent hover path for the source-pinned
`button.hover()` state. Therefore Android owns the three rest-state sites in
each visual definition, while the retained browser predecessor exclusively
owns hover. The contract records this as an explicit platform exclusion. The
Android suite must not dispatch pointer events, call DOM hover APIs or treat a
tap/long-press as hover.

## Boundaries and evidence

- Secure access-token storage is native and is not claimed through WebView
  `localStorage`; native Preferences erasure is proven from the host by reading
  `shared_prefs/CapacitorStorage.xml` with `run-as`.
- Setup/observation may use Capacitor Preferences, IndexedDB enumeration,
  computed styles and canvas. Those seams must remain read-only with respect to
  product behavior.
- All runs use one attempt and zero retries, bounded document-swap recovery,
  secret redaction, pass/failure captures and clean device teardown.
- The suite uses serialized `android-avd` and `synapse` resources, is registered
  in Nx/the E2E registry/CI, and uploads diagnostics only when it started.
- Acceptance requires effective negative controls, three unchanged installed-
  Android first-attempt passes, all six exact Playwright predecessors at retry
  zero, full repository validation, review and original-attempt hosted
  Android/browser/renderer evidence.
- PR #677 must remain unmerged.
