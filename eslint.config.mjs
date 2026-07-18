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

export default defineConfig([
  globalIgnores([
    '**/dist',
    '**/www',
    '**/coverage',
    '**/node_modules',
    '**/.angular',
    'android',
    'ios',
    'e2e',
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
]);
