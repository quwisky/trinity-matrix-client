import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWebBundleManifest, sha256 } from './web-bundle-manifest.mjs';
import {
  restoreRenderer,
  stagingDirectory,
  validateArtifactMetadata,
  validateCoordinates,
} from './renderer-artifact.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const COORDINATES = {
  sha: SHA,
  runId: '123',
  artifactId: '456',
  artifactName: 'renderer-123-1-0123456789abcdef0123456789abcdef01234567',
};

const roots = [];
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'renderer-artifact-'));
  roots.push(root);
  return root;
}

function productionManifest(root) {
  return buildWebBundleManifest(join(root, 'www'), {
    commitSha: SHA,
    configuration: 'production',
  });
}

function stageValidArtifact(root, destination = 'dist/renderer') {
  const staging = stagingDirectory(root, destination);
  mkdirSync(join(staging, 'dist'), { recursive: true });
  mkdirSync(join(staging, 'www', 'assets'), { recursive: true });
  writeFileSync(join(staging, 'www', 'index.html'), '<main>renderer</main>\n');
  writeFileSync(join(staging, 'www', 'assets', 'app.js'), 'console.log(1);\n');
  const manifest = productionManifest(staging);
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(
    join(staging, 'dist', 'web-bundle-manifest.json'),
    manifestBody,
  );
  writeFileSync(
    join(staging, 'dist', 'web-bundle-manifest.json.sha256'),
    `${sha256(Buffer.from(manifestBody))}  web-bundle-manifest.json\n`,
  );
  return {
    staging,
    digest: sha256(Buffer.from(manifestBody)),
  };
}

function restoreInput(digest) {
  return { ...COORDINATES, digest };
}

function preserveExistingPayload(root) {
  mkdirSync(join(root, 'www'), { recursive: true });
  writeFileSync(join(root, 'www', 'old.txt'), 'keep me');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('renderer artifact coordinates and metadata', () => {
  it('accepts complete coordinates and an unexpired matching artifact', () => {
    validateCoordinates({ ...COORDINATES, digest: 'a'.repeat(64) });
    expect(() =>
      validateArtifactMetadata(
        {
          id: 456,
          name: COORDINATES.artifactName,
          expired: false,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          workflow_run: { id: 123 },
        },
        { ...COORDINATES, digest: 'a'.repeat(64) },
      ),
    ).not.toThrow();
  });

  it.each([
    ['wrong run', { runId: '999' }],
    ['wrong artifact ID', { artifactId: '999' }],
    ['wrong artifact name', { artifactName: 'other-artifact' }],
  ])('rejects metadata with %s', (_label, changes) => {
    expect(() =>
      validateArtifactMetadata(
        {
          id: 456,
          name: COORDINATES.artifactName,
          expired: false,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          workflow_run: { id: 123 },
        },
        { ...COORDINATES, digest: 'a'.repeat(64), ...changes },
      ),
    ).toThrow();
  });

  it('rejects expired and missing artifact metadata', () => {
    const input = { ...COORDINATES, digest: 'a'.repeat(64) };
    const artifact = {
      id: 456,
      name: COORDINATES.artifactName,
      expired: false,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      workflow_run: { id: 123 },
    };
    expect(() =>
      validateArtifactMetadata({ ...artifact, expired: true }, input),
    ).toThrow();
    expect(() =>
      validateArtifactMetadata(
        { ...artifact, expires_at: new Date(0).toISOString() },
        input,
      ),
    ).toThrow();
    expect(() => validateArtifactMetadata(undefined, input)).toThrow();
  });

  it('rejects incomplete coordinates', () => {
    for (const key of [
      'sha',
      'runId',
      'artifactId',
      'artifactName',
      'digest',
    ]) {
      const input = { ...COORDINATES, digest: 'a'.repeat(64) };
      delete input[key];
      expect(() => validateCoordinates(input), key).toThrow();
    }
  });
});

describe('restoreRenderer', () => {
  it('verifies the manifest and checksum before replacing www', () => {
    const root = temporaryRoot();
    const { staging, digest } = stageValidArtifact(root);
    preserveExistingPayload(root);

    restoreRenderer(root, 'dist/renderer', restoreInput(digest));

    expect(readFileSync(join(root, 'www', 'index.html'), 'utf8')).toBe(
      '<main>renderer</main>\n',
    );
    expect(readFileSync(join(root, 'www', 'assets', 'app.js'), 'utf8')).toBe(
      'console.log(1);\n',
    );
    expect(existsSync(join(root, 'www', 'old.txt'))).toBe(false);
    expect(
      readFileSync(join(root, 'dist', 'web-bundle-manifest.json'), 'utf8'),
    ).toBe(
      readFileSync(join(staging, 'dist', 'web-bundle-manifest.json'), 'utf8'),
    );
  });

  it.each([
    [
      'wrong manifest digest',
      (root, staging, digest) => ({ digest: 'b'.repeat(64) }),
    ],
    [
      'wrong manifest SHA',
      (root, staging, digest) => ({ sha: 'f'.repeat(40) }),
    ],
    [
      'wrong manifest checksum',
      (root, staging) => {
        writeFileSync(
          join(staging, 'dist', 'web-bundle-manifest.json.sha256'),
          `${'b'.repeat(64)}  web-bundle-manifest.json\n`,
        );
        return {};
      },
    ],
    [
      'changed payload',
      (root, staging) => {
        writeFileSync(join(staging, 'www', 'index.html'), 'tampered');
        return {};
      },
    ],
    [
      'missing payload',
      (root, staging) => {
        rmSync(join(staging, 'www', 'index.html'));
        return {};
      },
    ],
    [
      'extra payload',
      (root, staging) => {
        writeFileSync(join(staging, 'www', 'unexpected.js'), 'unexpected');
        return {};
      },
    ],
  ])('rejects %s without replacing the existing www', (_label, mutate) => {
    const root = temporaryRoot();
    const { staging, digest } = stageValidArtifact(root);
    preserveExistingPayload(root);
    const changes = mutate(root, staging, digest);

    expect(() =>
      restoreRenderer(root, 'dist/renderer', {
        ...restoreInput(digest),
        ...changes,
      }),
    ).toThrow();
    expect(readFileSync(join(root, 'www', 'old.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(join(root, 'www', 'index.html'))).toBe(false);
  });

  it('rejects unsafe staging entries before reading or replacing the payload', () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'renderer'), 'file');
    expect(() => stagingDirectory(root, 'dist/renderer/nested')).toThrow();

    const symlinkRoot = temporaryRoot();
    mkdirSync(join(symlinkRoot, 'outside'));
    mkdirSync(join(symlinkRoot, 'dist'));
    symlinkSync(
      join(symlinkRoot, 'outside'),
      join(symlinkRoot, 'dist', 'renderer'),
    );
    expect(() => stagingDirectory(symlinkRoot, 'dist/renderer')).toThrow();
  });

  it('rejects symlinks in the staged payload without replacing www', () => {
    const root = temporaryRoot();
    const { staging, digest } = stageValidArtifact(root);
    preserveExistingPayload(root);
    symlinkSync(
      join(staging, 'www', 'index.html'),
      join(staging, 'www', 'link.html'),
    );

    expect(() =>
      restoreRenderer(root, 'dist/renderer', restoreInput(digest)),
    ).toThrow();
    expect(readFileSync(join(root, 'www', 'old.txt'), 'utf8')).toBe('keep me');
  });
});
