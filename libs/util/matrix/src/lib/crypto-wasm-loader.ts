import { initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';
import { Observable, defer, from, map, shareReplay } from 'rxjs';

/**
 * Preloads the Rust crypto WASM from a served asset path.
 *
 * matrix-js-sdk's default loader resolves the `.wasm` relative to its bundled JS
 * (`./pkg/...wasm`), which Angular's esbuild does not emit as an asset — so it 404s.
 * We instead ship the file via the build target's assets (apps/trinity/project.json)
 * to `assets/crypto/...` and call
 * `initAsync(url)` ourselves. The loader memoizes its module promise, so the call
 * matrix-js-sdk makes later inside `initRustCrypto()` reuses this instance.
 *
 * Must run before `MatrixClient.initRustCrypto()`. Safe to call multiple times —
 * `shareReplay(1)` runs `initAsync` once and replays to later subscribers.
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
