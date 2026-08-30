// @ts-check
import { join } from 'node:path';
import { defineConfig, globalIgnores } from 'eslint/config';
import angular from 'angular-eslint';
import nx from '@nx/eslint-plugin';
import tailwind from 'eslint-plugin-tailwindcss';
import tseslint from 'typescript-eslint';

// The tailwind plugin resolves a relative `cssConfigPath` against each linted
// file's directory, which breaks in a monorepo — so pass an absolute path
// anchored at this config's location (the repo root).
const tailwindCssConfigPath = join(
  import.meta.dirname,
  'apps/trinity/src/theme/spartan.css',
);

/** Shared by the two rules below, which police the same ban over different AST shapes. */
const KIT_IMPORT_MESSAGE =
  'Feature, ui and app code reaches for @trinity/components/* (the public tier), not the vendored kit. The tier owns the vendor API so a swap touches one library instead of every call site — see docs/architecture/ui-and-theming.md. If the component you need has no wrapper yet, add one there rather than importing @trinity/helm/* here.';

const SDK_IMPORT_MESSAGE =
  'Only libs/data-access/* (and libs/util/matrix, which models the SDK types) may import matrix-js-sdk. Re-export what you need from the data-access lib that owns the domain.';

export default defineConfig([
  globalIgnores([
    '**/dist',
    '**/www',
    // electron-builder's output (electron/release): packaged app trees carry
    // Chromium's licence HTML, which ESLint otherwise tries to parse.
    '**/release',
    '**/coverage',
    '**/node_modules',
    '**/.angular',
    'android',
    'ios',
    // `e2e` used to be listed here. It is not any more: the Playwright suite is the only
    // gate for whole user journeys, and the failure mode it is most exposed to — a
    // dropped `await` on a locator assertion, which passes vacuously forever — is exactly
    // what a lint rule catches and review does not. See the scoped block at the bottom.
    '.pnpm-store/',
    '**/.pnpm-store/',
  ]),
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            // Third-party UI stops at the UI tier.
            //
            // The trailing `*` on each glob is load-bearing, and its absence is silent:
            // `bannedExternalImports` is matched as a glob against the whole specifier, so
            // a bare '@angular/cdk' matches only that exact string — which nothing imports,
            // because every real import is a deep '@angular/cdk/dialog'. The rule then
            // reports success and the ban enforces nothing. `lint-invariants.spec.mjs`
            // pins the `*` for exactly this reason.
            //
            // There is no `ui:wrapper` entry here any more, and its absence is a decision
            // rather than an oversight. That tag belonged to `libs/ui`, which held the
            // presentational components and then, briefly, nothing but a DI seam; domain-neutral
            // components went to the grouped public tier and application-surface loading moved
            // to Application Runtime, so the library — and the only project
            // carrying the tag — is gone. A `bannedExternalImports` entry keyed on a tag no
            // project has enforces exactly nothing while reading as a closed door, which is
            // the shape this whole boundary exists to eliminate. `lint-invariants.spec.mjs`
            // fails on a tier named in its table that no project carries, so this cannot
            // quietly come back.
            //
            // What remains of the `ui:*` axis is two tiers, BOTH deliberately absent from
            // this list: `ui:public` (libs/components/*) and `ui:vendor-wrapper` (the
            // generated kit). Both ARE wrapper layers — naming a vendor is their job — and
            // banning it there would ban them from existing. So every `type:ui` project may
            // now name a vendor, and what contains the public tier is the other direction: a
            // consumer-side ban keeps libs/feature and apps from reaching past it into
            // `@trinity/helm/*`. The axis still earns its keep by telling those two tiers
            // apart for that bookkeeping.
            //
            // `type:feature` carries all four. #151 closed @angular/cdk and
            // @spartan-ng/brain, #154 @ng-icons, #152 @ctrl/ngx-emoji-mart — and with the
            // last one nothing is staged any more, so the temporary `warn` block that used
            // to sit further down is gone.
            {
              // Closed by #151 (@angular/cdk, @spartan-ng/brain), #154 (@ng-icons) and
              // #152 (@ctrl/ngx-emoji-mart), so all four are enforced rather than staged:
              // a new one fails `pnpm lint`, statically or through a lazy `import()`.
              sourceTag: 'type:feature',
              bannedExternalImports: [
                '@spartan-ng/brain*',
                '@angular/cdk*',
                '@ng-icons*',
                '@ctrl/ngx-emoji-mart*',
              ],
            },
            {
              sourceTag: 'type:data-access',
              bannedExternalImports: [
                '@spartan-ng/brain*',
                '@angular/cdk*',
                '@ng-icons*',
                '@ctrl/ngx-emoji-mart*',
              ],
            },
            {
              sourceTag: 'type:util',
              bannedExternalImports: [
                '@spartan-ng/brain*',
                '@angular/cdk*',
                '@ng-icons*',
                '@ctrl/ngx-emoji-mart*',
              ],
            },
            {
              sourceTag: 'type:platform',
              bannedExternalImports: [
                '@spartan-ng/brain*',
                '@angular/cdk*',
                '@ng-icons*',
                '@ctrl/ngx-emoji-mart*',
              ],
            },
            {
              sourceTag: 'type:app',
              bannedExternalImports: [
                '@spartan-ng/brain*',
                '@angular/cdk*',
                '@ng-icons*',
                '@ctrl/ngx-emoji-mart*',
              ],
            },
            {
              sourceTag: 'scope:matrix',
              onlyDependOnLibsWithTags: ['scope:matrix', 'scope:shared'],
            },
            {
              // The shared kernel (util/platform/matrix-client/ui/helm) must stay
              // domain-agnostic — it may not reach into the matrix domain libs.
              sourceTag: 'scope:shared',
              onlyDependOnLibsWithTags: ['scope:shared'],
            },
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: [
                'type:feature',
                'type:ui',
                'type:data-access',
                'type:util',
                'type:platform',
              ],
            },
            {
              sourceTag: 'type:feature',
              onlyDependOnLibsWithTags: [
                'type:ui',
                'type:data-access',
                'type:util',
                'type:platform',
              ],
            },
            {
              // State/services/API wrappers — may use other data-access + util/platform.
              sourceTag: 'type:data-access',
              onlyDependOnLibsWithTags: [
                'type:data-access',
                'type:util',
                'type:platform',
              ],
            },
            {
              // Presentational-only: no state/services, so no core dependency.
              sourceTag: 'type:ui',
              onlyDependOnLibsWithTags: [
                'type:ui',
                'type:util',
                'type:platform',
              ],
            },
            {
              // Native capabilities behind Capacitor/browser APIs — only util below.
              sourceTag: 'type:platform',
              onlyDependOnLibsWithTags: ['type:platform', 'type:util'],
            },
            {
              // Pure functions/models — no Angular DI, depends only on other utils.
              sourceTag: 'type:util',
              onlyDependOnLibsWithTags: ['type:util'],
            },
          ],
        },
      ],
    },
  },
  {
    // "Components never import matrix-js-sdk directly" is the core architectural rule
    // (AGENTS.md), and until this block existed nothing enforced it:
    // `@nx/enforce-module-boundaries` only polices `@trinity/*` edges between projects
    // and has nothing to say about a third-party package, so the rule survived on review
    // discipline alone — and three spec files had already drifted past it.
    //
    // The allowed importers are deliberately absent from `files` below rather than
    // carved out here: `libs/data-access/**` owns all SDK access, and `libs/util/matrix`
    // is the sanctioned exception because it models the SDK's own types
    // (docs/architecture/index.md). If a layer below genuinely needs an SDK symbol, the
    // fix is to re-export it from the lib that owns the domain — as
    // data-access/discovery does for JoinRule and util/matrix does for HTTPError — not to
    // widen this rule.
    // libs/spartan is included even though it is generated: it is presentational UI that
    // must never reach the SDK, and leaving it out made this rule the one thing the two UI
    // configs disagreed on — which scripts/lint-invariants.spec.mjs correctly failed on,
    // since a widening gap between them is exactly what that invariant exists to catch.
    // Split from the consumer tiers (libs/feature, apps), which carry this same
    // rule PLUS the kit ban in the block below. Flat config replaces a rule's options
    // wholesale, so two blocks configuring `@typescript-eslint/no-restricted-imports` over
    // overlapping globs would silently drop whichever set lost — the globs are disjoint on
    // purpose, and `lint-invariants.spec.mjs` asserts the SDK ban still reaches both halves.
    files: [
      'libs/spartan/**/*.ts',
      // The public component tier, for the same reason libs/spartan is here: it is
      // presentational UI that must never reach the SDK. Absence from this list is how a
      // library is PERMITTED to import matrix-js-sdk (that is how data-access and
      // util/matrix are allowed), so a new UI lib that is merely forgotten lands in the
      // allowed bucket — silently, and with nothing else to catch it. That is no longer
      // "nothing": `lint-invariants.spec.mjs` now sweeps every library and fails on any one
      // not named here and not sanctioned, which is what caught `libs/util/ui` on the day it
      // was created.
      'libs/components/**/*.ts',
      'libs/platform-native/**/*.ts',
      // Projection Runtime is a shared orchestration kernel. It may project SDK-backed
      // state supplied by data-access adapters, but it must remain SDK-independent.
      'libs/runtime/**/*.ts',
      // Application capabilities coordinate domain-owned abstractions and must not gain
      // direct SDK knowledge at their composition boundary.
      'libs/application/**/*.ts',
      'libs/testing/**/*.ts',
      // `libs/util/ui` and not `libs/util/**`: the sibling `libs/util/matrix` is the
      // sanctioned exception that models the SDK's own types, so a directory-wide glob here
      // would ban the one library that has to import it.
      'libs/util/ui/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['matrix-js-sdk', 'matrix-js-sdk/*'],
              message: SDK_IMPORT_MESSAGE,
            },
          ],
        },
      ],
      // no-restricted-imports only sees STATIC import declarations, so
      // `() => import('matrix-js-sdk/lib/crypto-api')` slips straight through it — and a
      // lazily-loaded feature component is exactly the shape that would reach for one,
      // since every route in this app is lazy. Same rule, expressed over the AST node
      // that form actually produces.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/^matrix-js-sdk/]',
          message: SDK_IMPORT_MESSAGE,
        },
      ],
    },
  },
  {
    // The consumer side of the public component tier — the half that makes it a boundary
    // rather than a suggestion.
    //
    // `@nx/enforce-module-boundaries` cannot express this. Its `notDependOnLibsWithTags` is
    // TRANSITIVE: the tier depends on the kit by design, so banning `ui:vendor-wrapper` from
    // feature code also bans it through `@trinity/components/*` and fails on the very path it
    // is meant to bless. Measured, not assumed — the first attempt reported
    // `components-overlay -> button` against the then-existing libs/ui. A direct-import rule
    // is the right shape,
    // and it is the one this repo already uses for the matrix-js-sdk ban above.
    //
    // These globs are disjoint from that block's on purpose: flat config replaces a rule's
    // options wholesale, so overlapping them would silently drop one set of patterns. That is
    // why the SDK pattern is restated here rather than inherited.
    files: ['libs/feature/**/*.ts', 'apps/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['matrix-js-sdk', 'matrix-js-sdk/*'],
              message: SDK_IMPORT_MESSAGE,
            },
            {
              // Fully closed: button, dropdown-menu and toaster now have Trinity-owned
              // public APIs alongside the rest of the component tier. No feature/app
              // exception remains, so a reach into any Helm package fails immediately.
              group: ['@trinity/helm/*'],
              message: KIT_IMPORT_MESSAGE,
            },
          ],
        },
      ],
      // Restated here for the same reason the SDK pattern above is: splitting the globs
      // means this block owns these tiers outright. Dropping it was not hypothetical — the
      // first version of this split did exactly that, and `lint-invariants.spec.mjs` failed
      // on the missing selector, which is the whole reason that assertion exists. Every
      // route in this app is lazy, so this form is the half that matters here.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/^matrix-js-sdk/]',
          message: SDK_IMPORT_MESSAGE,
        },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    // `angular.configs.tsRecommended` enables the @angular-eslint rules but NO
    // @typescript-eslint ones, so until this was added the workspace enforced none of
    // them — no-unused-vars, no-explicit-any and friends were all off, despite
    // .claude/CLAUDE.md mandating "drop unused variables" and "avoid the `any` type".
    // This is the UNTYPED preset, so it costs no type-checking time (unlike the
    // type-aware no-deprecated block further down).
    extends: [
      ...tseslint.configs.recommended,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      // The style guide bans console.log; permit only the console methods the codebase
      // legitimately uses (error/warn/debug) so genuine logging still passes.
      'no-console': ['error', { allow: ['warn', 'error', 'debug'] }],
      // A leading underscore is the conventional "deliberately unused" marker — it is
      // how a mock or an interface implementation says "this arg exists for the
      // signature, not for me". Everything without one is still an error.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@angular-eslint/component-class-suffix': [
        'error',
        { suffixes: ['Page', 'Component'] },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'trn', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'trn', style: 'camelCase' },
      ],
    },
  },
  {
    // Ban deprecated APIs (project rule: replace them with the recommended
    // alternative). This is the workspace's only TYPE-AWARE rule — seeing a symbol's
    // `@deprecated` tag needs the type checker, hence `projectService`.
    //
    // Scope is limited to what each project's own tsconfig.json owns:
    //   - `*.spec.ts` is *excluded* from every tsconfig.json (specs live in
    //     tsconfig.spec.json), so the project service finds no program for them.
    //     Pointing `project` at every tsconfig instead makes each of the ~40 lint runs
    //     load every program and OOMs the 2GB heap, so specs stay uncovered here.
    //   - Standalone tooling files (vite/vitest config, test setup) are in no project.
    // Both would otherwise fail as "not found by the project service".
    files: ['{apps,libs,electron}/**/*.ts'],
    ignores: [
      '**/*.spec.ts',
      '**/vite.config.ts',
      '**/vitest.config.ts',
      '**/test-setup.ts',
      '**/*.config.ts',
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-deprecated': 'error',
    },
  },
  {
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended],
    rules: {},
  },
  {
    // Tailwind CSS linting for utility classes in templates (class="…") and in
    // class-string helpers in TS (hlm()/cva()/classes()). Class ORDER is owned by
    // prettier-plugin-tailwindcss, so `classnames-order` is off here; and this app
    // deliberately mixes BEM/component classes with utilities, so
    // `no-custom-classname` is off. The rest run as warnings so they surface in
    // review without hard-failing `nx lint`.
    files: ['**/*.ts', '**/*.html'],
    plugins: { tailwindcss: tailwind },
    settings: {
      tailwindcss: {
        // Tailwind v4 is CSS-configured; point the plugin at the stylesheet that
        // imports tailwind + the theme tokens (bg-foreground, text-background, …).
        cssConfigPath: tailwindCssConfigPath,
        // Class-string helpers used in this repo, in addition to the defaults.
        functions: [
          'classnames',
          'classNames',
          'clsx',
          'cn',
          'ctl',
          'cva',
          'tv',
          'tw',
          'twMerge',
          'twJoin',
          'hlm',
          'classes',
        ],
      },
    },
    rules: {
      'tailwindcss/classnames-order': 'off',
      'tailwindcss/no-custom-classname': 'off',
      'tailwindcss/no-contradicting-classname': 'warn',
      'tailwindcss/enforces-shorthand': 'warn',
      'tailwindcss/enforces-negative-arbitrary-values': 'warn',
      'tailwindcss/no-unnecessary-arbitrary-value': 'warn',
    },
  },
  {
    // The hand-rolled Electron package is a standalone Node/Electron app with its own
    // dependency installation, but `electron/project.json` now makes it an explicit
    // classified Nx application. The normal module-boundary rule therefore remains active.
    files: ['electron/**/*.ts', 'electron/**/*.mts'],
    rules: {
      // The Electron main process is a Node process; console is its legitimate
      // logging channel (no browser devtools), so the app's no-console ban doesn't apply.
      'no-console': 'off',
    },
  },
  {
    // `hlm-*.ts` is canonical spartan-ng "helm" code generated by @spartan-ng/cli (we own
    // it, but don't author it). It intentionally breaks our app conventions: `hlm`/`brn`
    // selector prefixes, un-suffixed class names (HlmButton), and aliased inputs (incl.
    // `class`). Exempt it from those rules rather than fighting the generator on every
    // re-sync.
    //
    // Scoped to the generated FILES, not to `libs/spartan/**`. Three libraries in that
    // directory — overlay, icon and emoji-picker — are hand-authored Trinity code, and a
    // directory-wide glob silently exempted them too: `<trn-icon>` could have been renamed
    // to `<icon>`, or `TrnEmojiPickerComponent` to `TrnEmojiPicker`, and `pnpm lint` would
    // have agreed. That is the public wrapper tier this whole boundary exists to build, so
    // it is exactly the code the naming rules should hold. `hlm-*` is the same
    // generated-vs-authored split `.prettierignore` already draws, and the only non-`hlm-*`
    // files in the sixteen generated libraries are barrels plus `utils/src/lib/{hlm,
    // provide-spartan-hlm}.ts`, none of which declares a component or directive.
    files: ['libs/spartan/**/hlm-*.ts'],
    rules: {
      '@angular-eslint/component-class-suffix': 'off',
      '@angular-eslint/component-selector': 'off',
      '@angular-eslint/directive-selector': 'off',
      '@angular-eslint/no-input-rename': 'off',
    },
  },
  {
    // The Playwright suite. Type-aware, against e2e/tsconfig.json — which is what makes
    // `no-floating-promises` possible, and it is the rule this block exists for: an
    // `expect(locator).toBeVisible()` missing its `await` resolves to a promise nobody
    // waits on, so the assertion never runs and the spec passes whatever the app did.
    // Ninety-seven specs had nothing but review discipline standing between them and that.
    //
    // `.mts` only: the harness under e2e/synapse and e2e/features is plain `.mjs` (it is
    // run by bare `node` for the manual bring-up), carries no types, and would only
    // produce "not found by the project service" here.
    files: ['e2e/**/*.mts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./e2e/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // The other half of the pair: a committed `test.only` silently reduces the suite to
      // one spec while still reporting green. Expressed as a syntax ban rather than
      // `playwright/no-focused-test` deliberately — that rule lives in
      // eslint-plugin-playwright, which this workspace does not depend on, and one
      // selector is a smaller thing to own than a plugin for a single rule.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='only']",
          message:
            'Focused test: `.only` runs this spec and silently skips the other ~96, which still reports as a passing E2E job. Remove it before committing.',
        },
      ],
      // The Playwright harness is a Node process driving a browser; console is how a
      // failing run explains itself in CI logs.
      'no-console': 'off',
    },
  },
  {
    // Build/test tooling files legitimately import a shared root helper
    // (vite.base.config / test-setup.base) via a relative path — vite's config
    // loader and the vitest setupFiles can't resolve `@trinity/*` aliases.
    // @nx/enforce-module-boundaries polices the app/lib runtime graph, not tooling,
    // so it doesn't apply here.
    files: [
      '**/vite.config.ts',
      'vite.base.config.ts',
      '**/vitest.config.{ts,mts,mjs}',
      '**/test-setup.ts',
      'test-setup.base.ts',
    ],
    rules: {
      '@nx/enforce-module-boundaries': 'off',
    },
  },
]);
