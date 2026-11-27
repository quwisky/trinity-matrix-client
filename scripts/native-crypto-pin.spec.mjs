import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkNativeCryptoPin,
  snapshotWasmLock,
} from './native-crypto-pin.mjs';

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
const lock = (version, extra = '') => `
[[package]]
name = "matrix-sdk-crypto"
version = "${version}"

[[package]]
name = "vodozemac"
version = "0.11.0"
${extra}`;
const wasmLock = (wasm = '18.9.0') =>
  JSON.stringify({
    'matrix-sdk-crypto-wasm': wasm,
    packages: ['matrix-sdk-crypto@0.19.1', 'vodozemac@0.11.0', 'zeroize@1.9.0'],
  });
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
  extra,
  snapshot = wasmLock(),
} = {}) =>
  checkNativeCryptoPin({
    packageJson: packageJson(wasm),
    cargoToml: manifest(recorded, crypto, common, sqlite),
    cargoLock: lock(locked, extra),
    wasmLock: snapshot,
  });

describe('native crypto pin', () => {
  it('holds for the repository', () => {
    expect(
      checkNativeCryptoPin({
        packageJson: read('package.json'),
        cargoToml: read('native/crypto/Cargo.toml'),
        cargoLock: read('native/crypto/Cargo.lock'),
        wasmLock: read('native/crypto/wasm-lock.json'),
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
      expect.stringContaining('Cargo.lock resolves matrix-sdk-crypto'),
      expect.stringContaining('matrix-sdk-crypto 0.20.0'),
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
      expect.stringContaining('Cargo.lock resolves matrix-sdk-crypto'),
      expect.stringContaining('matrix-sdk-crypto 0.19.2'),
    ]);
  });

  it('fails when a crate both locks share has another version than in WASM', () => {
    const zeroize = '\n[[package]]\nname = "zeroize"\nversion = "1.9.1"\n';
    expect(check({ extra: zeroize })).toEqual([
      'native/crypto/Cargo.lock has zeroize 1.9.1, the WASM 18.9.0 lock has 1.9.0',
    ]);
    const onlyOurs = '\n[[package]]\nname = "rusqlite"\nversion = "0.40.2"\n';
    expect(check({ extra: onlyOurs })).toEqual([]);
  });

  it('fails when the WASM lock snapshot is for another release', () => {
    expect(check({ snapshot: wasmLock('18.8.0') })).toEqual([
      expect.stringContaining('wasm-lock.json is for 18.8.0'),
    ]);
  });

  it('snapshots every package of a WASM Cargo.lock', () => {
    expect(
      JSON.parse(snapshotWasmLock(lock('0.19.1', ''), '18.9.0', 'abc')),
    ).toEqual({
      'matrix-sdk-crypto-wasm': '18.9.0',
      commit: 'abc',
      packages: ['matrix-sdk-crypto@0.19.1', 'vodozemac@0.11.0'],
    });
  });
});
