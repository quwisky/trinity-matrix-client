import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const read = (path: string): string =>
  readFileSync(join(workspaceRoot, path), 'utf8');

describe('E2E support architecture', () => {
  it('keeps environment adapters independent and selects them only at composition', () => {
    const android = read('e2e/android/fixtures.mts');
    const browser = read('e2e/playwright/support/fixtures.mts');
    const electron = read('e2e/electron/fixtures.mts');
    const composition = read('e2e/fixtures.mts');
    expect(android).not.toMatch(/\.\.\/playwright\//);
    expect(browser).not.toMatch(/\.\.\/\.\.\/android\//);
    expect(electron).not.toMatch(/\.\.\/(?:android|playwright)\//);
    expect(composition).toContain("import('./android/fixtures.mts')");
    expect(composition).toContain(
      "import('./playwright/support/fixtures.mts')",
    );
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
    const configs = readdirSync(join(workspaceRoot, 'e2e')).filter((file) =>
      /^playwright.*\.config\.mts$/.test(file),
    );
    for (const config of configs) {
      const source = read(`e2e/${config}`);
      expect(source).not.toMatch(/\bwebServer\s*:/);
      expect(source).not.toMatch(/\bglobal(?:Setup|Teardown)\s*:/);
      expect(source).not.toMatch(/localhost:(?:4200|4400|4401|4402)/);
    }
  });

  it('keeps server-side test data on the support namespace contract', () => {
    const specs = [
      ...readdirSync(join(workspaceRoot, 'e2e/playwright'))
        .filter((file) => file.endsWith('.spec.mts'))
        .map((file) => `e2e/playwright/${file}`),
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
    const project = read('e2e/project.json');
    expect(project).toContain('support/run-playwright.mts');
    expect(project).toContain('support/run-feature.mts');
    expect(project).not.toMatch(
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
