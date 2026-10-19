import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Configuration } from 'electron-builder';
import { describe, expect, it } from 'vitest';
import { builderConfigFor, mergeConfig } from '../electron-builder.config';
import { CHANNEL_IDENTITY } from './release-channel';

const electronRoot = join(import.meta.dirname, '..');
const STABLE_VERSION = '0.5.0';
const NEXT_VERSION = '0.5.0-next.3';

/** electron-builder's own config loader (js-yaml for YAML, jiti for TypeScript). */
async function loadWithBuilder(file: string): Promise<unknown> {
  const fromBuilder = createRequire(
    createRequire(import.meta.url).resolve('electron-builder'),
  );
  const { getConfig } = fromBuilder('app-builder-lib/out/util/config/load') as {
    getConfig: (
      request: {
        readonly packageKey: string;
        readonly configFilename: string;
        readonly projectDir: string;
        readonly packageMetadata: null;
      },
      configPath: string,
    ) => Promise<{ readonly result: unknown }>;
  };
  const { result } = await getConfig(
    {
      packageKey: 'build',
      configFilename: 'electron-builder',
      projectDir: electronRoot,
      packageMetadata: null,
    },
    file,
  );
  return result;
}
const stable = (): Configuration => builderConfigFor(STABLE_VERSION).config;
const next = (): Configuration => builderConfigFor(NEXT_VERSION).config;

type Resource = { readonly from: string; readonly to: string };
const resources = (config: Configuration): Resource[] =>
  config.extraResources as Resource[];

/** electron-builder's expansion of the three macros the pinned file names use. */
const expand = (
  pattern: string | null | undefined,
  values: {
    readonly version: string;
    readonly arch: string;
    readonly ext: string;
  },
): string =>
  (pattern ?? '').replace(
    /\$\{(version|arch|ext)\}/g,
    (_match, key: 'version' | 'arch' | 'ext') => values[key],
  );

/** electron-builder's own schema check, reached through its app-builder-lib dependency. */
async function validate(config: Configuration): Promise<void> {
  const fromBuilder = createRequire(
    createRequire(import.meta.url).resolve('electron-builder'),
  );
  const { validateConfiguration } = fromBuilder(
    'app-builder-lib/out/util/config/config',
  ) as {
    validateConfiguration: (
      config: unknown,
      debug: { add: () => void; isEnabled: boolean },
    ) => Promise<void>;
  };
  await validateConfiguration(structuredClone(config), {
    add: () => undefined,
    isEnabled: false,
  });
}

describe('electron-builder config by release channel', () => {
  it('packages a plain X.Y.Z version from electron-builder.yml exactly as written', async () => {
    expect(builderConfigFor(STABLE_VERSION)).toEqual({
      channel: 'stable',
      config: await loadWithBuilder('electron-builder.yml'),
    });
  });

  it("is what electron-builder loads from --config for electron/package.json's version", async () => {
    const { version } = JSON.parse(
      readFileSync(join(electronRoot, 'package.json'), 'utf8'),
    ) as { readonly version: string };
    expect(await loadWithBuilder('electron-builder.config.ts')).toEqual(
      builderConfigFor(version).config,
    );
  });

  it('turns an X.Y.Z-next.N version into Trinity Next', () => {
    const config = next();
    expect(builderConfigFor(NEXT_VERSION).channel).toBe('next');
    expect(config.appId).toBe('dev.trinityproject.trinity.next');
    expect(config.productName).toBe('Trinity Next');
    expect(config.protocols).toEqual([
      {
        name: 'Trinity Next SSO Callback',
        schemes: ['dev.trinityproject.trinity.next'],
      },
    ]);
    expect(config.linux).toMatchObject({
      executableName: 'trinity-next',
      icon: 'build/next/icon.png',
    });
    expect(config.deb).toMatchObject({ packageName: 'trinity-next' });
    expect(config.mac?.icon).toBe('build/next/Trinity.icon');
    expect(config.win?.icon).toBe('build/next/icon.png');
  });

  it("names each app in macOS's camera prompt", () => {
    expect(stable().mac?.extendInfo).toEqual({
      NSCameraUsageDescription:
        'Trinity uses the camera to scan QR codes for device verification and linking new devices.',
    });
    expect(next().mac?.extendInfo).toEqual({
      NSCameraUsageDescription:
        'Trinity Next uses the camera to scan QR codes for device verification and linking new devices.',
    });
  });

  it("names Trinity Next's data folder, lock and keychain item through the packaged package.json", () => {
    // Electron reads productName from the packaged package.json, which the productName
    // option above does not rewrite. Stable keeps electron/package.json's "Trinity".
    expect(next().extraMetadata).toEqual({ productName: 'Trinity Next' });
    expect(stable().extraMetadata).toBeUndefined();
  });

  it('keeps every release file name', () => {
    const config = next();
    const version = NEXT_VERSION;
    expect(
      expand(config.dmg?.artifactName, { version, arch: 'arm64', ext: 'dmg' }),
    ).toBe(`Trinity-${version}-arm64.dmg`);
    expect(
      expand(config.mac?.artifactName, { version, arch: 'arm64', ext: 'zip' }),
    ).toBe(`Trinity-${version}-arm64-mac.zip`);
    expect(
      expand(config.nsis?.artifactName, { version, arch: 'x64', ext: 'exe' }),
    ).toBe(`Trinity Setup ${version}.exe`);
    expect(
      expand(config.appImage?.artifactName, {
        version,
        arch: 'x86_64',
        ext: 'AppImage',
      }),
    ).toBe(`Trinity-${version}.AppImage`);
    expect(
      expand(config.deb?.artifactName, { version, arch: 'amd64', ext: 'deb' }),
    ).toBe(`trinity-desktop_${version}_amd64.deb`);
  });

  it('ships the same runtime resources, with the badged window and notification icon', () => {
    const swapped = resources(next()).map(({ from, to }) =>
      to === 'build/notificationIcon.png'
        ? { from: 'build/notificationIcon.png', to }
        : { from, to },
    );
    expect(swapped).toEqual(resources(stable()));
    expect(
      resources(next()).find(({ to }) => to === 'build/notificationIcon.png')
        ?.from,
    ).toBe('build/next/notificationIcon.png');
  });

  it('keeps the base configuration for everything Trinity Next does not override', () => {
    const config = next();
    const base = stable();
    expect(config.asar).toBe(base.asar);
    expect(config.afterPack).toBe(base.afterPack);
    expect(config.files).toEqual(base.files);
    expect(config.directories).toEqual(base.directories);
    expect(config.mac).toMatchObject({
      hardenedRuntime: true,
      entitlements: base.mac?.entitlements,
      target: base.mac?.target,
    });
    expect(config.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
    });
  });

  it.each([STABLE_VERSION, NEXT_VERSION])(
    'agrees with the identity the main process uses for %s',
    (version) => {
      const { channel, config } = builderConfigFor(version);
      const identity = CHANNEL_IDENTITY[channel];
      expect(config.appId).toBe(identity.appId);
      expect(config.productName).toBe(identity.productName);
      const protocols = config.protocols as { readonly schemes: string[] }[];
      expect(protocols.flatMap((protocol) => protocol.schemes)).toEqual([
        identity.deepLinkScheme,
      ]);
    },
  );

  it.each([STABLE_VERSION, NEXT_VERSION])(
    'is a valid electron-builder configuration for %s',
    async (version) => {
      await validate(builderConfigFor(version).config);
    },
  );

  it.each(['0.5.0-beta.1', 'v0.5.0', '0.5.0-next'])(
    'refuses to package %s',
    (version) => {
      expect(() => builderConfigFor(version)).toThrow(
        /Unknown release channel/,
      );
    },
  );

  it('points at badged icons that are committed', () => {
    for (const file of [
      'build/next/icon.png',
      'build/next/notificationIcon.png',
      'build/next/Trinity.icon/icon.json',
    ]) {
      expect(existsSync(join(electronRoot, file)), file).toBe(true);
    }
  });
});

describe('mergeConfig', () => {
  it('merges objects key by key and replaces lists and values', () => {
    expect(
      mergeConfig(
        { a: { keep: 1, swap: 1 }, list: [1, 2], value: 'x' },
        { a: { swap: 2 }, list: [3], value: 'y' },
      ),
    ).toEqual({ a: { keep: 1, swap: 2 }, list: [3], value: 'y' });
  });

  it('leaves its inputs untouched', () => {
    const base = { a: { keep: 1 }, list: [1] };
    const overrides = { a: { add: 2 }, list: [2] };
    mergeConfig(base, overrides);
    expect(base).toEqual({ a: { keep: 1 }, list: [1] });
    expect(overrides).toEqual({ a: { add: 2 }, list: [2] });
  });
});

describe('packaging scripts', () => {
  const scripts = (
    JSON.parse(readFileSync(join(electronRoot, 'package.json'), 'utf8')) as {
      readonly scripts: Record<string, string>;
    }
  ).scripts;

  it('package every channel through electron-builder.config.ts', () => {
    const packaging = Object.entries(scripts).filter(([name]) =>
      name.startsWith('package'),
    );
    expect(packaging.map(([name]) => name).sort()).toEqual([
      'package',
      'package:all',
      'package:linux',
      'package:mac',
      'package:mac:signed',
      'package:win',
    ]);
    for (const [name, command] of packaging) {
      expect(command, name).toContain(
        'electron-builder --config electron-builder.config.ts',
      );
    }
  });

  it('signs whichever app the local macOS package produced', () => {
    expect(scripts['package:mac']).toContain('release/mac-arm64/*.app');
    expect(scripts['package:mac']).not.toContain('Trinity.app');
  });
});
