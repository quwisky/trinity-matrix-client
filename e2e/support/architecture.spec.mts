import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const read = (path: string): string =>
  readFileSync(join(workspaceRoot, path), 'utf8');

describe('E2E support architecture', () => {
  it('keeps environment adapters independent and selects them only at composition', () => {
    const android = read('e2e/android/fixtures.mts');
    const web = read('e2e/web-fixtures.mts');
    const electron = read('e2e/electron/fixtures.mts');
    const composition = read('e2e/fixtures.mts');
    expect(android).not.toMatch(/\.\.\/(?:browser|web-fixtures)/);
    expect(web).not.toMatch(/\.\/android\//);
    expect(electron).not.toMatch(/\.\.\/(?:android|browser)\//);
    expect(electron).not.toMatch(/\.\.\/web-fixtures/);
    expect(composition).toContain("import('./android/fixtures.mts')");
    expect(composition).toContain("import('./web-fixtures.mts')");
  });

  it('keeps all nine protocol entrypoints as thin support-owned adapters', () => {
    const runners = readdirSync(join(workspaceRoot, 'e2e/runners')).filter(
      (file) => file.endsWith('-run.mjs'),
    );
    expect(runners).toHaveLength(9);
    for (const runner of runners) {
      const source = read(`e2e/runners/${runner}`);
      expect(source).toContain("from '../support/protocol-runner.mts'");
      expect(source).not.toMatch(/synapse\/(?:start|stop|lease)/);
      expect(source).not.toMatch(/node:child_process/);
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
    expect(browserProject).toContain('support/run-playwright.mts');
    expect(aggregateProject).toContain('support/run-feature.mts');
    expect(`${aggregateProject}\n${browserProject}`).not.toMatch(
      /PORT=\d+ node e2e\/playwright\/support\/serve-www/,
    );
    for (const feature of readdirSync(
      join(workspaceRoot, 'e2e/features'),
    ).filter((file) => file.endsWith('.mjs'))) {
      const source = read(`e2e/features/${feature}`);
      expect(source).not.toMatch(/support\/serve\.mjs/);
      expect(source).not.toMatch(/localhost:(?:812[3-9]|813[0-3])/);
    }
  });
});
