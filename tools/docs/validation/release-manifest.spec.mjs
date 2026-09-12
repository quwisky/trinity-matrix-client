import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { publicPageSchema } from './frontmatter.ts';
import {
  readReleaseManifest,
  validateUserContentState,
} from './release-manifest.mjs';

const temporaryDirectories = [];

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'trinity-docs-release-'));
  temporaryDirectories.push(root);
  return root;
};

const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release manifest', () => {
  it.each([
    [
      { status: 'unreleased', version: null },
      { status: 'unreleased', version: null },
    ],
    [
      { status: 'published', version: '1.2.3' },
      { status: 'published', version: '1.2.3' },
    ],
  ])('accepts a supported release state', (input, expected) => {
    const root = fixture();
    const path = join(root, 'release.json');
    writeJson(path, input);

    expect(readReleaseManifest(path)).toEqual(expected);
  });

  it.each([
    [{ status: 'published', version: null }, /semantic version/],
    [{ status: 'published', version: 'v1.2.3' }, /semantic version/],
    [{ status: 'unreleased', version: '1.2.3' }, /must have a null version/],
    [{ status: 'future', version: null }, /status/],
    [{ status: 'unreleased', version: null, branch: 'develop' }, /unknown key/],
  ])('rejects an invalid release state', (input, message) => {
    const root = fixture();
    const path = join(root, 'release.json');
    writeJson(path, input);

    expect(() => readReleaseManifest(path)).toThrow(message);
  });

  it('allows only the WIP index while the user channel is unreleased', () => {
    const root = fixture();
    writeFileSync(join(root, 'index.md'), '# Work in progress\n', 'utf8');
    mkdirSync(join(root, 'setup'));
    writeFileSync(join(root, 'setup', 'install.md'), '# Install\n', 'utf8');

    expect(() =>
      validateUserContentState(root, { status: 'unreleased', version: null }),
    ).toThrow(/only index\.md/);
  });

  it('accepts Astro content roots expressed as file URLs', () => {
    const root = fixture();
    writeFileSync(join(root, 'index.md'), '# Work in progress\n', 'utf8');

    expect(() =>
      validateUserContentState(pathToFileURL(root), {
        status: 'unreleased',
        version: null,
      }),
    ).not.toThrow();
  });
});

describe('public page frontmatter', () => {
  const common = {
    description: 'A useful description.',
    pageType: 'how-to',
    platforms: ['web'],
  };

  it('accepts user metadata for the published release', () => {
    const schema = publicPageSchema('user', {
      status: 'published',
      version: '1.2.3',
    });

    expect(
      schema.parse({
        ...common,
        audience: 'user',
        contentChannel: 'release',
        productVersion: '1.2.3',
      }),
    ).toMatchObject({ productVersion: '1.2.3' });
  });

  it('accepts developer metadata without a product release version', () => {
    const schema = publicPageSchema('developer');

    expect(
      schema.parse({
        ...common,
        audience: 'developer',
        contentChannel: 'develop',
      }),
    ).toMatchObject({ audience: 'developer', contentChannel: 'develop' });
  });

  it.each([
    [
      'wrong audience',
      { ...common, audience: 'developer', contentChannel: 'release' },
    ],
    [
      'wrong channel',
      { ...common, audience: 'user', contentChannel: 'develop' },
    ],
    [
      'unknown page type',
      {
        ...common,
        audience: 'user',
        contentChannel: 'release',
        pageType: 'guide',
      },
    ],
    [
      'unknown platform',
      {
        ...common,
        audience: 'user',
        contentChannel: 'release',
        platforms: ['watch'],
      },
    ],
    [
      'wrong release version',
      {
        ...common,
        audience: 'user',
        contentChannel: 'release',
        productVersion: '1.2.4',
      },
    ],
  ])('rejects user metadata with a %s', (_case, input) => {
    const schema = publicPageSchema('user', {
      status: 'published',
      version: '1.2.3',
    });

    expect(schema.safeParse(input).success).toBe(false);
  });

  it('rejects a product version on developer pages', () => {
    const schema = publicPageSchema('developer');

    expect(
      schema.safeParse({
        ...common,
        audience: 'developer',
        contentChannel: 'develop',
        productVersion: '1.2.3',
      }).success,
    ).toBe(false);
  });
});
