import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

// iOS cannot be built in CI's unit jobs, so the patch text is the only pin: without it a
// locked keychain reads as "no key" and the app replaces the device and its crypto store.
describe('secure-storage plugin patch', () => {
  const registered =
    /^ {2}'@aparajita\/capacitor-secure-storage@[^']+': (\S+)$/m.exec(
      readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    );

  it('is registered with pnpm', () => {
    expect(registered).not.toBeNull();
  });

  it('rejects an iOS read the keychain refused instead of resolving null', () => {
    const added = readFileSync(join(root, registered[1]), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('+'))
      .join('\n');
    expect(added).toContain('func getData(withKey key: String) throws -> Any');
    expect(added).toContain('let data = try getData(withKey: key)');
    expect(added).toMatch(
      /data == nil && keychain\.lastResultCode != 0 && keychain\.lastResultCode != errSecItemNotFound[^}]+throw KeychainError\(\.osError, status: keychain\.lastResultCode\)/,
    );
  });
});
