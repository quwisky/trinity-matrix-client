import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const code = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
const markdown = (file) => read(file).replace(/<!--[\s\S]*?-->/g, '');

const COMMONJS_ALLOWLIST = [
  'another-json',
  'content-type',
  'events',
  'loglevel',
  'matrix-events-sdk',
  'matrix-widget-api',
  'sdp-transform',
  'unhomoglyph',
];

describe('validation warning policy', () => {
  it('routes every declared Nx command through the color-normalizing entrypoint', () => {
    const pkg = json('package.json');
    expect(pkg.scripts.nx).toBe('node scripts/nx.mjs');
    expect(
      Object.entries(pkg.scripts)
        .filter(([, command]) => /(^|[;&|]\s*)nx\s/.test(command))
        .map(([name]) => name),
    ).toEqual([]);
    expect(code('scripts/nx.mjs')).toContain('delete env.NO_COLOR');

    const projects = globSync('**/project.json', { cwd: workspaceRoot }).filter(
      (project) => !project.includes('node_modules'),
    );
    expect(projects.length).toBeGreaterThan(60);
    expect(
      projects.filter((project) =>
        Object.values(json(project).targets ?? {}).some(
          (target) => target.executor === '@nx/eslint:lint',
        ),
      ),
    ).toEqual([]);

    const documentation = [
      '*.md',
      '.agents/**/*.md',
      '.claude/**/*.md',
      'apps/**/*.md',
      'docs/**/*.md',
      'e2e/**/*.md',
      'libs/**/*.md',
    ].flatMap((pattern) => globSync(pattern, { cwd: workspaceRoot }));
    expect(documentation.length).toBeGreaterThan(30);
    expect(
      documentation.filter((file) => markdown(file).includes('pnpm exec nx')),
    ).toEqual([]);
  });

  it('keeps every Vitest config loadable by Vite native mode', () => {
    const pkg = json('package.json');
    expect(pkg.type).toBe('module');
    expect(pkg.devDependencies['vite-tsconfig-paths']).toBeUndefined();

    const configs = globSync(
      ['apps/**/vite.config.ts', 'libs/**/vite.config.ts'],
      {
        cwd: workspaceRoot,
      },
    );
    expect(configs.length).toBeGreaterThan(30);
    for (const config of configs) {
      const source = code(config);
      expect(source, config).not.toContain('__dirname');
      expect(source, config).toContain('vite.base.config.ts');
    }

    const base = code('vite.base.config.ts');
    expect(base).not.toContain("from 'vite-tsconfig-paths'");
    expect(base).toContain('alias: workspaceAliases(root)');
  });

  it('pins browser, budget, and CommonJS classifications narrowly', () => {
    const browserFloors = read('.browserslistrc')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'));
    expect(browserFloors).toEqual([
      'Chrome >=119',
      'ChromeAndroid >=119',
      'Firefox >=119',
      'FirefoxAndroid >=119',
      'Edge >=119',
      'Safari >=17',
      'iOS >=17',
    ]);

    const build = json('apps/trinity/project.json').targets.build;
    expect(build.options.allowedCommonJsDependencies).toEqual(
      COMMONJS_ALLOWLIST,
    );
    expect(build.configurations.production.budgets).toEqual(
      expect.arrayContaining([
        {
          type: 'allScript',
          maximumWarning: '7mb',
          maximumError: '8mb',
        },
        {
          type: 'anyComponentStyle',
          maximumWarning: '6kb',
          maximumError: '8kb',
        },
      ]),
    );
  });

  it('keeps browser shims explicit and the tracked Android repository clean', () => {
    expect(code('test-setup.base.ts')).toContain('class NoopResizeObserver');
    expect(code('libs/feature/rooms/src/test-setup.ts')).toContain(
      'class TestResizeObserver',
    );
    const androidBuild = code('android/app/build.gradle');
    expect(androidBuild).not.toContain('flatDir');
    expect(
      androidBuild
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('keepDebugSymbols')),
    ).toEqual([
      "keepDebugSymbols += ['**/libdatastore_shared_counter.so', '**/libimage_processing_util_jni.so', '**/libsurface_util_jni.so']",
    ]);
    const warningLedger = markdown('docs/maintaining/validation-warnings.md');
    expect(warningLedger).toContain('Classified upstream Android output');
    for (const owner of [
      '@capacitor/android',
      '@capacitor/push-notifications',
      '@capacitor/filesystem',
      '@capacitor/camera',
    ]) {
      expect(warningLedger).toContain(owner);
    }
  });
});
