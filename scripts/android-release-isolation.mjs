/**
 * Fails when an Android release package (APK or AAB) holds a debug-only native crypto
 * artefact: the native/crypto library or a class of the TrinityCryptoDebug plugin, which
 * live only in android/app/src/debug.
 *
 * Usage: node scripts/android-release-isolation.mjs <app-release.aab|apk> ...
 */
import { execFileSync } from 'node:child_process';

const NATIVE_LIBRARY = /(^|\/)libtrinity_crypto\.so$/;
// Dex files keep class names and annotation strings as plain text.
const DEBUG_MARKERS = [
  'dev/trinityproject/trinity/cryptodebug/',
  'TrinityCryptoDebug',
];
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

function unzip(args, encoding) {
  return execFileSync('unzip', args, { encoding, maxBuffer: MAX_ENTRY_BYTES });
}

/** The debug crypto artefacts in the package; throws when it holds no dex file at all. */
export function debugCryptoArtefacts(packagePath) {
  const entries = unzip(['-Z1', packagePath], 'utf8')
    .split('\n')
    .filter(Boolean);
  const dexFiles = entries.filter((entry) => entry.endsWith('.dex'));
  if (dexFiles.length === 0)
    throw new Error(`${packagePath} holds no dex file; is it an APK or AAB?`);
  const found = entries.filter((entry) => NATIVE_LIBRARY.test(entry));
  for (const entry of dexFiles) {
    const dex = unzip(['-p', packagePath, entry]);
    for (const marker of DEBUG_MARKERS)
      if (dex.includes(marker)) found.push(`${entry} contains ${marker}`);
  }
  return found;
}

if (import.meta.main) {
  const packages = process.argv.slice(2);
  if (packages.length === 0)
    throw new Error(
      'Usage: node scripts/android-release-isolation.mjs <app-release.aab|apk> ...',
    );
  let failed = false;
  for (const path of packages) {
    const found = debugCryptoArtefacts(path);
    if (found.length > 0) {
      failed = true;
      console.error(
        `${path} holds debug-only crypto artefacts:\n  ${found.join('\n  ')}`,
      );
    } else {
      console.log(`${path}: no debug-only crypto artefacts.`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}
