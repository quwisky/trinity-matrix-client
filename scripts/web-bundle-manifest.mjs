import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const currentCommit = () =>
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  }).trim();
export const sha256 = (body) => createHash('sha256').update(body).digest('hex');
export const DEFAULT_MANIFEST = join(
  workspaceRoot,
  'dist/web-bundle-manifest.json',
);

function walk(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) return walk(root, absolute);
      if (!entry.isFile()) {
        throw new Error(
          `Unsupported filesystem entry in web payload: ${relative(root, absolute)}`,
        );
      }
      const body = readFileSync(absolute);
      return [
        {
          path: validateRelativePath(
            relative(root, absolute).split(sep).join('/'),
            'Payload file',
          ),
          bytes: body.byteLength,
          sha256: sha256(body),
        },
      ];
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function validateRelativePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f:]/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === '..' ||
    value.startsWith('../')
  ) {
    throw new Error(`${label} is not a safe bundle-relative path: ${value}`);
  }
  return value;
}

function validateManifest(manifest) {
  if (
    manifest?.version !== 2 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error('Unsupported web bundle manifest');
  }
  validateIdentity(manifest);
  const seen = new Set();
  let totalBytes = 0;
  for (const [index, file] of manifest.files.entries()) {
    const path = validateRelativePath(file?.path, `Manifest file ${index}`);
    if (seen.has(path)) throw new Error(`Duplicate manifest file: ${path}`);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`Invalid byte count for manifest file: ${path}`);
    }
    if (
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error(`Invalid SHA-256 for manifest file: ${path}`);
    }
    seen.add(path);
    totalBytes += file.bytes;
  }
  if (manifest.totalBytes !== totalBytes) {
    throw new Error('Manifest totalBytes does not match its file entries');
  }
}

function validateIdentity({ commitSha, configuration }) {
  if (
    !/^[a-f0-9]{40}$/.test(commitSha ?? '') ||
    configuration !== 'production'
  ) {
    throw new Error(
      'Web bundle requires a full commit SHA and production configuration',
    );
  }
}

export function buildWebBundleManifest(
  root,
  identity = { commitSha: currentCommit(), configuration: 'production' },
) {
  validateIdentity(identity);
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot) || !lstatSync(absoluteRoot).isDirectory()) {
    throw new Error(`Web bundle directory does not exist: ${absoluteRoot}`);
  }
  const files = walk(absoluteRoot);
  if (files.length === 0) {
    throw new Error(`Web bundle directory is empty: ${absoluteRoot}`);
  }
  return {
    version: 2,
    commitSha: identity.commitSha,
    configuration: identity.configuration,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

export function writeWebBundleManifest(
  root,
  destination = DEFAULT_MANIFEST,
  identity,
) {
  const manifest = buildWebBundleManifest(root, identity);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function verifyWebBundleRoot(
  root,
  manifest,
  {
    allowedExtraPaths = [],
    expectedSha = currentCommit(),
    expectedConfiguration = 'production',
  } = {},
) {
  const absoluteRoot = resolve(root);
  validateManifest(manifest);
  if (
    manifest.commitSha !== expectedSha ||
    manifest.configuration !== expectedConfiguration
  ) {
    throw new Error(
      'Web bundle identity does not match the expected commit/configuration',
    );
  }
  const actual = buildWebBundleManifest(absoluteRoot, manifest);
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));
  const expectedPaths = new Set(manifest.files.map((file) => file.path));
  const allowedExtras = new Set(
    allowedExtraPaths.map((path, index) =>
      validateRelativePath(path, `Allowed extra ${index}`),
    ),
  );
  const failures = [];
  for (const expected of manifest.files) {
    const observed = actualByPath.get(expected.path);
    if (!observed) {
      failures.push(`${expected.path}: missing`);
      continue;
    }
    if (
      observed.bytes !== expected.bytes ||
      observed.sha256 !== expected.sha256
    ) {
      failures.push(`${expected.path}: content differs`);
    }
  }
  for (const observed of actual.files) {
    if (
      !expectedPaths.has(observed.path) &&
      !allowedExtras.has(observed.path)
    ) {
      failures.push(`${observed.path}: unexpected`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Web payload at ${absoluteRoot} does not match the production manifest:\n${failures.join('\n')}`,
    );
  }
}

export function readWebBundleManifest(path, expectedDigest) {
  const body = readFileSync(path);
  if (
    expectedDigest !== undefined &&
    (!/^[a-f0-9]{64}$/.test(expectedDigest) || sha256(body) !== expectedDigest)
  ) {
    throw new Error('Web bundle manifest digest does not match');
  }
  const manifest = JSON.parse(body.toString('utf8'));
  validateManifest(manifest);
  return manifest;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/web-bundle-manifest.mjs write <www-root> [manifest.json]',
    '  node scripts/web-bundle-manifest.mjs verify <manifest.json> <copied-root> [...]',
    '  node scripts/web-bundle-manifest.mjs verify-with-extras <manifest.json> <copied-root> <allowed-extra> [...]',
  ].join('\n');
}

async function main() {
  const expectedSha = process.env.TRINITY_RENDERER_SHA ?? currentCommit();
  if (expectedSha !== currentCommit())
    throw new Error('Renderer SHA differs from checked-out commit');
  const [command, ...args] = process.argv.slice(2);
  if (command === 'write' && args.length >= 1 && args.length <= 2) {
    const destination = args[1] ? resolve(args[1]) : DEFAULT_MANIFEST;
    const manifest = writeWebBundleManifest(resolve(args[0]), destination);
    console.log(
      `[web bundle] recorded ${manifest.files.length} files (${manifest.totalBytes} bytes) in ${destination}`,
    );
    return;
  }
  if (command === 'verify' && args.length >= 2) {
    const [manifestPath, ...roots] = args;
    const manifest = readWebBundleManifest(
      resolve(manifestPath),
      process.env.TRINITY_RENDERER_MANIFEST_DIGEST,
    );
    for (const root of roots) {
      verifyWebBundleRoot(root, manifest, { expectedSha });
      console.log(
        `[web bundle] verified ${resolve(root)}: ${manifest.commitSha} ${sha256(readFileSync(resolve(manifestPath)))}`,
      );
    }
    return;
  }
  if (command === 'verify-with-extras' && args.length >= 3) {
    const [manifestPath, root, ...allowedExtraPaths] = args;
    const manifest = readWebBundleManifest(
      resolve(manifestPath),
      process.env.TRINITY_RENDERER_MANIFEST_DIGEST,
    );
    verifyWebBundleRoot(root, manifest, { allowedExtraPaths, expectedSha });
    console.log(
      `[web bundle] verified ${resolve(root)}: ${manifest.commitSha} ${sha256(readFileSync(resolve(manifestPath)))} with ${allowedExtraPaths.length} allowed platform files`,
    );
    return;
  }
  throw new Error(usage());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
