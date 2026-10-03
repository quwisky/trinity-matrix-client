/**
 * Pack the verified production renderer for a GitHub release:
 * Trinity-Web-<version>.zip → trinity-web/{www/, LICENSE, web-bundle-manifest.json}.
 * container.yml restores www/ and the manifest from this exact zip.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-next\.(0|[1-9]\d*))?$/;

export function webZipName(version) {
  if (!VERSION.test(version))
    throw new Error(`Not a release version: ${version}`);
  return `Trinity-Web-${version}.zip`;
}

export function packWebRelease({ root, version, outDir }) {
  const name = webZipName(version);
  const inputs = {
    www: join(root, 'www'),
    LICENSE: join(root, 'LICENSE'),
    'web-bundle-manifest.json': join(root, 'dist/web-bundle-manifest.json'),
  };
  for (const [entry, path] of Object.entries(inputs)) {
    if (!existsSync(path)) throw new Error(`Missing ${entry} at ${path}`);
  }
  if (!existsSync(join(inputs.www, 'index.html')))
    throw new Error('www/index.html is missing; build the renderer first');
  const staging = mkdtempSync(join(tmpdir(), 'trinity-web-release-'));
  try {
    const folder = join(staging, 'trinity-web');
    mkdirSync(folder);
    cpSync(inputs.www, join(folder, 'www'), { recursive: true });
    copyFileSync(inputs.LICENSE, join(folder, 'LICENSE'));
    copyFileSync(
      inputs['web-bundle-manifest.json'],
      join(folder, 'web-bundle-manifest.json'),
    );
    mkdirSync(resolve(outDir), { recursive: true });
    const zip = resolve(outDir, name);
    rmSync(zip, { force: true });
    // -X: no extra file attributes; -r: recurse; -q: quiet.
    execFileSync('zip', ['-X', '-r', '-q', zip, 'trinity-web'], {
      cwd: staging,
    });
    return zip;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: { version: { type: 'string' }, out: { type: 'string' } },
  });
  if (!values.version || !values.out)
    throw new Error(
      'Usage: node scripts/web-release-zip.mjs --version <X.Y.Z> --out <dir>',
    );
  console.log(
    packWebRelease({
      root: resolve(import.meta.dirname, '..'),
      version: values.version,
      outDir: values.out,
    }),
  );
}
