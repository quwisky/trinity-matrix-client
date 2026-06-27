---
name: conventions-ui-layer
description: Established UI-layer conventions in Trinity — busy/error handling, signal/ngModel binding, subscription cleanup
metadata:
  type: project
---

Conventions observed across the Trinity UI layer (follow these when reviewing/suggesting):

- **`withBusy<T>()` helper:** Page components (LoginPage, EncryptionSetupPage, EncryptionUnlockPage) share a private `withBusy()` that sets `busy`/`error` signals, pipes `takeUntilDestroyed`, `catchError` → `EMPTY`, `finalize`. This is the standard one-shot async pattern. NOTE: feature-auth's LoginPage uses it; SsoCallbackPage does NOT (uses manual subscribe) — inconsistency worth noting.
- **One-way signal binding:** Inputs bind `[ngModel]="sig()"` + `(ngModelChange)="sig.set($event)"` rather than two-way `[(ngModel)]`. Intentional and consistent across forms.
- **Signals + computed for view state;** `output()`/`input()` functions (not decorators) for component IO. All components are OnPush + standalone with explicit `imports`.
- **Subscription cleanup:** `takeUntilDestroyed(this.destroyRef)` on every subscribe. Consistent.
- **Navigation:** post-auth/flow transitions use `router.navigateByUrl('/x', { replaceUrl: true })` so back button doesn't return to login/setup. The encryption-banner `act()` navigates WITHOUT replaceUrl (intentional — banner is mid-app).
- **Icons:** registered per-component via `addIcons({...})` in the constructor.
- **SCSS:** shared Discord-style mixins in `libs/feature-rooms/src/lib/styles/_mixins.scss`; color tokens are global CSS custom properties in `apps/trinity/src/theme/variables.scss` (e.g. `--trinity-text-muted`, `--trinity-rail`, `--trinity-hover`).
- **Tooling:** run checks via Nx, e.g. `pnpm nx lint <project>`, `pnpm nx test <project>`. Vitest for unit tests, Playwright for e2e.

**Why:** Keeps reviews aligned with team patterns rather than imposing generic preferences.
**How to apply:** Flag deviations from these (e.g. a component subscribing without takeUntilDestroyed, or using two-way ngModel) as inconsistency, and check feature-auth against the withBusy convention the other libs follow.
