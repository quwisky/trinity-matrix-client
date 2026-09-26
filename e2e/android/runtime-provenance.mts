import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { AccountViewportProfile } from './account-workspace-client.mts';
import type { MaestroDevice } from './maestro-session.mts';

interface AndroidRuntimeProvenanceOptions {
  readonly device: Pick<MaestroDevice, 'adb' | 'install'>;
  readonly applicationId: NonNullable<Parameters<MaestroDevice['install']>[1]>;
  readonly apk: string;
  readonly rendererManifest: string;
  readonly profile: AccountViewportProfile;
  readonly output: string;
}

/** Install and retain identity only when the installed APK matches the pre-install bytes. */
export async function installWithAndroidRuntimeProvenance(
  options: AndroidRuntimeProvenanceOptions,
): Promise<void> {
  // A failed attempt must not leave a prior success receipt available for upload.
  await rm(options.output, { force: true });
  assert(
    /^eu\.qwky\.trinity(?:\.secondary)?$/u.test(options.applicationId),
    'Android provenance requires a Trinity application',
  );
  const apk = await readFile(options.apk);
  assert(apk.byteLength > 0, 'Android APK is empty');
  const fileDigest = createHash('sha256').update(apk).digest('hex');
  const manifestBytes = await readFile(options.rendererManifest);
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  assert(
    manifest && typeof manifest === 'object' &&
      'version' in manifest && manifest.version === 2 &&
      'configuration' in manifest && manifest.configuration === 'production' &&
      'commitSha' in manifest && typeof manifest.commitSha === 'string' &&
      /^[a-f0-9]{40}$/u.test(manifest.commitSha),
    'Production renderer provenance is required',
  );

  await options.device.install(options.apk, options.applicationId);
  const packagePath = await options.device.adb(
    'shell', 'pm', 'path', options.applicationId,
  );
  const pathMatch = /^package:(\/data\/app\/[A-Za-z0-9_~+/=.-]+\.apk)$/u.exec(
    packagePath.trim(),
  );
  assert(pathMatch, 'Installed Android APK path is missing or ambiguous');
  const installedPath = pathMatch[1]!;
  const checksum = await options.device.adb('shell', 'sha256sum', installedPath);
  const digestMatch = /^([a-f0-9]{64})\s+(\S+)$/u.exec(checksum.trim());
  assert(
    digestMatch && digestMatch[2] === installedPath,
    'Installed Android APK digest is missing or malformed',
  );
  const installedDigest = digestMatch[1]!;
  assert.equal(installedDigest, fileDigest, 'Installed Android APK differs from the built file');

  const sdk = (await options.device.adb('shell', 'getprop', 'ro.build.version.sdk')).trim();
  assert(/^[1-9][0-9]{0,2}$/u.test(sdk), 'Android API level is invalid');
  const model = (await options.device.adb('shell', 'getprop', 'ro.product.model')).trim();
  assert(/^[A-Za-z0-9_. ()-]{1,120}$/u.test(model), 'Android model is invalid');
  const receipt = {
    schemaVersion: 1,
    applicationId: options.applicationId,
    apk: { fileDigest, installedDigest, byteLength: apk.byteLength },
    renderer: {
      manifestDigest: createHash('sha256').update(manifestBytes).digest('hex'),
      commitSha: manifest.commitSha,
      configuration: manifest.configuration,
    },
    profile: {
      requested: options.profile,
      digest: createHash('sha256').update(JSON.stringify(options.profile)).digest('hex'),
    },
    device: { apiLevel: Number(sdk), model },
  };
  await writeFile(options.output, `${JSON.stringify(receipt, null, 2)}\n`);
}
