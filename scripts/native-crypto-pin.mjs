#!/usr/bin/env node
// The native crypto crate must run the matrix-sdk-crypto release the WASM package is built
// on. native/crypto/Cargo.toml records that pairing under [package.metadata.trinity.wasm-pin]
// (read off the WASM release's own Cargo.lock); this fails when either side moves alone.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WASM = '@matrix-org/matrix-sdk-crypto-wasm';
const SDK_CRATES = [
  'matrix-sdk-crypto',
  'matrix-sdk-common',
  'matrix-sdk-sqlite',
];

const tomlString = (text, key) =>
  text.match(new RegExp(`^${key} = "([^"]+)"$`, 'm'))?.[1];

export const checkNativeCryptoPin = ({ packageJson, cargoToml, cargoLock }) => {
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
  const errors = [];
  const wasm = JSON.parse(packageJson).dependencies?.[WASM];
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
  return errors;
};

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  const errors = checkNativeCryptoPin({
    packageJson: read('package.json'),
    cargoToml: read('native/crypto/Cargo.toml'),
    cargoLock: read('native/crypto/Cargo.lock'),
  });
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exit(1);
  console.log('native/crypto matches the WASM package.');
}
