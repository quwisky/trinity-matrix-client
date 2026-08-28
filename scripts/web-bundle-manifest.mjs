import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
          path: relative(root, absolute).replaceAll('\\', '/'),
          bytes: body.byteLength,
          sha256: createHash('sha256').update(body).digest('hex'),
        },
      ];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function validateRelativePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
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
  if (manifest?.version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported web bundle manifest');
  }
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

export function buildWebBundleManifest(root) {
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    throw new Error(`Web bundle directory does not exist: ${absoluteRoot}`);
  }
  const files = walk(absoluteRoot);
  if (files.length === 0) {
    throw new Error(`Web bundle directory is empty: ${absoluteRoot}`);
  }
  return {
    version: 1,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

export function writeWebBundleManifest(root, destination = DEFAULT_MANIFEST) {
  const manifest = buildWebBundleManifest(root);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function verifyWebBundleRoot(
  root,
  manifest,
  { allowedExtraPaths = [] } = {},
) {
  const absoluteRoot = resolve(root);
  validateManifest(manifest);
  const actual = buildWebBundleManifest(absoluteRoot);
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

function usage() {
  return [
    'Usage:',
    '  node scripts/web-bundle-manifest.mjs write <www-root> [manifest.json]',
    '  node scripts/web-bundle-manifest.mjs verify <manifest.json> <copied-root> [...]',
    '  node scripts/web-bundle-manifest.mjs verify-with-extras <manifest.json> <copied-root> <allowed-extra> [...]',
  ].join('\n');
}

async function main() {
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
    const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
    for (const root of roots) {
      verifyWebBundleRoot(root, manifest);
      console.log(`[web bundle] verified ${resolve(root)}`);
    }
    return;
  }
  if (command === 'verify-with-extras' && args.length >= 3) {
    const [manifestPath, root, ...allowedExtraPaths] = args;
    const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
    verifyWebBundleRoot(root, manifest, { allowedExtraPaths });
    console.log(
      `[web bundle] verified ${resolve(root)} with ${allowedExtraPaths.length} allowed platform files`,
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
