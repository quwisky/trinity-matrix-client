import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const modulePath = resolve(
  import.meta.dirname,
  '../e2e/android/runtime-provenance.mts',
);
const directories = [];
const apkDigest =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const installedPath = '/data/app/~~fixture/eu.qwky.trinity-fixture/base.apk';
const profile = {
  width: 393,
  height: 727,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2.75,
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(overrides = {}) {
  const directory = await mkdtemp(
    join(tmpdir(), 'trinity-runtime-provenance-'),
  );
  directories.push(directory);
  const apk = join(directory, 'app-debug.apk');
  const rendererManifest = join(directory, 'renderer.json');
  const output = join(directory, 'runtime-provenance.json');
  await writeFile(apk, 'abc');
  await writeFile(
    rendererManifest,
    JSON.stringify({
      version: 2,
      commitSha: 'a'.repeat(40),
      configuration: 'production',
      files: [],
    }),
  );
  const replies = {
    'shell pm path eu.qwky.trinity': `package:${installedPath}`,
    [`shell sha256sum ${installedPath}`]: `${apkDigest}  ${installedPath}`,
    'shell getprop ro.build.version.sdk': '36',
    'shell getprop ro.product.model': 'sdk_gphone64_x86_64',
    ...overrides,
  };
  const calls = [];
  const device = {
    async install(file, applicationId) {
      calls.push(['install', file, applicationId]);
    },
    async adb(...args) {
      calls.push(['adb', ...args]);
      const key = args.join(' ');
      if (!(key in replies))
        throw new Error(`Unexpected Android command: ${key}`);
      return replies[key];
    },
  };
  return {
    directory,
    apk,
    rendererManifest,
    output,
    device,
    calls,
    applicationId: 'eu.qwky.trinity',
    profile,
  };
}

async function record(options) {
  expect(existsSync(modulePath), 'runtime provenance helper exists').toBe(true);
  const { installWithAndroidRuntimeProvenance } = await import(modulePath);
  return installWithAndroidRuntimeProvenance(options);
}

describe('installed Android runtime provenance', () => {
  it('retains fingerprints of the actual installed APK, renderer and requested profile', async () => {
    const options = await fixture();
    await record(options);
    const report = JSON.parse(await readFile(options.output, 'utf8'));
    expect(report).toEqual({
      schemaVersion: 1,
      applicationId: 'eu.qwky.trinity',
      apk: { fileDigest: apkDigest, installedDigest: apkDigest, byteLength: 3 },
      renderer: {
        manifestDigest: createHash('sha256')
          .update(await readFile(options.rendererManifest))
          .digest('hex'),
        commitSha: 'a'.repeat(40),
        configuration: 'production',
      },
      profile: {
        requested: profile,
        digest: createHash('sha256')
          .update(JSON.stringify(profile))
          .digest('hex'),
      },
      device: { apiLevel: 36, model: 'sdk_gphone64_x86_64' },
    });
    const retained = await readFile(options.output, 'utf8');
    expect(retained).not.toContain(options.directory);
    expect(retained).not.toContain(installedPath);
    expect(options.calls[0]).toEqual([
      'install',
      options.apk,
      options.applicationId,
    ]);
  });

  it('invalidates an earlier receipt before a failed attempt', async () => {
    const options = await fixture();
    await record(options);
    const failed = await fixture({ 'shell pm path eu.qwky.trinity': '' });
    await expect(record({ ...failed, output: options.output })).rejects.toThrow(
      'Installed Android APK path',
    );
    expect(existsSync(options.output)).toBe(false);
  });

  it('compares the installed binary with bytes captured before installation', async () => {
    const changedDigest = createHash('sha256').update('changed').digest('hex');
    const options = await fixture({
      [`shell sha256sum ${installedPath}`]: `${changedDigest}  ${installedPath}`,
    });
    options.device.install = async () => {
      await writeFile(options.apk, 'changed');
    };
    await expect(record(options)).rejects.toThrow(
      'Installed Android APK differs',
    );
    expect(await readFile(options.apk, 'utf8')).toBe('changed');
    expect(existsSync(options.output)).toBe(false);
  });

  it('does not retain success evidence when installation fails', async () => {
    const options = await fixture();
    await record(options);
    options.device.install = async () => {
      expect(existsSync(options.output)).toBe(false);
      throw new Error('APK install failed');
    };
    await expect(record(options)).rejects.toThrow('APK install failed');
    expect(existsSync(options.output)).toBe(false);
  });

  it('does not publish a receipt for a different installed binary', async () => {
    const options = await fixture({
      [`shell sha256sum ${installedPath}`]: `${'b'.repeat(64)}  ${installedPath}`,
    });
    await expect(record(options)).rejects.toThrow(
      'Installed Android APK differs',
    );
    expect(existsSync(options.output)).toBe(false);
  });

  it.each([
    ['missing package', ''],
    [
      'split APKs',
      `package:${installedPath}\npackage:/data/app/fixture/split.apk`,
    ],
    ['unexpected file location', 'package:/sdcard/app.apk'],
    ['shell metacharacters', 'package:/data/app/fixture/base.apk;private'],
  ])(
    'fails closed on %s instead of guessing the installed binary',
    async (_name, response) => {
      const options = await fixture({
        'shell pm path eu.qwky.trinity': response,
      });
      await expect(record(options)).rejects.toThrow(
        'Installed Android APK path',
      );
      expect(existsSync(options.output)).toBe(false);
    },
  );

  it.each([
    ['missing digest', ''],
    ['malformed digest', `not-a-digest  ${installedPath}`],
    ['wrong file', `${apkDigest}  /data/app/other/base.apk`],
  ])(
    'does not accept %s as installed-file evidence',
    async (_name, response) => {
      const options = await fixture({
        [`shell sha256sum ${installedPath}`]: response,
      });
      await expect(record(options)).rejects.toThrow(
        'Installed Android APK digest',
      );
      expect(existsSync(options.output)).toBe(false);
    },
  );

  it('rejects an empty APK before recording any success', async () => {
    const options = await fixture();
    await writeFile(options.apk, '');
    await expect(record(options)).rejects.toThrow('Android APK is empty');
    expect(existsSync(options.output)).toBe(false);
  });

  it('rejects non-production renderer provenance', async () => {
    const options = await fixture();
    await writeFile(
      options.rendererManifest,
      JSON.stringify({
        version: 2,
        commitSha: 'a'.repeat(40),
        configuration: 'development',
        files: [],
      }),
    );
    await expect(record(options)).rejects.toThrow(
      'Production renderer provenance',
    );
    expect(existsSync(options.output)).toBe(false);
  });

  it('rejects malformed device metadata without retaining it', async () => {
    const options = await fixture({
      'shell getprop ro.build.version.sdk': 'private-invalid',
    });
    await expect(record(options)).rejects.toThrow('Android API level');
    expect(existsSync(options.output)).toBe(false);
  });

  it('changes the profile fingerprint when the requested viewport changes', async () => {
    const options = await fixture();
    await record(options);
    const before = JSON.parse(await readFile(options.output, 'utf8'));
    await record({ ...options, profile: { ...profile, width: 400 } });
    const after = JSON.parse(await readFile(options.output, 'utf8'));
    expect(after.profile.requested.width).toBe(400);
    expect(after.profile.digest).not.toBe(before.profile.digest);
  });
});
