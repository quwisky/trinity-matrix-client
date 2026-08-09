import { FuseV1Options } from '@electron/fuses';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const afterPack = createRequire(import.meta.url)('../afterPack.cjs') as ((
  ctx: unknown,
) => Promise<void>) & {
  fuseOptions: (electronPlatformName: string) => Record<string, unknown>;
};

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
// per-platform binary path is derived correctly, a missing binary fails loudly rather
// than silently shipping an un-hardened build, and the option set handed to flipFuses
// is the hardened one.
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

  it('disables the code-injection fuses and pins the app to the asar', () => {
    const options = afterPack.fuseOptions('darwin');
    expect(options[FuseV1Options.RunAsNode]).toBe(false);
    expect(options[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(
      false,
    );
    expect(options[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    expect(options[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
  });

  it('validates the embedded asar header only where one is emitted', () => {
    for (const platform of ['darwin', 'win32']) {
      expect(
        afterPack.fuseOptions(platform)[
          FuseV1Options.EnableEmbeddedAsarIntegrityValidation
        ],
      ).toBe(true);
    }
    // Linux packages carry no integrity header, so asking for validation there
    // would only stop the app from starting.
    expect(
      afterPack.fuseOptions('linux')[
        FuseV1Options.EnableEmbeddedAsarIntegrityValidation
      ],
    ).toBeUndefined();
  });

  it('resets the ad-hoc darwin signature only on macOS', () => {
    expect(afterPack.fuseOptions('darwin').resetAdHocDarwinSignature).toBe(
      true,
    );
    expect(afterPack.fuseOptions('win32').resetAdHocDarwinSignature).toBe(
      false,
    );
  });
});
