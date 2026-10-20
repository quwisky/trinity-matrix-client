/**
 * Rewrites the pnpm virtual-store paths that `cap sync` writes into the native projects so
 * they match pnpm-lock.yaml. Renovate runs this after `pnpm install --lockfile-only`, where
 * neither node_modules nor a web build exists, so `cap sync` cannot run and this script
 * must not import anything outside Node itself.
 *
 *   node scripts/sync-native-plugin-paths.mjs          rewrite the files in place
 *   node scripts/sync-native-plugin-paths.mjs --check  exit 1 and print what is stale
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const NATIVE_FILES = [
  'ios/App/CapApp-SPM/Package.swift',
  'android/capacitor.settings.gradle',
];

// pnpm's default virtualStoreDirMaxLength on Linux and macOS.
const MAX_LENGTH = 120;
const DEPENDENCY_GROUPS = new Set([
  'dependencies:',
  'devDependencies:',
  'optionalDependencies:',
]);
const STORE_PATH =
  /node_modules\/\.pnpm\/([^/'"]+)\/node_modules\/((?:@[^/'"]+\/)?[^/'"]+)/g;

/**
 * The root importer's resolved versions, e.g. `8.2.5(@capacitor/core@8.5.3)`, by package name.
 * A line scanner rather than a YAML parser so it runs without node_modules; the spec checks
 * it against the `yaml` package on the real lockfile. pnpm 12 prefixes the lockfile with a
 * second YAML document whose own `importers: .:` lists pnpm itself; only dependency groups count.
 */
export function rootImporterVersions(lockfile) {
  const versions = new Map();
  let path = [];
  let name = '';
  for (const line of lockfile.split('\n')) {
    // The `top|importer|dependency group` this line sits in.
    const depth = /^( {0}| {2}| {4})\S/.exec(line)?.[1].length;
    if (depth !== undefined) path = [...path.slice(0, depth / 2), line.trim()];
    if (
      path[0] !== 'importers:' ||
      path[1] !== '.:' ||
      !DEPENDENCY_GROUPS.has(path[2])
    )
      continue;
    const dependency = /^ {6}'?([^':]+)'?:$/.exec(line);
    if (dependency) name = dependency[1];
    const version = /^ {8}version: (\S+)$/.exec(line);
    if (version) versions.set(name, version[1]);
  }
  return versions;
}

/** pnpm's dependency-path `depPathToFilename`, for registry packages. */
export function virtualStoreName(name, version) {
  let filename = `${name}@${version}`.replace(/[\\/:*?"<>|#]/g, '+');
  if (filename.includes('(')) {
    filename = filename.replace(/\)$/, '').replace(/\)\(|\(|\)/g, '_');
  }
  if (filename.length > MAX_LENGTH || filename !== filename.toLowerCase()) {
    const hash = createHash('sha256').update(filename).digest('hex');
    return `${filename.slice(0, MAX_LENGTH - 33)}_${hash.slice(0, 32)}`;
  }
  return filename;
}

/** Returns the file with every virtual-store path resolved from `versions`. */
export function syncPaths(source, versions, file) {
  return source.replace(STORE_PATH, (match, _folder, name) => {
    const version = versions.get(name);
    if (!version) {
      throw new Error(
        `${file} references ${name}, which pnpm-lock.yaml does not list as a root dependency. Run \`pnpm exec cap sync\` after changing native plugins.`,
      );
    }
    return `node_modules/.pnpm/${virtualStoreName(name, version)}/node_modules/${name}`;
  });
}

/** Syncs every native file under `root`; returns the files whose paths were stale. */
export function syncNativePluginPaths(root, { check = false } = {}) {
  const versions = rootImporterVersions(
    readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'),
  );
  // Resolve both files before writing either, so a missing package leaves neither half-done.
  const stale = NATIVE_FILES.flatMap((file) => {
    const before = readFileSync(join(root, file), 'utf8');
    const after = syncPaths(before, versions, file);
    if (after === before) return [];
    const old = before.split('\n');
    const diff = after
      .split('\n')
      .flatMap((line, i) =>
        line === old[i] ? [] : [`-${old[i]}`, `+${line}`],
      );
    return [{ file, after, diff }];
  });
  if (!check) {
    for (const { file, after } of stale) writeFileSync(join(root, file), after);
  }
  return stale.map(({ file, diff }) => ({ file, diff }));
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  try {
    const stale = syncNativePluginPaths(join(import.meta.dirname, '..'), {
      check,
    });
    for (const { file, diff } of stale) {
      console.log(
        `${check ? 'Stale' : 'Updated'}: ${file}\n${diff.join('\n')}`,
      );
    }
    if (check && stale.length > 0) {
      console.error(
        'Native plugin paths disagree with pnpm-lock.yaml. Run `node scripts/sync-native-plugin-paths.mjs`.',
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
