import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSourceReference,
  serializeSourceReference,
  validatePublishedSourceReference,
} from './source-reference.mjs';

const temporaryDirectories = [];
const workspaceRoot = join(import.meta.dirname, '../../..');

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'trinity-docs-source-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'apps', 'sample'), { recursive: true });
  mkdirSync(join(root, 'electron'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      packageManager: 'pnpm@11.19.0',
      engines: { node: '^24.15.0' },
      scripts: { zebra: 'z', alpha: 'a' },
      dependencies: { runtime: '2.0.0' },
      devDependencies: { tooling: '1.0.0' },
    }),
    'utf8',
  );
  writeFileSync(
    join(root, 'electron', 'package.json'),
    JSON.stringify({ dependencies: { electron: '41.0.2' } }),
    'utf8',
  );
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\n",
    'utf8',
  );
  writeFileSync(
    join(root, 'tsconfig.base.json'),
    JSON.stringify({
      compilerOptions: {
        paths: { '@trinity/z': ['./z.ts'], '@trinity/a': ['./a.ts'] },
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(root, 'apps', 'sample', 'project.json'),
    JSON.stringify({
      name: 'sample',
      root: 'apps/sample',
      tags: ['scope:shared', 'type:app'],
      targets: { test: {}, build: {} },
    }),
    'utf8',
  );
  return root;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('source-derived documentation reference', () => {
  it('sorts repository facts into stable JSON', () => {
    const root = fixture();
    const first = serializeSourceReference(
      buildSourceReference(root, { commit: '0123456789abcdef' }),
    );
    const second = serializeSourceReference(
      buildSourceReference(root, { commit: '0123456789abcdef' }),
    );

    expect(first).toBe(second);
    expect(JSON.parse(first)).toEqual({
      aliases: {
        '@trinity/a': ['./a.ts'],
        '@trinity/z': ['./z.ts'],
      },
      buildCommit: '0123456789abcdef',
      lockfileVersion: '9.0',
      node: '^24.15.0',
      packageManager: 'pnpm@11.19.0',
      packages: {
        electron: '41.0.2',
        runtime: '2.0.0',
        tooling: '1.0.0',
      },
      projects: [
        {
          name: 'sample',
          root: 'apps/sample',
          tags: ['scope:shared', 'type:app'],
          targets: ['build', 'test'],
        },
      ],
      scripts: { alpha: 'a', zebra: 'z' },
    });
  });

  it('matches current workspace manifests, projects, and aliases', () => {
    const packageManifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'package.json'), 'utf8'),
    );
    const tsconfig = JSON.parse(
      readFileSync(join(workspaceRoot, 'tsconfig.base.json'), 'utf8'),
    );
    const first = buildSourceReference(workspaceRoot, {
      commit: 'test-commit',
    });
    const second = buildSourceReference(workspaceRoot, {
      commit: 'test-commit',
    });

    expect(serializeSourceReference(first)).toBe(
      serializeSourceReference(second),
    );
    expect(first.node).toBe(packageManifest.engines.node);
    expect(first.packageManager).toBe(packageManifest.packageManager);
    expect(first.aliases).toEqual(tsconfig.compilerOptions.paths);
    expect(first.projects.map(({ name }) => name)).toContain('trinity');
    expect(first.projects.map(({ name }) => name)).toContain('docs-site');
    expect(() =>
      validatePublishedSourceReference(
        join(workspaceRoot, 'apps/docs-developers/src/content/docs'),
        first,
      ),
    ).not.toThrow();
  });
});
