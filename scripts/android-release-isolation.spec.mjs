import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cryptoPackageProblems,
  nativeCryptoFromEnv,
} from './android-release-isolation.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A zip holding `files` ({ entry: content }). */
function pack(files) {
  const root = mkdtempSync(join(tmpdir(), 'trinity-release-isolation-'));
  roots.push(root);
  const tree = join(root, 'tree');
  for (const [entry, content] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, entry)), { recursive: true });
    writeFileSync(join(tree, entry), content);
  }
  const zip = join(root, 'app.zip');
  execFileSync('zip', ['-X', '-r', '-q', zip, '.'], { cwd: tree });
  return zip;
}

const MAIN_DEX = 'dex\n035\0Ldev/trinityproject/trinity/MainActivity;\0';
const PLUGIN_DEX =
  'dex\n035\0Ldev/trinityproject/trinity/crypto/TrinityCryptoPlugin;\0';
const on = { nativeCrypto: true };
const off = { nativeCrypto: false };
const androidx = (prefix, abis) =>
  Object.fromEntries(
    abis.map((abi) => [
      `${prefix}lib/${abi}/libdatastore_shared_counter.so`,
      'elf',
    ]),
  );
const crate = (prefix, abis) =>
  Object.fromEntries(
    abis.map((abi) => [`${prefix}lib/${abi}/libtrinity_crypto.so`, 'elf']),
  );
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];

describe('android release isolation', () => {
  it('accepts native crypto for every ABI with its plugin, in an APK or an AAB', () => {
    expect(
      cryptoPackageProblems(
        pack({
          'classes.dex': PLUGIN_DEX,
          ...androidx('', ABIS),
          ...crate('', ABIS),
        }),
        on,
      ),
    ).toEqual([]);
    expect(
      cryptoPackageProblems(
        pack({
          'base/dex/classes.dex': MAIN_DEX,
          'base/dex/classes2.dex': PLUGIN_DEX,
          ...androidx('base/', ABIS),
          ...crate('base/', ABIS),
        }),
        on,
      ),
    ).toEqual([]);
  });

  it('refuses a native build missing the library for an ABI, or the plugin', () => {
    expect(
      cryptoPackageProblems(
        pack({
          'base/dex/classes.dex': MAIN_DEX,
          ...androidx('base/', ABIS),
          ...crate('base/', ['x86_64']),
        }),
        on,
      ),
    ).toEqual([
      'no libtrinity_crypto.so for arm64-v8a',
      'no libtrinity_crypto.so for armeabi-v7a',
      'no libtrinity_crypto.so for x86',
      'no TrinityCrypto plugin in any dex file',
    ]);
    expect(
      cryptoPackageProblems(pack({ 'classes.dex': PLUGIN_DEX }), on),
    ).toEqual(['no native libraries at all']);
  });

  it('refuses the library in a build without native crypto', () => {
    expect(
      cryptoPackageProblems(
        pack({ 'classes.dex': PLUGIN_DEX, ...androidx('', ABIS) }),
        off,
      ),
    ).toEqual([]);
    expect(
      cryptoPackageProblems(
        pack({ 'classes.dex': MAIN_DEX, ...crate('', ['x86_64']) }),
        off,
      ),
    ).toEqual([
      'libtrinity_crypto.so for x86_64 in a build without native crypto',
    ]);
  });

  it('finds debug-only plugin classes in any dex file, in both modes', () => {
    const files = {
      'base/dex/classes.dex': PLUGIN_DEX,
      'base/dex/classes2.dex':
        'dex\n035\0Ldev/trinityproject/trinity/cryptodebug/TrinityCryptoDebugPlugin;\0',
      ...androidx('base/', ABIS),
    };
    const debug = [
      'base/dex/classes2.dex contains dev/trinityproject/trinity/cryptodebug/',
      'base/dex/classes2.dex contains TrinityCryptoDebug',
    ];
    expect(cryptoPackageProblems(pack(files), off)).toEqual(debug);
    expect(
      cryptoPackageProblems(pack({ ...files, ...crate('base/', ABIS) }), on),
    ).toEqual(debug);
  });

  it('refuses a file that holds no dex file', () => {
    expect(() =>
      cryptoPackageProblems(pack({ 'README.md': 'hi' }), on),
    ).toThrow(/no dex file/);
  });

  it('reads the mode as the Gradle build does', () => {
    expect(nativeCryptoFromEnv({})).toBe(true);
    expect(nativeCryptoFromEnv({ TRINITY_NATIVE_CRYPTO: '1' })).toBe(true);
    expect(nativeCryptoFromEnv({ TRINITY_NATIVE_CRYPTO: '0' })).toBe(false);
    expect(nativeCryptoFromEnv({ TRINITY_NATIVE_CRYPTO: 'false' })).toBe(false);
  });
});
