import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeWebBundleManifest } from './web-bundle-manifest.mjs';
import {
  SWS_IMAGE,
  stageContainerContext,
  verifyContainerInputs,
  verifyContainerPolicy,
  verifyImageRecord,
} from './web-container.mjs';

const workspaceRoot = resolve(import.meta.dirname, '..');
const commitSha = 'a'.repeat(40);
const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'trinity-container-contract-'));
  temporaryRoots.push(root);
  for (const directory of ['container', 'electron', 'www/assets/crypto'])
    mkdirSync(join(root, directory), { recursive: true });
  for (const file of ['Dockerfile', 'sws.toml', '.dockerignore'])
    copyFileSync(
      join(workspaceRoot, 'container', file),
      join(root, 'container', file),
    );
  copyFileSync(join(workspaceRoot, 'LICENSE'), join(root, 'LICENSE'));
  for (const file of ['package.json', 'electron/package.json'])
    writeFileSync(join(root, file), JSON.stringify({ license: 'MIT' }));
  for (const file of [
    'index.html',
    'ngsw.json',
    'ngsw-worker.js',
    'manifest.webmanifest',
    '3rdpartylicenses.txt',
    'assets/crypto/matrix_sdk_crypto_wasm_bg.wasm',
  ]) {
    writeFileSync(
      join(root, 'www', file),
      'verified fixture for ' + file + '\n',
    );
  }
  writeFileSync(join(root, '.env'), 'DO_NOT_COPY=fixture\n');
  writeWebBundleManifest(
    join(root, 'www'),
    join(root, 'dist/web-bundle-manifest.json'),
    { commitSha, configuration: 'production' },
  );
  return root;
}

describe('verified container build inputs', () => {
  it('stages only renderer and host inputs, normalizing copies without changing source bytes or modes', () => {
    const root = fixture();
    chmodSync(join(root, 'www/index.html'), 0o600);
    const destination = join(root, 'dist/context');
    const before = readFileSync(join(root, 'dist/web-bundle-manifest.json'));
    const identity = stageContainerContext(root, destination, commitSha);
    expect(readdirSync(destination).sort()).toEqual([
      '.dockerignore',
      'Dockerfile',
      'LICENSE',
      'sws.toml',
      'www',
    ]);
    expect(existsSync(join(destination, '.env'))).toBe(false);
    expect(readFileSync(join(destination, '.dockerignore'))).toEqual(
      readFileSync(join(root, 'container/.dockerignore')),
    );
    expect(readFileSync(join(destination, 'www/3rdpartylicenses.txt'))).toEqual(
      readFileSync(join(root, 'www/3rdpartylicenses.txt')),
    );
    expect(statSync(join(destination, 'www')).mode & 0o777).toBe(0o755);
    expect(statSync(join(destination, 'www/index.html')).mode & 0o777).toBe(
      0o644,
    );
    expect(statSync(join(root, 'www/index.html')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, 'dist/web-bundle-manifest.json'))).toEqual(
      before,
    );
    expect(identity.manifest.commitSha).toBe(commitSha);
  });

  it('rejects a renderer recorded for another checkout', () => {
    expect(() => verifyContainerInputs(fixture(), 'b'.repeat(40))).toThrow(
      /identity/,
    );
  });

  it('rejects modified or extra renderer bytes before staging', () => {
    const root = fixture();
    writeFileSync(join(root, 'www/index.html'), 'tampered');
    expect(() =>
      stageContainerContext(root, join(root, 'dist/context'), commitSha),
    ).toThrow();
    expect(existsSync(join(root, 'dist/context/Dockerfile'))).toBe(false);
    const second = fixture();
    writeFileSync(join(second, 'www/unrecorded.js'), 'extra');
    expect(() => verifyContainerInputs(second, commitSha)).toThrow();
  });

  it('rejects incomplete PWA payloads even with a valid manifest', () => {
    const root = fixture();
    rmSync(join(root, 'www/ngsw-worker.js'));
    writeWebBundleManifest(
      join(root, 'www'),
      join(root, 'dist/web-bundle-manifest.json'),
      { commitSha, configuration: 'production' },
    );
    expect(() => verifyContainerInputs(root, commitSha)).toThrow(
      /missing ngsw-worker/,
    );
  });

  it.each([
    'package.json',
    'electron/package.json',
    'LICENSE',
    'container/Dockerfile',
  ])('rejects divergent MIT metadata in %s', (file) => {
    const root = fixture();
    const value = readFileSync(join(root, file), 'utf8').replace(
      'MIT',
      'Apache-2.0',
    );
    writeFileSync(join(root, file), value);
    expect(() => verifyContainerPolicy(root)).toThrow(/MIT/);
  });

  it('rejects build instructions that add a toolchain', () => {
    const root = fixture();
    const path = join(root, 'container/Dockerfile');
    writeFileSync(path, readFileSync(path, 'utf8') + '\nRUN apk add nodejs\n');
    expect(() => verifyContainerPolicy(root)).toThrow(/build tools/);
  });

  it('requires a unique empty staging destination', () => {
    const root = fixture();
    const path = join(root, 'dist/context');
    mkdirSync(path);
    writeFileSync(join(path, 'credential'), 'fixture');
    expect(() => stageContainerContext(root, path, commitSha)).toThrow(/empty/);
  });
});

describe('container image identity', () => {
  it('accepts an immutable image bound to the exact renderer and host configuration', () => {
    const identity = verifyContainerInputs(fixture(), commitSha);
    const imageId = 'sha256:' + 'b'.repeat(64);
    const record = {
      version: 1,
      imageId,
      commitSha,
      manifestSha256: identity.manifestSha256,
      hostSha256: identity.hostSha256,
    };
    expect(verifyImageRecord(record, identity)).toBe(imageId);
    for (const mutation of [
      { imageId: 'trinity:latest' },
      { commitSha: 'b'.repeat(40) },
      { manifestSha256: 'c'.repeat(64) },
      { hostSha256: 'd'.repeat(64) },
      { version: 2 },
    ])
      expect(() =>
        verifyImageRecord({ ...record, ...mutation }, identity),
      ).toThrow(/does not match/);
  });
});

// These guards protect a privilege/artifact boundary that fixture tests cannot
// observe: the checked-in image recipe and Nx build dependency graph.
describe('container host configuration', () => {
  it('pins the rootless runtime and never depends on an Angular build', () => {
    const dockerfile = readFileSync(
      join(workspaceRoot, 'container/Dockerfile'),
      'utf8',
    ).replace(/^\s*#.*$/gm, '');
    const project = JSON.parse(
      readFileSync(join(workspaceRoot, 'container/project.json'), 'utf8'),
    );
    expect(dockerfile).toContain('FROM ' + SWS_IMAGE);
    expect(dockerfile).toContain(
      'COPY --chown=1000:1000 www/ /home/sws/public/',
    );
    expect(dockerfile).toContain('USER sws');
    expect(dockerfile).not.toMatch(/^\s*(RUN|ADD|VOLUME)\b/m);
    expect(project.targets['build-prebuilt'].cache).toBe(false);
    expect(project.targets['build-prebuilt'].dependsOn).toEqual([
      { projects: ['scripts'], target: 'verify-renderer' },
      'verify',
    ]);
  });

  it('uses the exact header policy and a status-preserving 404 shell', () => {
    const config = readFileSync(
      join(workspaceRoot, 'container/sws.toml'),
      'utf8',
    ).replace(/^\s*#.*$/gm, '');
    for (const value of [
      'host = "0.0.0.0"',
      'port = 8080',
      'root = "/home/sws/public"',
      'page404 = "/home/sws/public/index.html"',
      'compression = true',
      'compression-static = false',
      'security-headers = false',
      'cache-control-headers = false',
      'directory-listing = false',
      'health = true',
      'Content-Security-Policy = "frame-ancestors \'none\'"',
      'X-Frame-Options = "DENY"',
      'X-Content-Type-Options = "nosniff"',
      'Referrer-Policy = "strict-origin-when-cross-origin"',
    ])
      expect(config).toContain(value);
    expect(config).not.toContain('page-fallback');
    expect(config).toContain('source = "/rooms/**/*.*"');
    expect(config).toContain(
      'source = "/*-' + '[A-Za-z0-9_-]'.repeat(8) + '.{js,css}"',
    );
  });
});
