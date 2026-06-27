// @ts-check
import { defineConfig, globalIgnores } from 'eslint/config';
import angular from 'angular-eslint';
import nx from '@nx/eslint-plugin';

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
              sourceTag: 'scope:trinity',
              onlyDependOnLibsWithTags: ['scope:trinity'],
            },
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: [
                'type:feature',
                'type:core',
                'type:ui',
              ],
            },
            {
              sourceTag: 'type:feature',
              onlyDependOnLibsWithTags: ['type:core', 'type:ui'],
            },
            {
              sourceTag: 'type:core',
              onlyDependOnLibsWithTags: ['type:core'],
            },
            {
              // Presentational-only: no state/services, so no core dependency.
              sourceTag: 'type:ui',
              onlyDependOnLibsWithTags: ['type:ui'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
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
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended],
    rules: {},
  },
]);
