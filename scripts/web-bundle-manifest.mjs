import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
      if (!entry.isFile()) return [];
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

export function verifyWebBundleRoot(root, manifest) {
  const absoluteRoot = resolve(root);
  const failures = [];
  for (const expected of manifest.files) {
    const absolute = join(absoluteRoot, expected.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      failures.push(`${expected.path}: missing`);
      continue;
    }
    const body = readFileSync(absolute);
    const digest = createHash('sha256').update(body).digest('hex');
    if (body.byteLength !== expected.bytes || digest !== expected.sha256) {
      failures.push(`${expected.path}: content differs`);
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
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) {
      throw new Error(`Unsupported web bundle manifest: ${manifestPath}`);
    }
    for (const root of roots) {
      verifyWebBundleRoot(root, manifest);
      console.log(`[web bundle] verified ${resolve(root)}`);
    }
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
