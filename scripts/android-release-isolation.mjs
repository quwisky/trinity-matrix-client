/**
 * Checks the native crypto contents of an Android release package (APK or AAB). Always: no
 * debug-only crypto code (the retired TrinityCryptoDebug plugin). With native crypto on (the
 * default): `libtrinity_crypto.so` for every ABI the package ships native code for, and the
 * TrinityCrypto plugin. With it off (`--native-crypto=off`, or TRINITY_NATIVE_CRYPTO=0 or
 * false as for the Gradle build): no `libtrinity_crypto.so` at all.
 *
 * Usage: node scripts/android-release-isolation.mjs [--native-crypto=on|off] <app-release.aab|apk> ...
 */
import { execFileSync } from 'node:child_process';

const NATIVE_LIBRARY = 'libtrinity_crypto.so';
const LIBRARY = /^(?:base\/)?lib\/([^/]+)\/([^/]+\.so)$/;
// Dex files keep class names and annotation strings as plain text.
const DEBUG_MARKERS = [
  'dev/trinityproject/trinity/cryptodebug/',
  'TrinityCryptoDebug',
];
const PLUGIN_MARKER = 'Ldev/trinityproject/trinity/crypto/TrinityCryptoPlugin;';
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

function unzip(args, encoding) {
  return execFileSync('unzip', args, { encoding, maxBuffer: MAX_ENTRY_BYTES });
}

/** Whether a build with this environment packages native crypto (the Gradle default: yes). */
export function nativeCryptoFromEnv(env = process.env) {
  return !['0', 'false'].includes(env['TRINITY_NATIVE_CRYPTO'] ?? '');
}

/** What is wrong with the package's crypto contents; throws when it holds no dex file at all. */
export function cryptoPackageProblems(packagePath, { nativeCrypto }) {
  const entries = unzip(['-Z1', packagePath], 'utf8')
    .split('\n')
    .filter(Boolean);
  const dexFiles = entries.filter((entry) => entry.endsWith('.dex'));
  if (dexFiles.length === 0)
    throw new Error(`${packagePath} holds no dex file; is it an APK or AAB?`);
  const problems = [];
  const libraries = new Map();
  for (const entry of entries) {
    const match = LIBRARY.exec(entry);
    if (!match) continue;
    const [, abi, library] = match;
    libraries.set(abi, [...(libraries.get(abi) ?? []), library]);
  }
  let plugin = false;
  for (const entry of dexFiles) {
    const dex = unzip(['-p', packagePath, entry]);
    for (const marker of DEBUG_MARKERS)
      if (dex.includes(marker)) problems.push(`${entry} contains ${marker}`);
    plugin ||= dex.includes(PLUGIN_MARKER);
  }
  if (nativeCrypto) {
    if (libraries.size === 0) problems.push('no native libraries at all');
    for (const [abi, names] of [...libraries].sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      if (!names.includes(NATIVE_LIBRARY))
        problems.push(`no ${NATIVE_LIBRARY} for ${abi}`);
    if (!plugin) problems.push('no TrinityCrypto plugin in any dex file');
  } else {
    for (const [abi, names] of libraries)
      if (names.includes(NATIVE_LIBRARY))
        problems.push(
          `${NATIVE_LIBRARY} for ${abi} in a build without native crypto`,
        );
  }
  return problems;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = args.find((arg) => arg.startsWith('--native-crypto='));
  const packages = args.filter((arg) => arg !== flag);
  if (
    packages.length === 0 ||
    (flag && !/^--native-crypto=(on|off)$/.test(flag))
  )
    throw new Error(
      'Usage: node scripts/android-release-isolation.mjs [--native-crypto=on|off] <app-release.aab|apk> ...',
    );
  const nativeCrypto = flag ? flag.endsWith('=on') : nativeCryptoFromEnv();
  let failed = false;
  for (const path of packages) {
    const problems = cryptoPackageProblems(path, { nativeCrypto });
    if (problems.length > 0) {
      failed = true;
      console.error(
        `${path} (native crypto ${nativeCrypto ? 'on' : 'off'}):\n  ${problems.join('\n  ')}`,
      );
    } else {
      console.log(
        `${path}: native crypto ${nativeCrypto ? 'packaged for every ABI' : 'absent'}, no debug-only crypto code.`,
      );
    }
  }
  process.exitCode = failed ? 1 : 0;
}
