import {
  existsSync,
  mkdtempSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assemblePages } from './assemble-pages.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Pages assembly', () => {
  it('replaces stale output with only the landing page, 404 and two built sites', () => {
    const root = mkdtempSync(join(tmpdir(), 'trinity-docs-assemble-'));
    temporaryDirectories.push(root);
    const portalRoot = join(root, 'portal');
    const siteRoot = join(root, 'site-build');
    const userRoot = join(root, 'user-build');
    const developerRoot = join(root, 'developer-build');
    const outputRoot = join(root, 'dist', 'docs-site');
    for (const directory of [
      portalRoot,
      siteRoot,
      userRoot,
      developerRoot,
      outputRoot,
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(siteRoot, 'index.html'), '<main>Site</main>', 'utf8');
    writeFileSync(
      join(portalRoot, '404.html'),
      '<main>Not found</main>',
      'utf8',
    );
    writeFileSync(join(userRoot, 'index.html'), '<main>User</main>', 'utf8');
    writeFileSync(
      join(developerRoot, 'index.html'),
      '<main>Developer</main>',
      'utf8',
    );
    writeFileSync(join(outputRoot, 'stale.txt'), 'stale\n', 'utf8');

    assemblePages({
      siteRoot,
      portalRoot,
      userRoot,
      developerRoot,
      outputRoot,
    });

    expect(existsSync(join(outputRoot, 'index.html'))).toBe(true);
    expect(existsSync(join(outputRoot, '404.html'))).toBe(true);
    expect(existsSync(join(outputRoot, 'users', 'index.html'))).toBe(true);
    expect(existsSync(join(outputRoot, 'developers', 'index.html'))).toBe(true);
    expect(existsSync(join(outputRoot, 'stale.txt'))).toBe(false);
  });

  it('puts the landing page at the root beside the guides', () => {
    const root = mkdtempSync(join(tmpdir(), 'trinity-docs-assemble-'));
    temporaryDirectories.push(root);
    const portalRoot = join(root, 'portal');
    const siteRoot = join(root, 'site-build');
    const userRoot = join(root, 'user-build');
    const developerRoot = join(root, 'developer-build');
    const outputRoot = join(root, 'dist', 'docs-site');
    for (const directory of [portalRoot, join(siteRoot, '_astro'), userRoot]) {
      mkdirSync(directory, { recursive: true });
    }
    mkdirSync(developerRoot, { recursive: true });
    writeFileSync(join(siteRoot, 'index.html'), '<main>Site</main>', 'utf8');
    writeFileSync(join(siteRoot, '_astro', 'a.css'), 'a{}\n', 'utf8');
    writeFileSync(join(portalRoot, '404.html'), '<main>Nope</main>', 'utf8');
    writeFileSync(join(userRoot, 'index.html'), '<main>User</main>', 'utf8');
    writeFileSync(
      join(developerRoot, 'index.html'),
      '<main>Dev</main>',
      'utf8',
    );

    assemblePages({
      siteRoot,
      portalRoot,
      userRoot,
      developerRoot,
      outputRoot,
    });

    expect(readFileSync(join(outputRoot, 'index.html'), 'utf8')).toContain(
      'Site',
    );
    expect(existsSync(join(outputRoot, '_astro', 'a.css'))).toBe(true);
    expect(readFileSync(join(outputRoot, '404.html'), 'utf8')).toContain(
      'Nope',
    );
    expect(existsSync(join(outputRoot, 'users', 'index.html'))).toBe(true);
    expect(existsSync(join(outputRoot, 'developers', 'index.html'))).toBe(true);
  });
});
