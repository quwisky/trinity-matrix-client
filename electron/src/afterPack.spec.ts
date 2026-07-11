import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const afterPack = createRequire(import.meta.url)('../afterPack.cjs') as (
  ctx: unknown,
) => Promise<void>;

function ctx(electronPlatformName: string) {
  return {
    electronPlatformName,
    appOutDir: '/out',
    packager: {
      appInfo: { productFilename: 'Trinity' },
      executableName: 'trinity',
    },
  };
}

// The fuse-flip itself needs a real packaged Electron binary (only exists during a
// `package` run), so these verify the module loads (@electron/fuses resolves), the
// per-platform binary path is derived correctly, and a missing binary fails loudly
// rather than silently shipping an un-hardened build.
describe('afterPack fuse hardening', () => {
  it('fails loudly when the packaged binary is missing', async () => {
    await expect(afterPack(ctx('linux'))).rejects.toThrow(/could not find/i);
  });

  it('targets the macOS app-bundle binary', async () => {
    await expect(afterPack(ctx('darwin'))).rejects.toThrow(
      /Trinity\.app\/Contents\/MacOS\/Trinity/,
    );
  });

  it('targets the linux executable by its executableName', async () => {
    await expect(afterPack(ctx('linux'))).rejects.toThrow(/\/out\/trinity/);
  });
});
