/** Capacitor's native projects point into pnpm's virtual store; keep them in step with the lockfile. */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import {
  NATIVE_FILES,
  rootImporterVersions,
  syncNativePluginPaths,
  virtualStoreName,
} from './sync-native-plugin-paths.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const LOCKFILE = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
const CAMERA = rootImporterVersions(LOCKFILE).get('@capacitor/camera');
const IOS = rootImporterVersions(LOCKFILE).get('@capacitor/ios');
const read = (file, root = ROOT) => readFileSync(join(root, file), 'utf8');

/** A copy of the lockfile and the native files, with the lockfile passed through `edit`. */
function fixture(edit) {
  const root = mkdtempSync(join(tmpdir(), 'native-paths-'));
  for (const file of NATIVE_FILES) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  writeFileSync(join(root, 'pnpm-lock.yaml'), edit(LOCKFILE));
  return root;
}

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe('native plugin paths', () => {
  it('match pnpm-lock.yaml in the committed native projects', () => {
    expect(syncNativePluginPaths(ROOT, { check: true })).toEqual([]);
    // The Swift package pin is checked too, not skipped because its line moved.
    expect(read(NATIVE_FILES[0])).toContain(
      `capacitor-swift-pm.git", exact: "${IOS.replace(/\(.*$/, '')}"`,
    );
  });

  it('read the same root versions as a YAML parser', () => {
    const lock = parseAllDocuments(LOCKFILE).at(-1).toJS();
    const root = lock.importers['.'];
    const expected = Object.entries({
      ...root.optionalDependencies,
      ...root.devDependencies,
      ...root.dependencies,
    }).map(([name, { version }]) => [name, version]);
    expect([...rootImporterVersions(LOCKFILE)].sort()).toEqual(expected.sort());
  });

  it('derive pnpm virtual-store names, including hashed long names', () => {
    expect(
      virtualStoreName('@capacitor/camera', '8.2.6(@capacitor/core@8.5.3)'),
    ).toBe('@capacitor+camera@8.2.6_@capacitor+core@8.5.3');
    // Copied from a pnpm 12.11.2 node_modules/.pnpm: names over 120 characters are cut and hashed.
    expect(
      virtualStoreName(
        '@capacitor/privacy-screen',
        '2.0.1(patch_hash=f2f986331ec9f771718d52fed87b9d5ae7fa7f85c90fdf4667eee575a3d84b37)(@capacitor/core@8.5.3)',
      ),
    ).toBe(
      '@capacitor+privacy-screen@2.0.1_patch_hash=f2f986331ec9f771718d52fed87b9d5ae7fa7f85c90f_7544954b349ac498fbd72912022954fd',
    );
  });

  it('rewrite every path to a bumped camera version', () => {
    expect(CAMERA).toMatch(/^\d+\.\d+\.\d+\(@capacitor\/core@/);
    const core = /\(@capacitor\/core@([^)]+)\)$/.exec(CAMERA)[1];
    const bumped = `9.9.9(@capacitor/core@${core})`;
    const root = fixture((lock) =>
      lock.replaceAll(`version: ${CAMERA}`, `version: ${bumped}`),
    );
    roots.push(root);

    expect(syncNativePluginPaths(root).map(({ file }) => file)).toEqual(
      NATIVE_FILES,
    );
    const folder = `@capacitor+camera@9.9.9_@capacitor+core@${core}`;
    expect(readFileSync(join(root, NATIVE_FILES[0]), 'utf8')).toContain(
      `"../../../node_modules/.pnpm/${folder}/node_modules/@capacitor/camera"`,
    );
    expect(readFileSync(join(root, NATIVE_FILES[1]), 'utf8')).toContain(
      `'../node_modules/.pnpm/${folder}/node_modules/@capacitor/camera/android'`,
    );
    // Only the camera paths moved, and a second run has nothing left to do.
    for (const file of NATIVE_FILES) {
      const before = readFileSync(join(ROOT, file), 'utf8').split('\n');
      const after = readFileSync(join(root, file), 'utf8').split('\n');
      const changed = after.filter((line, i) => line !== before[i]);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toContain('@capacitor/camera');
    }
    expect(syncNativePluginPaths(root, { check: true })).toEqual([]);
  });

  it('pin capacitor-swift-pm to a bumped @capacitor/ios version', () => {
    const bumped = IOS.replace(/^[^(]+/, '9.9.9');
    const root = fixture((lock) =>
      lock.replace(
        /^( {6}'@capacitor\/ios':\n {8}specifier: .*\n {8}version: ).*$/m,
        `$1${bumped}`,
      ),
    );
    roots.push(root);

    expect(syncNativePluginPaths(root).map(({ file }) => file)).toEqual([
      NATIVE_FILES[0],
    ]);
    const before = read(NATIVE_FILES[0]).split('\n');
    const changed = read(NATIVE_FILES[0], root)
      .split('\n')
      .filter((line, i) => line !== before[i]);
    expect(changed).toEqual([
      '        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "9.9.9"),',
    ]);
    expect(syncNativePluginPaths(root, { check: true })).toEqual([]);
  });

  it('fail without writing when a referenced package is missing from the lockfile', () => {
    const root = fixture((lock) =>
      lock.replace(/^ {6}'@capacitor\/camera':\n(?: {8}.*\n)+/m, ''),
    );
    roots.push(root);

    expect(() => syncNativePluginPaths(root)).toThrow(/@capacitor\/camera/);
    for (const file of NATIVE_FILES) {
      expect(readFileSync(join(root, file), 'utf8')).toBe(
        readFileSync(join(ROOT, file), 'utf8'),
      );
    }
  });
});
