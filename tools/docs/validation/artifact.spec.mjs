import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateArtifact } from './artifact.mjs';

const temporaryDirectories = [];

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'trinity-docs-artifact-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'users'));
  mkdirSync(join(root, 'developers'));
  writeFileSync(
    join(root, 'index.html'),
    '<a href="./users/">Users</a><a href="./developers/">Developers</a>',
    'utf8',
  );
  writeFileSync(
    join(root, '404.html'),
    '<a href="/trinity-matrix-client/">Home</a>',
    'utf8',
  );
  writeFileSync(
    join(root, 'users', 'index.html'),
    '<link href="/trinity-matrix-client/users/site.css">',
    'utf8',
  );
  writeFileSync(
    join(root, 'developers', 'index.html'),
    '<a href="/trinity-matrix-client/developers/start/">Start</a>',
    'utf8',
  );
  return root;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('assembled Pages artifact', () => {
  it('accepts only the portal and two site roots', () => {
    expect(() => validateArtifact(fixture())).not.toThrow();
  });

  it('rejects a symbolic link', () => {
    const root = fixture();
    symlinkSync(join(root, 'index.html'), join(root, 'users', 'linked.html'));

    expect(() => validateArtifact(root)).toThrow(/symbolic link/);
  });

  it.each([
    ['users/app.js.map', 'source map'],
    ['users/client-secret.txt', 'secret-shaped filename'],
    ['notes.txt', 'unexpected top-level'],
  ])('rejects %s', (relativePath, message) => {
    const root = fixture();
    const destination = join(root, relativePath);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, 'unsafe\n', 'utf8');

    expect(() => validateArtifact(root)).toThrow(new RegExp(message));
  });

  it('rejects a local URL outside the GitHub Pages base', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'users', 'index.html'),
      '<link href="/wrong-base/site.css">',
      'utf8',
    );

    expect(() => validateArtifact(root)).toThrow(/invalid base/);
  });
});
