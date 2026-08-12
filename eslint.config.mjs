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
const SDK_IMPORT_MESSAGE =
  'Only libs/data-access/* (and libs/util/matrix, which models the SDK types) may import matrix-js-sdk. Re-export what you need from the data-access lib that owns the domain.';

const UI_VENDOR_IMPORT_MESSAGE =
  'Only libs/spartan/* (the vendored kit) and libs/ui may import a third-party UI package. Use the kit component, or @trinity/helm/overlay for dialogs and toasts — see docs/architecture/ui-and-theming.md.';

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
            // `ui:wrapper` (libs/ui) keeps only @ctrl/ngx-emoji-mart, until #152 decides
            // where that wrapper lives. It used to keep @ng-icons too, on the assumption
            // the icon wrapper would land here; #154 put it in the kit instead (as
            // `@trinity/helm/icon`, which is where a lib that may name a vendor belongs),
            // so that exemption is gone. The vendored kit (`ui:vendor-wrapper`) is
            // deliberately absent from this list; it IS the wrapper layer, and banning its
            // vendors there would ban the layer from existing.
            //
            // `type:feature` carries three of the four vendors now; #151 and #154 closed
            // those. Only @ctrl/ngx-emoji-mart is still staged as a warning further down,
            // waiting on #152.
            {
              sourceTag: 'ui:wrapper',
              bannedExternalImports: ['@spartan-ng/brain*', '@ng-icons*'],
            },
            {
              // Closed by #151 (@angular/cdk, @spartan-ng/brain) and #154 (@ng-icons), so
              // these are enforced rather than staged. @ctrl/ngx-emoji-mart is absent on
              // purpose: it still has 7 importers, and #152 is gated on the composer
              // redesign, so its ban stays a warning further down until then.
              sourceTag: 'type:feature',
              bannedExternalImports: [
                '@spartan-ng/brain*',
                '@angular/cdk*',
                '@ng-icons*',
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
    // (CLAUDE.md), and until this block existed nothing enforced it:
    // `@nx/enforce-module-boundaries` only polices `@trinity/*` edges between projects
    // and has nothing to say about a third-party package, so the rule survived on review
    // discipline alone — and three spec files had already drifted past it.
    //
    // The allowed importers are deliberately absent from `files` below rather than
    // carved out here: `libs/data-access/**` owns all SDK access, and `libs/util/matrix`
    // is the sanctioned exception because it models the SDK's own types
    // (docs/architecture/index.md). If a layer below genuinely needs an SDK symbol, the
    // fix is to re-export it from the lib that owns the domain — as
    // data-access/rooms does for JoinRule and util/matrix does for HTTPError — not to
    // widen this rule.
    // libs/spartan is included even though it is generated: it is presentational UI that
    // must never reach the SDK, and leaving it out made this rule the one thing
    // libs/ui and libs/spartan disagreed on — which scripts/lint-invariants.spec.mjs
    // correctly failed on, since a widening gap between those two configs is exactly
    // what that invariant exists to catch.
    files: [
      'libs/feature/**/*.ts',
      'libs/ui/**/*.ts',
      'libs/spartan/**/*.ts',
      'libs/platform-native/**/*.ts',
      'libs/testing/**/*.ts',
      'apps/**/*.ts',
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
    // The hand-rolled Electron package is a standalone Node/Electron app (its own
    // tsc + vitest, run via `pnpm -C electron`), not part of the libs/apps Nx graph.
    // It legitimately imports the `electron` runtime, so the lib/app module-boundary
    // rule (which misreads that as a same-project import) doesn't apply.
    files: ['electron/**/*.ts', 'electron/**/*.mts'],
    rules: {
      '@nx/enforce-module-boundaries': 'off',
      // The Electron main process is a Node process; console is its legitimate
      // logging channel (no browser devtools), so the app's no-console ban doesn't apply.
      'no-console': 'off',
    },
  },
  {
    // libs/spartan/* is canonical spartan-ng "helm" code generated by
    // @spartan-ng/cli (we own it, but don't author it). It intentionally breaks
    // our app conventions: `hlm`/`brn` selector prefixes, un-suffixed class names
    // (HlmButton), and aliased inputs (incl. `class`). Exempt it from those rules
    // rather than fighting the generator on every re-sync.
    files: ['libs/spartan/**/*.ts'],
    rules: {
      '@angular-eslint/component-class-suffix': 'off',
      '@angular-eslint/component-selector': 'off',
      '@angular-eslint/directive-selector': 'off',
      '@angular-eslint/no-input-rename': 'off',
    },
  },
  {
    // TEMPORARY, and the last of the staging from #148 — one vendor, not four.
    //
    // The other three moved up into depConstraints as errors: #151 closed the 28
    // @angular/cdk/dialog and 2 @spartan-ng/brain/sonner imports, #154 the 62 @ng-icons
    // ones. @ctrl/ngx-emoji-mart still has 7 importers in libs/feature/rooms and #152 is
    // gated on the composer redesign, because the picker's placement lives in feature SCSS
    // today and a wrapper that grew its own positioning would then have to be undone. So
    // this stays a warning until that lands. Delete the whole block then.
    //
    // It MUST be the core `no-restricted-imports`, not the @typescript-eslint one: that one
    // is already configured at `error` over libs/feature/** carrying the matrix-js-sdk
    // patterns, and one rule entry has one severity, so folding this in would promote the
    // 7 known violations to errors. The two rule ids are distinct and both apply.
    //
    // There is deliberately NO companion `no-restricted-syntax` entry. Flat config replaces
    // a rule's options wholesale, so a second entry over these globs would delete the
    // matrix-js-sdk ImportExpression selector above without a word. It is also unnecessary
    // for the three now in depConstraints: @nx/enforce-module-boundaries visits
    // ImportExpression itself, verified with a planted probe.
    files: ['libs/feature/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'warn',
        {
          patterns: [
            {
              group: ['@ctrl/ngx-emoji-mart*'],
              message: UI_VENDOR_IMPORT_MESSAGE,
            },
          ],
        },
      ],
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
