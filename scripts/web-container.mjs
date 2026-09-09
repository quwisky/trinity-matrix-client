import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  currentCommit,
  readWebBundleManifest,
  sha256,
  verifyWebBundleRoot,
} from './web-bundle-manifest.mjs';

const workspaceRoot = resolve(import.meta.dirname, '..');
const manifestRelativePath = 'dist/web-bundle-manifest.json';
const imageRecordPath = join(workspaceRoot, 'dist/web-container-image.json');
const hostFiles = ['Dockerfile', 'sws.toml', '.dockerignore'];
export const SWS_IMAGE =
  'ghcr.io/static-web-server/static-web-server:2.44.0-alpine@sha256:c6704bc8f1fe05378d91c3288495ce2e0131cf31cf8956f117cb1c7d83c49c31';

function run(command, args) {
  execFileSync(command, args, { cwd: workspaceRoot, stdio: 'inherit' });
}

/** License and build policy belong to this host, not to a release publisher. */
export function verifyContainerPolicy(root = workspaceRoot) {
  for (const path of [
    'LICENSE',
    ...hostFiles.map((file) => 'container/' + file),
  ]) {
    if (!lstatSync(join(root, path)).isFile()) {
      throw new Error('Container input must be a regular file: ' + path);
    }
  }
  const license = readFileSync(join(root, 'LICENSE'), 'utf8');
  for (const path of ['package.json', 'electron/package.json']) {
    if (JSON.parse(readFileSync(join(root, path), 'utf8')).license !== 'MIT') {
      throw new Error(path + ' must preserve the agreed MIT license');
    }
  }
  if (!license.startsWith('MIT License\n'))
    throw new Error('LICENSE must declare MIT');
  const dockerfile = readFileSync(join(root, 'container/Dockerfile'), 'utf8');
  const instructions = dockerfile
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  if (!instructions.startsWith('FROM ' + SWS_IMAGE + '\n'))
    throw new Error('SWS base must use the accepted immutable index digest');
  if (!instructions.includes('org.opencontainers.image.licenses="MIT"'))
    throw new Error('OCI license must agree with MIT package metadata');
  if (
    /^\s*(?:RUN|ADD|VOLUME|ARG)\b/m.test(instructions) ||
    /(?:node_modules|\b(?:pnpm|npm|yarn)\b)/.test(instructions)
  ) {
    throw new Error(
      'Container must only copy verified host inputs without build tools or runtime mounts',
    );
  }
  return sha256(
    Buffer.concat([
      Buffer.from(license),
      ...hostFiles.map((file) => readFileSync(join(root, 'container', file))),
    ]),
  );
}

export function verifyContainerInputs(
  root = workspaceRoot,
  expectedSha = currentCommit(),
) {
  const hostSha256 = verifyContainerPolicy(root);
  const manifestPath = join(root, manifestRelativePath);
  const manifest = readWebBundleManifest(manifestPath);
  verifyWebBundleRoot(join(root, 'www'), manifest, { expectedSha });
  // The manifest verifier also serves other hosts, so enforce PWA-specific files here.
  for (const path of [
    'index.html',
    'ngsw.json',
    'ngsw-worker.js',
    'manifest.webmanifest',
    '3rdpartylicenses.txt',
    'assets/crypto/matrix_sdk_crypto_wasm_bg.wasm',
  ]) {
    if (!manifest.files.some((file) => file.path === path))
      throw new Error('Production container payload is missing ' + path);
  }
  return {
    manifest,
    manifestSha256: sha256(readFileSync(manifestPath)),
    hostSha256,
  };
}

function normalizeModes(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const child of readdirSync(path)) normalizeModes(join(path, child));
  } else if (stat.isFile()) {
    chmodSync(path, 0o644);
  } else {
    throw new Error('Unsupported container context entry: ' + path);
  }
}

/** Only this staged context reaches Docker; no source checkout or credentials. */
export function stageContainerContext(
  root,
  destination,
  expectedSha = currentCommit(),
) {
  const identity = verifyContainerInputs(root, expectedSha);
  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length !== 0)
    throw new Error('Container staging directory must be empty');
  for (const file of hostFiles)
    copyFileSync(join(root, 'container', file), join(destination, file));
  copyFileSync(join(root, 'LICENSE'), join(destination, 'LICENSE'));
  cpSync(join(root, 'www'), join(destination, 'www'), { recursive: true });
  normalizeModes(destination);
  verifyWebBundleRoot(join(destination, 'www'), identity.manifest, {
    expectedSha,
  });
  return identity;
}

export function verifyImageRecord(record, identity) {
  if (
    record.version !== 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(record.imageId ?? '') ||
    record.commitSha !== identity.manifest.commitSha ||
    record.manifestSha256 !== identity.manifestSha256 ||
    record.hostSha256 !== identity.hostSha256
  ) {
    throw new Error(
      'Container image record does not match the current verified renderer and host inputs',
    );
  }
  return record.imageId;
}

function build() {
  mkdirSync(join(workspaceRoot, 'dist'), { recursive: true });
  const temporary = mkdtempSync(
    join(workspaceRoot, 'dist/web-container-build-'),
  );
  try {
    const context = join(temporary, 'context');
    const identity = stageContainerContext(workspaceRoot, context);
    const iidFile = join(temporary, 'image-id');
    const image =
      process.env.TRINITY_WEB_CONTAINER_IMAGE ??
      'trinity-web-container:sha-' + identity.manifest.commitSha;
    run('docker', [
      'build',
      '--platform=linux/amd64',
      '--iidfile',
      iidFile,
      '--tag',
      image,
      context,
    ]);
    const after = verifyContainerInputs();
    if (
      after.manifestSha256 !== identity.manifestSha256 ||
      after.hostSha256 !== identity.hostSha256
    )
      throw new Error('Container inputs changed during the image build');
    const record = {
      version: 1,
      image,
      imageId: readFileSync(iidFile, 'utf8').trim(),
      commitSha: identity.manifest.commitSha,
      manifestSha256: identity.manifestSha256,
      hostSha256: identity.hostSha256,
    };
    verifyImageRecord(record, identity);
    writeFileSync(imageRecordPath, JSON.stringify(record, null, 2) + '\n');
    console.log(
      '[web container] built ' +
        record.imageId +
        ' from manifest ' +
        identity.manifestSha256,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv[2] === 'verify') {
    verifyContainerPolicy();
    console.log(
      '[web container] pinned host configuration and MIT license agreement verified',
    );
  } else if (process.argv[2] === 'build-prebuilt') {
    build();
  } else if (process.argv[2] === 'smoke') {
    const imageId = verifyImageRecord(
      JSON.parse(readFileSync(imageRecordPath, 'utf8')),
      verifyContainerInputs(),
    );
    run(process.execPath, ['container/smoke.mjs', '--image', imageId]);
  } else {
    throw new Error(
      'Usage: node scripts/web-container.mjs <verify|build-prebuilt|smoke>',
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
