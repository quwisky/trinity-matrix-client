# Ionic → spartan.ng migration

`@trinity/ui-spartan` holds our owned, in-repo **spartan.ng "helm"** components
(built on `@spartan-ng/brain` primitives + Angular CDK, styled with Tailwind
tokens). Ionic and spartan **coexist** while we migrate lib-by-lib so the app
builds and ships the entire time; `@ionic/angular` is removed last.

## Ground rules / setup (done)

- **Versions.** The app was upgraded to **Angular 21** (+ CDK 21) so it can run
  stable **`@spartan-ng/brain@1.0.3`** (Angular ≥21 <23). Nx 23 caps Angular at
  21, so 21 is the ceiling until Nx bumps. Ionic 8 (peer `>=16`) runs on 21.
- **Tailwind v4** (CSS-first). `apps/trinity/src/theme/spartan.css` imports only
  the `theme` + `utilities` layers — **preflight stays out** so it never fights
  Ionic's reset — so helm components that draw a border carry `border-solid`.
  `@theme inline` maps tokens to color utilities by reference.
- **Dark mode** via `@custom-variant dark` keyed to `.ion-palette-dark` (the
  class `ThemeService` toggles on `<html>`), so spartan tokens flip with the rest
  of the app — no new wiring. `--primary` is Trinity blurple so helm buttons
  match the existing brand accent.
- **`hlm(...)`** (`clsx` + `tailwind-merge`) is the class-merge helper every helm
  primitive routes its host `class` through, so callers override without
  `!important`.

## Component map

| Ionic                                                                                                                                                                     | spartan / helm target                                                                                                  | Status    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------- |
| `ion-button`                                                                                                                                                              | `button[trnBtn]` (variant/size)                                                                                        | ✅ done   |
| `ion-input`, `ion-textarea`                                                                                                                                               | `input[trnInput]`, `textarea[trnInput]`                                                                                | ✅ done   |
| `ion-label`                                                                                                                                                               | `label[trnLabel]` (forms) / text utils                                                                                 | ✅ done   |
| `ion-checkbox`                                                                                                                                                            | `brain/checkbox` + `hlm-checkbox`                                                                                      | ▢ Phase 1 |
| `ion-radio`, `ion-radio-group`                                                                                                                                            | `trn-radio` + `trn-radio-group` (native, a11y)                                                                         | ✅ done   |
| `ion-badge`                                                                                                                                                               | `hlm-badge` (cva variants)                                                                                             | ▢ Phase 1 |
| `ion-spinner`                                                                                                                                                             | `trn-spinner` (SVG)                                                                                                    | ✅ done   |
| `ion-progress-bar`                                                                                                                                                        | `brain/progress` + `hlm-progress`                                                                                      | ▢ Phase 1 |
| `ion-note`, `ion-text`                                                                                                                                                    | native element + `text-muted-foreground` etc.                                                                          | ▢ Phase 1 |
| `ion-list`, `ion-list-header`, `ion-item`                                                                                                                                 | native markup + Tailwind (helm list styles)                                                                            | ▢ Phase 3 |
| `ion-icon`                                                                                                                                                                | `@ng-icons` + lucide (spartan convention)                                                                              | ▢ Phase 5 |
| `ion-app`, `ion-router-outlet`, `ion-split-pane`, `ion-menu`, `ion-menu-button`, `ion-header`, `ion-toolbar`, `ion-title`, `ion-content`, `ion-footer`, `ion-back-button` | custom CDK/Tailwind **app shell** (Angular `RouterOutlet`, CDK sidenav, flex layout, safe-area + back-button handling) | ▢ Phase 4 |

## Overlays — the big lift (118 call sites)

Ionic's imperative controllers get a thin **adapter service** each, so call sites
migrate mechanically and behavior (returns, `onWillDismiss`) is preserved:

| Ionic controller        | Sites | Target                                    | Adapter                                     |
| ----------------------- | ----- | ----------------------------------------- | ------------------------------------------- |
| `ModalController`       | 70    | `brain/dialog` (CDK) + `hlm-dialog`       | `DialogService.open(cmp, { inputs }) → ref` |
| `AlertController`       | 23    | `brain/alert-dialog` + `hlm-alert-dialog` | `AlertService.confirm()/prompt()`           |
| `ToastController`       | 15    | CDK-overlay toast + `hlm-sonner`          | `ToastService.show()`                       |
| `ActionSheetController` | 10    | `brain/menu` or CDK bottom-sheet          | `ActionSheetService.open()`                 |

## Phased plan

0. **Foundation** — lib, deps, Tailwind, `hlm`, button/input/label. ✅ (this change)
1. **Leaf form/display primitives** — checkbox, radio, badge, spinner, progress,
   note/text. Migrate `feature-auth` + `feature-settings` forms first (smallest).
2. **Overlays** — build the four adapter services + helm dialog/alert-dialog/toast;
   migrate the 118 sites lib-by-lib behind them.
3. **Lists / items** — message rows, member lists, settings lists.
4. **App shell** — replace `ion-app`/router-outlet/split-pane/menu/header/toolbar/
   content/footer with a custom CDK+Tailwind shell; handle safe-area insets, the
   Android back button, and page transitions (Ionic gave these for free).
5. **Icons + teardown** — `ion-icon` → lucide; switch `darkMode` to `.dark` and
   update `ThemeService`; remove `@ionic/angular`, `@ionic/angular-toolkit`, the
   Ionic CSS imports, and the Ionic tokens in `variables.scss`.
6. **Cleanup** — update unit/e2e selectors, delete dead theme, final audit.

## Adding a helm component

1. `libs/ui-spartan/src/lib/<name>/hlm-<name>.(directive|component).ts` — wrap the
   `@spartan-ng/brain/<name>` primitive; route host `class` through `hlm(...)`.
2. Export it from `src/index.ts`.
3. Add a `*.spec.ts` asserting the applied classes + brain behavior (Vitest).
4. Consume via `@trinity/ui-spartan`; delete the Ionic usage in the same PR.
