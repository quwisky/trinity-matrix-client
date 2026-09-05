# Conventions specific to this repo

- **Component structure**: each component/page in its own directory as `name/name.component.ts` +
  `.html` + `.scss` + `.spec.ts` (logic in `.ts`, styles in `.scss`, template in `.html`).
- **Selectors**: `trn` prefix — elements kebab-case (`trn-avatar`), directives camelCase. Class
  suffix must be `Page` or `Component`.
- **`libs/spartan/*` is generated and owned via `@spartan-ng/cli`** (config in root
  `components.json`). Add/regenerate Helm components with the CLI rather than hand-authoring;
  it's intentionally exempt from the `trn`-prefix and class-suffix ESLint rules. Where upstream
  is wrong we _do_ diverge — but on the record: comment it at the site, add it to the banner at
  the top of the file, pin it with a test, and list it under **Vendored spartan overrides** in
  [docs/architecture/ui-and-theming.md](../architecture/ui-and-theming.md).
- **Commits use the Conventional Commits convention** (commitlint `commit-msg` hook via
  `@commitlint/config-conventional`): `type(scope): subject` where `type` ∈
  `feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`. A `pre-commit` hook
  runs lint-staged (eslint --fix + prettier); a module-boundary violation fails the commit.
- **Cross-lib imports use `@trinity/*` aliases**; imports within a lib stay relative.
- **Keep `data-testid` hooks** on interactive elements — the headless Playwright harnesses drive them.
- Shared SCSS mixins live in `libs/feature/rooms/src/lib/styles/_mixins.scss`.
- **Component SCSS references design tokens** (`--trinity-*`; alert **text/icons** =
  `--trinity-danger`, a filled danger badge = `--trinity-danger-solid` +
  `--trinity-danger-solid-foreground`, on-accent text = `--trinity-accent-foreground`, which
  tracks the Helm `--primary-foreground` so a Theme overrides one value). Never hardcode
  colours, or they won't re-theme with Mode or Theme; and never
  use Helm's `--destructive` as a foreground — it's a fill/tint-only token whose dark value
  is a near-black maroon (in a template the alert-text utility is `text-danger`, **not**
  `text-destructive`). Rendered `[innerHTML]` markdown is styled globally in
  `apps/trinity/src/rendered-markdown.scss` (not `::ng-deep`). See [docs/architecture/ui-and-theming.md](../architecture/ui-and-theming.md).
- **Cascade roles are fixed:** `theme, base, vendor, components, utilities, overrides`. Global
  authored rules and Angular component style tags use those roles. `scripts/styling-idiom.spec.mjs`
  inventories component sources, and `scripts/cascade-layer-contract.spec.mjs` rejects any
  unlayered ruleset. When a utility "does nothing", check the compiled cascade. A `.safe-*` helper
  and a padding utility still claim the same longhand, so compose the inset and padding in one
  declaration (see `.panel-header`) rather than stacking them. See
  [docs/architecture/ui-and-theming.md](../architecture/ui-and-theming.md).
- **Platform vs capability are different questions, and both predicates exist.** `isMobileOs()`
  (`@trinity/platform-native`) asks the OS and picks the INTERACTION MODEL — a bottom sheet is an
  iOS/Android convention, and a touchscreen Windows laptop should not be handed one. A
  `(pointer: coarse)` media query asks whether a finger is driving, which is what decides how big
  a target must be. Use the one that matches the question; they are not interchangeable and are
  not in conflict.
- **Desktop detection**: Capacitor's `isNativePlatform()` is `false` in the Electron shell — branch on
  the `trinityDesktop` preload marker to treat desktop like web (service worker off, push off).
