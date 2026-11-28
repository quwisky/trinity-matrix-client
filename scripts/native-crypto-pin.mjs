#!/usr/bin/env node
// The native crypto crate must run the matrix-sdk-crypto release the WASM package is built
// on. native/crypto/Cargo.toml records that pairing under [package.metadata.trinity.wasm-pin]
// (read off the WASM release's own Cargo.lock); this fails when either side moves alone, and
// when a crate in both lock files has another version here than in native/crypto/wasm-lock.json,
// the snapshot of that WASM lock.
//
// The WASM package name resolves to the facade libs/native/crypto-backend (a pnpm override),
// which installs the real package under an `npm:` alias. The override also replaces
// matrix-js-sdk's exact WASM pin without a warning, so the alias, the root package.json and
// the installed matrix-js-sdk's pin must all name the same version.
//
// On a WASM bump, refresh the snapshot from the release tag's lock file:
//   curl -fsSLO https://raw.githubusercontent.com/matrix-org/matrix-sdk-crypto-wasm/v<version>/Cargo.lock
//   node scripts/native-crypto-pin.mjs snapshot Cargo.lock <version> <tag commit>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WASM = '@matrix-org/matrix-sdk-crypto-wasm';
const FACADE = 'libs/native/crypto-backend/package.json';
const SDK_CRATES = [
  'matrix-sdk-crypto',
  'matrix-sdk-common',
  'matrix-sdk-sqlite',
];

const lockPackages = (cargoLock) =>
  [...cargoLock.matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"$/gm)].map(
    ([, name, version]) => `${name}@${version}`,
  );

/** The fixture native/crypto/wasm-lock.json, from the WASM release's Cargo.lock. */
export const snapshotWasmLock = (cargoLock, wasm, commit) =>
  `${JSON.stringify(
    {
      'matrix-sdk-crypto-wasm': wasm,
      commit,
      packages: [...new Set(lockPackages(cargoLock))].sort(),
    },
    null,
    2,
  )}\n`;

const sharedVersionErrors = (cargoLock, snapshot) => {
  const theirs = new Map();
  for (const entry of snapshot.packages) {
    const at = entry.lastIndexOf('@');
    const name = entry.slice(0, at);
    theirs.set(name, [...(theirs.get(name) ?? []), entry.slice(at + 1)]);
  }
  return lockPackages(cargoLock)
    .filter((entry) => !snapshot.packages.includes(entry))
    .map((entry) => entry.split('@'))
    .filter(([name]) => theirs.has(name))
    .map(
      ([name, version]) =>
        `native/crypto/Cargo.lock has ${name} ${version}, the WASM ${snapshot['matrix-sdk-crypto-wasm']} lock has ${theirs.get(name).join(', ')}`,
    );
};

const tomlString = (text, key) =>
  text.match(new RegExp(`^${key} = "([^"]+)"$`, 'm'))?.[1];

const facadeErrors = (wasm, facadePackageJson, jsSdkPackageJson) => {
  const aliases = Object.values(
    JSON.parse(facadePackageJson).dependencies ?? {},
  ).filter((spec) => spec.startsWith(`npm:${WASM}@`));
  const alias = aliases[0]?.slice(`npm:${WASM}@`.length);
  const sdk = JSON.parse(jsSdkPackageJson).dependencies?.[WASM];
  const errors = [];
  if (aliases.length !== 1) {
    errors.push(
      `${FACADE} must depend on ${WASM} through exactly one npm: alias; found ${aliases.length}`,
    );
  } else if (alias !== wasm) {
    errors.push(
      `${FACADE} re-exports ${WASM} ${alias}, but package.json has ${wasm}: move them together`,
    );
  }
  if (sdk !== wasm) {
    errors.push(
      `the installed matrix-js-sdk pins ${WASM} ${sdk}, but package.json has ${wasm}; the pnpm override would run the SDK on the facade's version without a warning: move package.json, ${FACADE} and native/crypto to the SDK's pin`,
    );
  }
  return errors;
};

export const checkNativeCryptoPin = ({
  packageJson,
  facadePackageJson,
  jsSdkPackageJson,
  cargoToml,
  cargoLock,
  wasmLock,
}) => {
  const pin =
    cargoToml
      .split(/^\[package\.metadata\.trinity\.wasm-pin\]$/m)[1]
      ?.split(/^\[/m)[0] ?? '';
  const recordedWasm = tomlString(pin, 'matrix-sdk-crypto-wasm');
  const recordedCrypto = tomlString(pin, 'matrix-sdk-crypto');
  if (!recordedWasm || !recordedCrypto) {
    return [
      'native/crypto/Cargo.toml has no [package.metadata.trinity.wasm-pin] pairing',
    ];
  }
  const wasm = JSON.parse(packageJson).dependencies?.[WASM];
  const errors = facadeErrors(wasm, facadePackageJson, jsSdkPackageJson);
  if (wasm !== recordedWasm) {
    errors.push(
      `package.json has ${WASM} ${wasm}, but native/crypto is pinned for ${recordedWasm}: read the matrix-sdk-crypto version off that release's Cargo.lock and move the crate pins and wasm-pin with it`,
    );
  }
  for (const crate of SDK_CRATES) {
    const version = cargoToml.match(
      new RegExp(`^${crate} = \\{ version = "([^"]+)"`, 'm'),
    )?.[1];
    if (version !== `=${recordedCrypto}`) {
      errors.push(
        `native/crypto/Cargo.toml has ${crate} ${version}, expected =${recordedCrypto}`,
      );
    }
  }
  const locked = cargoLock.match(
    /^name = "matrix-sdk-crypto"\nversion = "([^"]+)"$/m,
  )?.[1];
  if (locked !== recordedCrypto) {
    errors.push(
      `native/crypto/Cargo.lock resolves matrix-sdk-crypto ${locked}, expected ${recordedCrypto}`,
    );
  }
  const snapshot = JSON.parse(wasmLock);
  if (snapshot['matrix-sdk-crypto-wasm'] !== recordedWasm) {
    errors.push(
      `native/crypto/wasm-lock.json is for ${snapshot['matrix-sdk-crypto-wasm']}, the pins for ${recordedWasm}: refresh it (see scripts/native-crypto-pin.mjs)`,
    );
    return errors;
  }
  return [...errors, ...sharedVersionErrors(cargoLock, snapshot)];
};

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  const [command, lockPath, wasm, commit] = process.argv.slice(2);
  if (command === 'snapshot') {
    if (!lockPath || !wasm || !commit) {
      console.error(
        'usage: native-crypto-pin.mjs snapshot <Cargo.lock> <version> <commit>',
      );
      process.exit(2);
    }
    writeFileSync(
      resolve(root, 'native/crypto/wasm-lock.json'),
      snapshotWasmLock(readFileSync(lockPath, 'utf8'), wasm, commit),
    );
  } else {
    const errors = checkNativeCryptoPin({
      packageJson: read('package.json'),
      facadePackageJson: read(FACADE),
      jsSdkPackageJson: read('node_modules/matrix-js-sdk/package.json'),
      cargoToml: read('native/crypto/Cargo.toml'),
      cargoLock: read('native/crypto/Cargo.lock'),
      wasmLock: read('native/crypto/wasm-lock.json'),
    });
    for (const error of errors) console.error(error);
    if (errors.length > 0) process.exit(1);
    console.log(
      'native/crypto, the crypto-backend facade and matrix-js-sdk match the WASM package.',
    );
  }
}
