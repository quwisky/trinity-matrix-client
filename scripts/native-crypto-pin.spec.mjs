import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkNativeCryptoPin } from './native-crypto-pin.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const manifest = (
  wasm,
  crypto = '=0.19.1',
  common = crypto,
  sqlite = crypto,
) => `
[package.metadata.trinity.wasm-pin]
matrix-sdk-crypto-wasm = "${wasm}"
matrix-sdk-crypto = "0.19.1"

[dependencies]
matrix-sdk-common = { version = "${common}", features = ["x"] }
matrix-sdk-crypto = { version = "${crypto}", default-features = false, features = [
  "y",
] }
matrix-sdk-sqlite = { version = "${sqlite}", default-features = false }
`;
const lock = (version) => `
[[package]]
name = "matrix-sdk-crypto"
version = "${version}"
`;
const packageJson = (wasm) =>
  JSON.stringify({
    dependencies: { '@matrix-org/matrix-sdk-crypto-wasm': wasm },
  });
const check = ({
  wasm = '18.9.0',
  recorded = '18.9.0',
  crypto,
  common,
  sqlite,
  locked = '0.19.1',
} = {}) =>
  checkNativeCryptoPin({
    packageJson: packageJson(wasm),
    cargoToml: manifest(recorded, crypto, common, sqlite),
    cargoLock: lock(locked),
  });

describe('native crypto pin', () => {
  it('holds for the repository', () => {
    expect(
      checkNativeCryptoPin({
        packageJson: read('package.json'),
        cargoToml: read('native/crypto/Cargo.toml'),
        cargoLock: read('native/crypto/Cargo.lock'),
      }),
    ).toEqual([]);
  });

  it('accepts matching pins', () => {
    expect(check()).toEqual([]);
  });

  it('fails when the WASM package moves without the crate', () => {
    expect(check({ wasm: '18.10.0' })).toEqual([
      expect.stringContaining(
        'package.json has @matrix-org/matrix-sdk-crypto-wasm 18.10.0',
      ),
    ]);
  });

  it('fails when the crate moves without the WASM package', () => {
    expect(check({ crypto: '=0.20.0', locked: '0.20.0' })).toEqual([
      expect.stringContaining('matrix-sdk-crypto'),
      expect.stringContaining('matrix-sdk-common'),
      expect.stringContaining('matrix-sdk-sqlite'),
      expect.stringContaining('Cargo.lock'),
    ]);
  });

  it('fails when the matrix-sdk crates disagree or are not exact', () => {
    expect(check({ sqlite: '=0.19.2' })).toEqual([
      expect.stringContaining('matrix-sdk-sqlite'),
    ]);
    expect(
      check({ crypto: '0.19.1', common: '=0.19.1', sqlite: '=0.19.1' }),
    ).toEqual([expect.stringContaining('matrix-sdk-crypto')]);
  });

  it('fails when Cargo.lock resolves another matrix-sdk-crypto', () => {
    expect(check({ locked: '0.19.2' })).toEqual([
      expect.stringContaining('Cargo.lock'),
    ]);
  });
});
