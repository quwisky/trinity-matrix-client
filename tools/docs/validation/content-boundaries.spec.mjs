import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateContentBoundaries } from './content-boundaries.mjs';

const temporaryDirectories = [];

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'trinity-docs-boundaries-'));
  temporaryDirectories.push(root);
  const userRoot = join(root, 'users');
  const developerRoot = join(root, 'developers');
  mkdirSync(userRoot);
  mkdirSync(developerRoot);
  writeFileSync(join(userRoot, 'index.md'), 'User guide\n', 'utf8');
  writeFileSync(join(developerRoot, 'index.md'), 'Developer guide\n', 'utf8');
  return { userRoot, developerRoot };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('public content boundaries', () => {
  it('allows a public user link to the rendered developer site', () => {
    const roots = fixture();
    writeFileSync(
      join(roots.userRoot, 'index.md'),
      '[Developer guide](/trinity-matrix-client/developers/)\n',
      'utf8',
    );

    expect(() => validateContentBoundaries(roots)).not.toThrow();
  });

  it('allows relative links when the checkout path is itself hidden', () => {
    const roots = fixture();
    writeFileSync(
      join(roots.developerRoot, 'index.md'),
      '[State](./architecture/state-and-reactivity/)\n',
      'utf8',
    );

    expect(() => validateContentBoundaries(roots)).not.toThrow();
  });

  it('rejects a public link into internal documentation', () => {
    const roots = fixture();
    writeFileSync(
      join(roots.userRoot, 'index.md'),
      '[Private notes](../../docs-internal/notes.md)\n',
      'utf8',
    );

    expect(() => validateContentBoundaries(roots)).toThrow(
      /internal documentation/,
    );
  });

  it('rejects a user-content import from the developer collection', () => {
    const roots = fixture();
    writeFileSync(
      join(roots.userRoot, 'index.mdx'),
      "import DeveloperPage from '../developers/index.md';\n",
      'utf8',
    );

    expect(() => validateContentBoundaries(roots)).toThrow(/developer content/);
  });
});
