/**
 * Fails a release APK unless its only signer is the pinned release certificate
 * (release.yml `sign-android`). The digest lives in android/release-signing-cert.sha256.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// "Signer #1 certificate …", "V2 Signer: certificate …", "Signer (minSdkVersion=24, …) certificate …".
const DIGEST =
  /^((?!Source Stamp)[^\n]*\bSigner\b[^\n]*?):? certificate SHA-256 digest: ([0-9a-fA-F]+)$/gm;
const SIGNERS = /^Number of signers: (\d+)$/m;

const signerLines = (apksignerOutput) =>
  [...apksignerOutput.matchAll(DIGEST)].map(([, label, hex]) => ({
    label,
    digest: hex.toLowerCase(),
  }));

/** Lowercase hex SHA-256 of each signer certificate line in `apksigner --print-certs` output. */
export function signerDigests(apksignerOutput) {
  return signerLines(apksignerOutput).map(({ digest }) => digest);
}

export function checkSigner(apksignerOutput, pinned) {
  const expected = pinned.trim().toLowerCase().replaceAll(':', '');
  if (expected === 'unset') {
    throw new Error(
      'set the release certificate digest in android/release-signing-cert.sha256',
    );
  }
  const lines = signerLines(apksignerOutput);
  const count = SIGNERS.exec(apksignerOutput)?.[1];
  // v2 and v3 print the same key once each; a second signer shows as a count or "#2".
  const distinct = [...new Set(lines.map(({ digest }) => digest))];
  if (
    distinct.length !== 1 ||
    (count !== undefined && count !== '1') ||
    lines.some(({ label }) => /#(?!1\b)\d+/.test(label))
  ) {
    throw new Error(
      `expected exactly one signer, found ${distinct.length} distinct${count === undefined ? '' : ` (apksigner reports ${count})`}: ${distinct.join(', ')}`,
    );
  }
  if (distinct[0] !== expected) {
    throw new Error(
      `APK signed by ${distinct[0]}, not the release certificate ${expected}`,
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
