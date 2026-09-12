import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const rootManifest = JSON.parse(
  readFileSync(join(workspaceRoot, 'package.json'), 'utf8'),
);
const electronManifest = JSON.parse(
  readFileSync(join(workspaceRoot, 'electron/package.json'), 'utf8'),
);
const stackPath =
  'apps/docs-developers/src/content/docs/reference/technology-stack.md';
const stackDoc = readFileSync(join(workspaceRoot, stackPath), 'utf8');

const documentedVersions = new Map(
  stackDoc
    .split('\n')
    .map((line) => line.match(/^\|\s*`?([^|`]+?)`?\s*\|\s*`([^`]+)`\s*\|$/))
    .filter(Boolean)
    .map(([, name, version]) => [name.trim(), version]),
);

const rootVersion = (name) =>
  rootManifest.dependencies?.[name] ?? rootManifest.devDependencies?.[name];
const electronVersion = (name) =>
  electronManifest.dependencies?.[name] ??
  electronManifest.devDependencies?.[name];

const expectedVersions = {
  'Node.js': rootManifest.engines.node,
  pnpm: rootManifest.packageManager.replace(/^pnpm@/, ''),
  Nx: rootVersion('nx'),
  TypeScript: rootVersion('typescript'),
  Angular: rootVersion('@angular/core'),
  'matrix-js-sdk': rootVersion('matrix-js-sdk'),
  RxJS: rootVersion('rxjs'),
  'Capacitor Core': rootVersion('@capacitor/core'),
  Electron: electronVersion('electron'),
  Astro: rootVersion('astro'),
  Starlight: rootVersion('@astrojs/starlight'),
  Vitest: rootVersion('vitest'),
  Playwright: rootVersion('@playwright/test'),
};

describe('developer technology stack reference', () => {
  it.each(Object.entries(expectedVersions))(
    'documents the declared %s version',
    (name, version) => {
      expect(
        documentedVersions.get(name),
        `${stackPath} must match the owning manifest`,
      ).toBe(version);
    },
  );

  it('covers every declared reference row', () => {
    expect([...documentedVersions.keys()].sort()).toEqual(
      Object.keys(expectedVersions).sort(),
    );
  });
});
