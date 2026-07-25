# Zoneless Change Detection — Migration Plan

Status: **complete** — production and the Vitest harness both run zoneless, and `zone.js` is
dropped (branch `spike/zoneless`). See the phase table for how the ATL blocker was resolved.

This plans Trinity's move from zone.js (`provideZoneChangeDetection()`) to Angular's
zoneless change detection (`provideZonelessChangeDetection()`, stable in Angular 22).

## Verdict: a "delete code" migration, not a rewrite

The app already satisfies the hard preconditions. A six-dimension codebase audit found:

- **100% OnPush**, and **zero** `ChangeDetectorRef` / `markForCheck` / `detectChanges` /
  `ApplicationRef.tick` in production code — today CD is driven by exactly two things:
  **signals** and **zone.js**.
- **Zero** `async` pipes, **zero** `Subject`/`BehaviorSubject`-backed view state. Every one of
  the ~87 `.subscribe()` sites that touches template state writes through a **signal** (or
  `runWithBusy`, which only writes signals). The classic zoneless-breaking path
  (async callback → plain field → template) **does not exist** here.
- **Zero** `fakeAsync` (the usual #1 zoneless test blocker is absent; the `tick(`/`flush(`
  matches are all `ApplicationRef.tick()` or local Promise helpers).
- `@angular/animations` is a declared but **completely unused** dependency (all motion is
  CSS/Tailwind) — droppable, and no synchronous `provideAnimations()` to fix.
- Third-party libs are ready (CDK 22 self-schedules; spartan/brain 1.1, ng-icons, ngx-sonner
  are signal/imperative). The one library to runtime-verify is **emoji-mart** (legacy, self-
  manages OnPush CD). Caveat found later by e2e: one CDK **submenu** interaction was not
  zoneless-clean — see "Post-migration hardening" below.

**Central insight:** every `NgZone.run()` in this app wraps a **signal write** and exists only
to force prompt CD after a `matrix-js-sdk` callback fires outside the zone. One comment says so:
_"re-enter... so the signal writes below flush... promptly rather than on the next incidental
change detection."_ Under zoneless, a signal write **always** schedules CD by itself — so those
wrappers become no-ops, and removing them makes CD _more_ correct, not less.

## Phase 0 spike — empirical results (branch `spike/zoneless`)

Flipped `main.ts` to `provideZonelessChangeDetection()` and removed zone.js from `polyfills.ts`
(deleting `zone-flags.ts`), **without touching any NgZone code** (the wrappers became
`NoopNgZone` pass-throughs):

- ✅ **Production build passes** under zoneless (`nx build trinity`, exit 0).
- ✅ **zone.js runtime fully removed** from the bundle — `__zone_symbol__` count is **0**; the
  `polyfills` chunk is now **0 bytes**.
- ✅ **Bonus:** the pre-existing initial-bundle budget overage (was +29 kB over 2.0 MB) **cleared**
  — zone.js was ~30 kB of it.
- ✅ Dev server (`nx serve`) builds and serves the zoneless bundle.
- ⚠️ **Test-harness migration is NOT mechanical.** Flipping one lib (`ui`, 5 ATL specs) to the
  `@testing-library/angular/zoneless` entry produced **16 failures** — `NG0950: Input is required
but no value is available yet` and stale reads. Root cause: the ATL **v19.4.1** `/zoneless`
  `render()` runs the component's initial CD before its programmatic `inputs` are bound. This is a
  **test-harness timing issue, not a production concern** (real templates bind required inputs
  before CD regardless of zone), but it means Phase 2 needs an ATL upgrade or a shared zoneless
  render wrapper — not a mechanical import swap. Browser runtime smoke was blocked by the CI
  environment (Linux Arm64, no Chrome channel) and is deferred to manual/device testing.

## Migration surface

### 1. Bootstrap

- `apps/trinity/src/main.ts`: `provideZoneChangeDetection()` → `provideZonelessChangeDetection()`.
- `apps/trinity/src/polyfills.ts`: drop `import 'zone.js'` + `import './zone-flags'`; delete
  `zone-flags.ts` (a stale Ionic-era file).
- Drop the `zone.js` dependency and the unused `@angular/animations` dependency.

### 2. NgZone removal — 18 call sites across 12 files (mostly mechanical)

`this.zone.run(() => sig.set(x))` → `sig.set(x)`, then remove `inject(NgZone)` + the import and
fix the now-inaccurate "re-enter the zone" comments.

- **Low-risk (pure signal writes / pure DOM):** `matrix-client.service` (×2), `presence.service`,
  `navigation-focus.service` (pure-DOM rAF — drop `runOutsideAngular`), `pinned-messages.service`
  (×4), `rooms.service` (×3), `spaces.service`, `unread-aggregator.service`, `timeline.service`,
  `invites.service`.
- **Verify-then-drop (still signal writes / router nav):** `notification.service`
  (`openFromNotification`), `push.service` (`openFromPush`), and
  `virtual-message-list.component` (`ResizeObserver` `runOutsideAngular`+`run` scroll anchoring).

### 3. Test harness (the real work — see Phase 0)

- ~21 `test-setup.ts` files: `@analogjs/vitest-angular/setup-zone` →
  `setupTestBed({ zoneless: true })` (from `@analogjs/vitest-angular/setup-testbed`).
- 58 spec files: `@testing-library/angular` → `@testing-library/angular/zoneless` — **plus** the
  per-spec CD/input-binding fixes the spike surfaced (evaluate bumping `@testing-library/angular`
  past 19.4.1, or wrap `render()` in a shared helper that awaits stability after binding inputs).
- Retire the one zone-semantic test (`rooms.service.spec.ts` "runs refreshes inside the Angular zone").

## Phased execution

| Phase                                                          | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Acceptance                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **0 — De-risk spike** (done)                                   | Flip provider + drop zone.js, no NgZone edits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Build green, zone.js gone ✅                                      |
| **1 — Production switch + NgZone cleanup** ✅ done (`86693c6`) | Provider flipped in phase 0. Removed 20 NgZone wrappers/injects across 12 files · fixed the stale comments · retired the 1 zone-semantic test. `@angular/animations` was already dropped (config audit). `zone.js` is kept — the Vitest harness is still zoned (prod zoneless / tests zoned, a valid interim).                                                                                                                                                                                                                                                                                                                                                                                                                        | `nx build` (whole graph) · `lint` (39) · `test` (23) all green ✅ |
| **2 — Test harness zoneless** ✅ done                          | Flipped the single shared `test-setup.base.ts` to `setupTestBed({ zoneless: true })`. ATL blocker resolved: ATL 19.4.1 `/zoneless` render ignores the `inputs`/`on` options (it binds only via the native `bindings` API), leaving required signal inputs unset → NG0950. A small `@trinity/testing` render wrapper (`test-render.ts`) applies `inputs` via `componentRef.setInput` before the first change detection, which also sidesteps the NG0317 that static `inputBinding` would trigger when a spec later updates an input. Swapped all 59 specs to import `render` from `@trinity/testing`; converted the one virtual-message-list sync-rAF anchor test to a detached fixture; dropped `zone.js` (an optional Angular peer). | `nx build/lint/test` green under zoneless ✅                      |

## Post-migration hardening — an e2e-caught CDK submenu regression (fixed)

Running the Playwright suite against the zoneless build surfaced one real regression the
jsdom unit tests could not (no live overlay): the channel-list room ⋮ menu's **Notifications
submenu** (All / Mentions / Mute) would not open when its trigger was clicked.

Root cause: a CDK submenu trigger opens its submenu on **hover**, and CDK's own click handler
then `toggle()`s it. Under zone.js the overlay attach was deferred enough that a mouse click
usually still landed while the submenu read as closed and so opened it; under
`provideZonelessChangeDetection()` the attach is **synchronous**, so `isOpen()` is already
`true` at click time and the click deterministically closes it again. (Touch/tap and hover
both still worked — only mouse-click-on-trigger broke, because hover-open only fires for the
mouse modality.)

Fix — `libs/spartan/dropdown-menu`, `HlmDropdownMenuSubTrigger`: shadow CDK's instance
`_handleClick` so a sub-trigger click `open()`s (idempotent — `open()` is guarded on
`!isOpen()`) instead of toggling, matching radix/shadcn submenu semantics. The compiled host
listener resolves `_handleClick` on the instance at event time, so shadowing it supersedes
CDK's `toggle()` without depending on listener ordering. Guarded by two tests:
`e2e/playwright/room-notifications.spec.mts` (live overlay) and a Docker-free unit regression,
`libs/spartan/overlay/src/lib/dropdown-menu-submenu.spec.ts` (a second sub-trigger click must
keep the submenu open). **NB:** `hlm-dropdown-menu.ts` is `@spartan-ng/cli`-generated — if it
is ever regenerated, re-apply this override (the unit regression will flag its loss). It is
one of several; the full list is **Vendored spartan overrides** in
[docs/DEVELOPMENT.md](DEVELOPMENT.md#vendored-spartan-overrides).

## Risk register — needs runtime/device verification (no signal write; Router/CDK self-schedules)

| Path                                                     | Check                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| Android hardware back button (Capacitor App)             | dismisses CDK dialog / navigates back, on device                  |
| OIDC / SSO deep-link navigation (native + desktop)       | returns into the app and routes                                   |
| Desktop notification-click account-switch (Electron IPC) | switches + navigates                                              |
| Push-notification tap (Capacitor)                        | `openFromPush` navigates                                          |
| `virtual-message-list` pin-to-bottom / scroll anchoring  | no one-frame jump (visual)                                        |
| **emoji-mart** picker (legacy self-managed CD)           | opens & selects — only genuine third-party risk                   |
| Unread badges / typing indicators                        | land within one frame (microtask coalescing vs zoneless batching) |

## Open decisions (recommendations)

- **Strip NgZone wrappers in the same PR as the flip?** Yes — corrects ~15 misleading comments.
- **Centralize the ~21 near-identical test-setups?** Yes — one shared module prevents drift and
  makes the Phase 2 ATL fix a single change.
- **ATL entry: swap 58 imports or alias?** Swap the imports — an alias hides the zoneless choice
  and lets the default entry leak back via new specs.

## Effort & rollback

- **Effort:** Phase 1 ≈ 1 day (mechanical + smoke). Phase 2 ≈ 1.5–2 days (raised from the spike:
  the ATL/zoneless input-timing fix is real work, not an import swap). Total ~**3 days**.
- **Rollback:** trivial and staged — revert the one-line provider swap to restore zoned CD; the
  NgZone-removal and test-harness changes are independent commits.
