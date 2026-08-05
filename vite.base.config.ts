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
        // Set explicitly, and load-bearing: @analogjs/vite-plugin-angular defaults the pool to
        // `vmThreads` (`pool: userConfig.test?.pool ?? 'vmThreads'`), which reuses long-lived
        // workers and is the one pool that sets no `isolateWorkers` — so jsdom windows, TestBed
        // state and module graphs pile up in a single V8 isolate for the whole run. That put
        // feature-rooms at a 4.3 GB peak and got it OOM-killed on roughly half of all
        // `nx run-many -t test` runs. `forks` isolates per test file, so the OS reclaims memory
        // after each one: measured 4.27 GB -> 0.91 GB peak for +19% wall time. It is also
        // vitest's own default, which the plugin overrides. Naming it here wins cleanly via the
        // plugin's own `userConfig` escape hatch — no patching.
        pool: 'forks',
        // matrix-js-sdk 42.1.0 ships a broken ESM specifier: lib/oauth/authorize.js and
        // lib/oauth/index.js both `import ... from "../http-api"` — a bare directory. An
        // index.js is there, so bundlers resolve it and `pnpm build` is unaffected, but
        // Node's ESM resolver refuses a directory import (ERR_UNSUPPORTED_DIR_IMPORT) and
        // every spec that reaches the package root dies at import time, before a single
        // test runs. Inlining hands the module to vite instead of Node, which resolves it
        // the same way the build does.
        //
        // Set here rather than per project because all 22 vite configs delegate to this
        // factory, and the failure hits any of them that touches the SDK root. Remove once
        // the specifier is fixed upstream.
        server: { deps: { inline: ['matrix-js-sdk'] } },
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
