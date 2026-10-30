import { initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';
import { Observable, defer, from, map, shareReplay } from 'rxjs';

/**
 * Preloads the Rust crypto WASM from a served asset path.
 *
 * matrix-js-sdk's default loader resolves the `.wasm` relative to its bundled JS, which
 * Angular's esbuild does not emit as an asset, so it 404s. The build ships the file to
 * `assets/crypto/...` and we call `initAsync(url)` ourselves; the loader memoizes its module
 * promise, so `initRustCrypto()` later reuses this instance.
 *
 * Must run before `MatrixClient.initRustCrypto()`. Safe to call repeatedly: `shareReplay(1)`
 * runs `initAsync` once.
 */
let preloaded$: Observable<void> | null = null;

export function preloadCryptoWasm(): Observable<void> {
  return (preloaded$ ??= defer(() => {
    const url = new URL(
      'assets/crypto/matrix_sdk_crypto_wasm_bg.wasm',
      document.baseURI,
    );
    return from(initAsync(url));
  }).pipe(
    map(() => void 0),
    shareReplay(1),
  ));
}
