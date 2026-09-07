import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWebBundleManifest,
  readWebBundleManifest,
  sha256,
  verifyWebBundleRoot,
  writeWebBundleManifest,
} from './web-bundle-manifest.mjs';

const temporary = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'trinity-web-bundle-'));
  temporary.push(root);
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<main>Trinity</main>');
  writeFileSync(join(root, 'assets/app.js'), 'console.log("trinity")');
  return root;
}

afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('web bundle manifest', () => {
  it('records a deterministic sorted payload', () => {
    const manifest = buildWebBundleManifest(fixture());
    expect(manifest.files.map((file) => file.path)).toEqual([
      'assets/app.js',
      'index.html',
    ]);
    expect(manifest.totalBytes).toBeGreaterThan(0);
  });

  it('rejects unlisted files and permits only explicit platform bootstrap files', () => {
    const source = fixture();
    const copied = fixture();
    writeFileSync(join(copied, 'cordova.js'), 'native bootstrap');
    const manifest = buildWebBundleManifest(source);
    expect(() => verifyWebBundleRoot(copied, manifest)).toThrow(
      /cordova\.js: unexpected/,
    );
    expect(() =>
      verifyWebBundleRoot(copied, manifest, {
        allowedExtraPaths: ['cordova.js'],
      }),
    ).not.toThrow();
  });

  it('rejects a changed or missing web asset', () => {
    const source = fixture();
    const copied = fixture();
    writeFileSync(join(copied, 'assets/app.js'), 'tampered');
    expect(() =>
      verifyWebBundleRoot(copied, buildWebBundleManifest(source)),
    ).toThrow(/assets\/app\.js: content differs/);
  });

  it('rejects missing files, empty manifests and identities from another build', () => {
    const root = fixture();
    const manifest = buildWebBundleManifest(root);
    expect(() =>
      verifyWebBundleRoot(root, manifest, { expectedSha: 'a'.repeat(40) }),
    ).toThrow(/identity/);
    expect(() =>
      verifyWebBundleRoot(root, { ...manifest, configuration: 'development' }),
    ).toThrow(/production configuration/);
    expect(() =>
      verifyWebBundleRoot(root, { ...manifest, files: [], totalBytes: 0 }),
    ).toThrow(/Unsupported/);
    unlinkSync(join(root, 'index.html'));
    expect(() => verifyWebBundleRoot(root, manifest)).toThrow(
      /index.html: missing/,
    );
  });

  it('binds the exact manifest bytes to an externally expected digest', () => {
    const root = fixture();
    const path = join(root, 'manifest.json');
    writeWebBundleManifest(root, path);
    const digest = sha256(readFileSync(path));
    expect(readWebBundleManifest(path, digest).configuration).toBe(
      'production',
    );
    writeFileSync(path, readFileSync(path, 'utf8') + ' ');
    expect(() => readWebBundleManifest(path, digest)).toThrow(/digest/);
  });

  it.each([
    './index.html',
    'assets//app.js',
    'C:/asset.js',
    'asset\\name',
    'bad\nname',
  ])('rejects non-normalized or unsafe path %j', (path) => {
    const root = fixture();
    const manifest = buildWebBundleManifest(root);
    manifest.files[0].path = path;
    expect(() => verifyWebBundleRoot(root, manifest)).toThrow(
      /safe bundle-relative path/,
    );
  });

  it('writes a readable manifest for cross-process verification', () => {
    const root = fixture();
    const destination = join(root, 'manifest.json');
    writeWebBundleManifest(root, destination);
    const saved = JSON.parse(readFileSync(destination, 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.files).toHaveLength(2);
  });

  it('rejects unsafe manifest paths and symlinks', () => {
    const source = fixture();
    const copied = fixture();
    const manifest = buildWebBundleManifest(source);
    manifest.files[0].path = '../outside.js';
    expect(() => verifyWebBundleRoot(copied, manifest)).toThrow(
      /safe bundle-relative path/,
    );

    const linked = fixture();
    symlinkSync(join(linked, 'index.html'), join(linked, 'linked.html'));
    expect(() => buildWebBundleManifest(linked)).toThrow(
      /Unsupported filesystem entry/,
    );
  });
});
