import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const read = (path: string): string =>
  readFileSync(join(workspaceRoot, path), 'utf8');

const relativeImports = (source: string): string[] =>
  [...source.matchAll(/(?:from\s+|import\()(['"])([^'"]+)\1/gu)].map(
    (match) => match[2],
  );

describe('E2E support architecture', () => {
  it('keeps environment adapters independent and selects them only at composition', () => {
    const adapters = [
      'e2e/android/fixtures.mts',
      'e2e/web-fixtures.mts',
      'e2e/electron/fixtures.mts',
    ];
    const [android, web, electron] = adapters.map(read);
    const composition = read('e2e/fixtures.mts');
    expect(android).not.toMatch(/\.\.\/(?:browser|web-fixtures)/);
    expect(web).not.toMatch(/\.\/android\//);
    expect(electron).not.toMatch(/\.\.\/(?:android|browser)\//);
    expect(electron).not.toMatch(/\.\.\/web-fixtures/);
    expect(composition).toContain("import('./android/fixtures.mts')");
    expect(composition).toContain("import('./web-fixtures.mts')");
    for (const adapter of adapters) {
      for (const specifier of relativeImports(read(adapter)).filter((value) =>
        value.startsWith('.'),
      )) {
        expect(specifier, `${adapter} imports ${specifier}`).toMatch(
          /^(?:\.\/|\.\.\/support\/)/u,
        );
      }
    }
  });

  it('prevents Android and Electron implementations from importing another environment fixture', () => {
    for (const environment of ['android', 'electron']) {
      const sources = globSync(`e2e/${environment}/**/*.{mjs,mts,ts}`, {
        cwd: workspaceRoot,
      });
      expect(sources.length).toBeGreaterThan(0);
      for (const path of sources) {
        const imports = relativeImports(read(path));
        expect(imports, path).not.toEqual(
          expect.arrayContaining([
            expect.stringMatching(
              /(?:^|\/)(?:android|browser|electron|web)(?:\/.*)?\/fixtures\.mts$|(?:^|\/)web-fixtures\.mts$|^\.\.\/fixtures\.mts$/u,
            ),
          ]),
        );
      }
    }
  });

  it('keeps host applications as delegates of lifecycle-owned targets', () => {
    const android = JSON.parse(read('e2e/android/project.json')) as {
      name: string;
      targets: Record<string, { cache?: boolean; parallelism?: boolean }>;
    };
    const electron = JSON.parse(read('e2e/electron/project.json')) as {
      name: string;
      targets: Record<string, { cache?: boolean; parallelism?: boolean }>;
    };
    const androidHost = read('android/project.json');
    const electronHost = read('electron/project.json');

    expect(android.name).toBe('trinity-e2e-android');
    expect(electron.name).toBe('trinity-e2e-electron');
    expect(
      JSON.parse(read('e2e/android/project.json')).implicitDependencies,
    ).toEqual(['trinity', 'trinity-android', 'trinity-e2e-support']);
    expect(
      JSON.parse(read('e2e/electron/project.json')).implicitDependencies,
    ).toEqual(['trinity-desktop', 'trinity-e2e-support']);
    for (const target of [
      android.targets['e2e'],
      electron.targets['full'],
      electron.targets['smoke'],
    ]) {
      expect(target).toMatchObject({ cache: false, parallelism: false });
    }
    expect(androidHost).toContain('trinity-e2e-android:e2e');
    expect(electronHost).toContain('trinity-e2e-electron:full');
    expect(electronHost).toContain('trinity-e2e-electron:smoke');
  });

  it('keeps protocol journeys inside the Playwright Test lifecycle', () => {
    const specs = globSync('e2e/protocol/*.spec.mjs', { cwd: workspaceRoot });
    expect(specs).toHaveLength(12);
    for (const spec of specs) {
      const source = read(spec);
      expect(source).toContain("from './fixtures.mts'");
      expect(source).not.toMatch(
        /chromium\.launch|process\.exit|node:child_process/,
      );
    }
  });

  it('keeps Playwright configs declarative and free of server ownership', () => {
    const configs = globSync('e2e/**/playwright*.config.mts', {
      cwd: workspaceRoot,
    });
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      const source = read(config);
      expect(source).not.toMatch(/\bwebServer\s*:/);
      expect(source).not.toMatch(/\bglobal(?:Setup|Teardown)\s*:/);
      expect(source).not.toMatch(/localhost:(?:4200|4400|4401|4402)/);
    }
  });

  it('keeps server-side test data on the support namespace contract', () => {
    const specs = [
      ...globSync('e2e/browser/journeys/**/*.spec.mts', {
        cwd: workspaceRoot,
      }),
      ...globSync('e2e/protocol/*.spec.mjs', { cwd: workspaceRoot }),
      ...readdirSync(join(workspaceRoot, 'e2e/electron'))
        .filter((file) => file.endsWith('.electron.spec.mts'))
        .map((file) => `e2e/electron/${file}`),
    ];
    expect(specs.length).toBeGreaterThan(100);
    for (const spec of specs) {
      const source = read(spec);
      expect(source, spec).not.toMatch(/Date\.now\(\)\.toString\(36\)/);
      expect(source, spec).not.toMatch(/Date\.now\(\).*Math\.random\(\)/);
    }
  });

  it('routes every official app-server entrypoint through the invocation owner', () => {
    const aggregateProject = read('e2e/project.json');
    const browserProject = read('e2e/browser/project.json');
    const protocolProject = read('e2e/protocol/project.json');
    expect(browserProject).toContain('support/run-playwright.mts');
    expect(protocolProject).toContain('protocol/run.mts');
    expect(
      `${aggregateProject}\n${browserProject}\n${protocolProject}`,
    ).not.toMatch(/PORT=\d+ node e2e\/playwright\/support\/serve-www/);
    for (const feature of globSync('e2e/protocol/*.spec.mjs', {
      cwd: workspaceRoot,
    })) {
      const source = read(feature);
      expect(source).not.toMatch(/support\/serve\.mjs/);
      expect(source).not.toMatch(/localhost:(?:812[3-9]|813[0-3])/);
    }
  });
});
