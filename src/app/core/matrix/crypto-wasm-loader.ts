import { initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';

/**
 * Preloads the Rust crypto WASM from a served asset path.
 *
 * matrix-js-sdk's default loader resolves the `.wasm` relative to its bundled JS
 * (`./pkg/...wasm`), which Angular's esbuild does not emit as an asset — so it 404s.
 * We instead ship the file via angular.json assets to `assets/crypto/...` and call
 * `initAsync(url)` ourselves. The loader memoizes its module promise, so the call
 * matrix-js-sdk makes later inside `initRustCrypto()` reuses this instance.
 *
 * Must run before `MatrixClient.initRustCrypto()`. Safe to call multiple times.
 */
let preloaded: Promise<void> | null = null;

export function preloadCryptoWasm(): Promise<void> {
  if (!preloaded) {
    const url = new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI);
    preloaded = initAsync(url);
  }
  return preloaded;
}
