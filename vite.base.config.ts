import angular from '@analogjs/vite-plugin-angular';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { mergeConfig, type UserConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

/** Walk up from a project dir to the workspace root (the dir holding nx.json). */
function workspaceRootFrom(projectDir: string): string {
  let dir = projectDir;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'nx.json'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return projectDir;
}

/**
 * Shared Vitest config for the Angular libs + app: the Analog compiler plugin,
 * jsdom, `@trinity/*` alias resolution, and coverage. Each project's
 * `vite.config.ts` calls this with its own `__dirname`; the workspace root (and
 * therefore cacheDir / coverage output) is derived by walking up to nx.json, so
 * this works at any directory depth (libs/* and libs/spartan/* alike).
 * Per-project extras (e.g. `passWithNoTests`) go in `overrides`.
 */
export function createVitestConfig(
  projectDir: string,
  overrides: UserConfig = {},
): UserConfig {
  const root = workspaceRootFrom(projectDir);
  const rel = relative(root, projectDir);
  return mergeConfig<UserConfig, UserConfig>(
    {
      root: projectDir,
      cacheDir: join(root, 'node_modules/.vite', rel),
      plugins: [
        angular(),
        tsconfigPaths({ root, projects: ['tsconfig.base.json'] }),
      ],
      test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['src/test-setup.ts'],
        include: ['src/**/*.spec.ts'],
        reporters: ['default'],
        // Coverage is opt-in (only collected with `--coverage`); report-only, no
        // thresholds, so a normal `vitest run` is unaffected.
        coverage: {
          provider: 'v8',
          reporter: ['text', 'html', 'lcov'],
          reportsDirectory: join(root, 'coverage', rel),
          include: ['src/**/*.ts'],
          exclude: ['src/**/*.spec.ts', 'src/test-setup.ts', 'src/**/*.d.ts'],
        },
      },
    },
    overrides,
  );
}
