import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import manifestVersions, {
  readManifestVersions,
  resolveManifestVersion,
} from './manifest-versions.mjs';

const manifests = {
  node: '^24.15.0',
  packageManager: 'pnpm@12.10.1+sha512.abc',
  packages: { nx: '23.2.1', '@angular/core': '22.2.0', vitest: '5.0.2' },
  electronPackages: { electron: '44.6.0', vitest: '^5.0.0' },
};

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const inlineCode = (value) => ({ type: 'inlineCode', value });

const tableRow = (label, version) => ({
  type: 'tableRow',
  children: [
    { type: 'tableCell', children: [{ type: 'text', value: label }] },
    { type: 'tableCell', children: [inlineCode(version)] },
  ],
});

describe('manifest version references', () => {
  it.each([
    ['engines.node', '^24.15.0'],
    ['packageManager', '12.10.1'],
    ['nx', '23.2.1'],
    ['@angular/core', '22.2.0'],
    ['vitest', '5.0.2'],
    ['electron/electron', '44.6.0'],
    ['electron/vitest', '^5.0.0'],
  ])('resolves %s from its owning manifest', (selector, version) => {
    expect(resolveManifestVersion(manifests, selector)).toBe(version);
  });

  it.each(['nx-typo', 'electron/nx', 'electron/', 'engines.npm', ''])(
    'rejects %j because no manifest declares it',
    (selector) => {
      expect(() => resolveManifestVersion(manifests, selector)).toThrow(
        `version:${selector}`,
      );
    },
  );

  it('rejects a package manager field without a version', () => {
    expect(() =>
      resolveManifestVersion(
        { ...manifests, packageManager: 'pnpm' },
        'packageManager',
      ),
    ).toThrow('version:packageManager');
  });

  it('replaces only version references in inline code', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'table',
          children: [
            tableRow('Nx', 'version:nx'),
            tableRow('Electron', 'version:electron/electron'),
          ],
        },
        {
          type: 'paragraph',
          children: [inlineCode('version'), inlineCode('pnpm --version')],
        },
        { type: 'code', value: 'version:nx' },
      ],
    };

    manifestVersions(manifests)(tree, { path: 'page.md' });

    expect(tree.children[0].children[0].children[1].children).toEqual([
      inlineCode('23.2.1'),
    ]);
    expect(tree.children[0].children[1].children[1].children).toEqual([
      inlineCode('44.6.0'),
    ]);
    expect(tree.children[1].children).toEqual([
      inlineCode('version'),
      inlineCode('pnpm --version'),
    ]);
    expect(tree.children[2]).toEqual({ type: 'code', value: 'version:nx' });
  });

  it('fails the page that names an undeclared package', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [inlineCode('version:nxx')] }],
    };

    expect(() =>
      manifestVersions(manifests)(tree, { path: 'reference/stack.md' }),
    ).toThrow(/reference\/stack\.md.*version:nxx/);
  });

  it('requires the manifest versions as plugin options', () => {
    expect(() => manifestVersions()).toThrow('manifest versions');
  });

  it('reads the root and Electron manifests', () => {
    const root = mkdtempSync(join(tmpdir(), 'trinity-manifest-versions-'));
    temporaryDirectories.push(root);
    mkdirSync(join(root, 'electron'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@12.10.1',
        engines: { node: '^24.15.0' },
        dependencies: { rxjs: '~7.8.2' },
        devDependencies: { nx: '23.2.1' },
      }),
    );
    writeFileSync(
      join(root, 'electron', 'package.json'),
      JSON.stringify({ devDependencies: { electron: '44.6.0' } }),
    );

    expect(readManifestVersions(root)).toEqual({
      node: '^24.15.0',
      packageManager: 'pnpm@12.10.1',
      packages: { nx: '23.2.1', rxjs: '~7.8.2' },
      electronPackages: { electron: '44.6.0' },
    });
  });
});
