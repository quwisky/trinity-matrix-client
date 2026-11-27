import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { debugCryptoArtefacts } from './android-release-isolation.mjs';

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

describe('android release isolation', () => {
  it('accepts a package without the debug crypto artefacts', () => {
    const apk = pack({
      'classes.dex': MAIN_DEX,
      'lib/x86_64/libsqlite.so': 'elf',
    });
    expect(debugCryptoArtefacts(apk)).toEqual([]);
  });

  it('finds the crate library in an APK or an AAB', () => {
    expect(
      debugCryptoArtefacts(
        pack({
          'classes.dex': MAIN_DEX,
          'lib/x86_64/libtrinity_crypto.so': 'elf',
        }),
      ),
    ).toEqual(['lib/x86_64/libtrinity_crypto.so']);
    expect(
      debugCryptoArtefacts(
        pack({
          'base/dex/classes.dex': MAIN_DEX,
          'base/lib/arm64-v8a/libtrinity_crypto.so': 'elf',
        }),
      ),
    ).toEqual(['base/lib/arm64-v8a/libtrinity_crypto.so']);
  });

  it('finds the plugin classes in any dex file', () => {
    const aab = pack({
      'base/dex/classes.dex': MAIN_DEX,
      'base/dex/classes2.dex':
        'dex\n035\0Ldev/trinityproject/trinity/cryptodebug/TrinityCryptoDebugPlugin;\0',
    });
    expect(debugCryptoArtefacts(aab)).toEqual([
      'base/dex/classes2.dex contains dev/trinityproject/trinity/cryptodebug/',
      'base/dex/classes2.dex contains TrinityCryptoDebug',
    ]);
  });

  it('refuses a file that holds no dex file', () => {
    expect(() => debugCryptoArtefacts(pack({ 'README.md': 'hi' }))).toThrow(
      /no dex file/,
    );
  });
});
