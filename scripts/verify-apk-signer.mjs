/**
 * Fails a release APK unless its only signer is the pinned release certificate
 * (release.yml `sign-android`). The digest lives in android/release-signing-cert.sha256.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIGEST = /^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]+)$/gm;

/** Lowercase hex SHA-256 of each signer certificate in `apksigner --print-certs` output. */
export function signerDigests(apksignerOutput) {
  return [...apksignerOutput.matchAll(DIGEST)].map(([, hex]) =>
    hex.toLowerCase(),
  );
}

export function checkSigner(apksignerOutput, pinned) {
  const expected = pinned.trim().toLowerCase().replaceAll(':', '');
  if (expected === 'unset') {
    throw new Error(
      'set the release certificate digest in android/release-signing-cert.sha256',
    );
  }
  const digests = signerDigests(apksignerOutput);
  if (digests.length !== 1) {
    throw new Error(
      `expected exactly one signer, found ${digests.length}: ${digests.join(', ')}`,
    );
  }
  if (digests[0] !== expected) {
    throw new Error(
      `APK signed by ${digests[0]}, not the release certificate ${expected}`,
    );
  }
}

if (import.meta.main) {
  const [apk] = process.argv.slice(2);
  if (!apk) throw new Error('usage: node scripts/verify-apk-signer.mjs <apk>');
  const result = spawnSync(
    'apksigner',
    ['verify', '--verbose', '--print-certs', apk],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `apksigner verify failed for ${apk}:\n${result.stdout ?? ''}${result.stderr ?? result.error ?? ''}`,
    );
  }
  checkSigner(
    result.stdout,
    readFileSync(
      fileURLToPath(
        new URL('../android/release-signing-cert.sha256', import.meta.url),
      ),
      'utf8',
    ),
  );
  console.log(`${apk} is signed by the release certificate.`);
}
