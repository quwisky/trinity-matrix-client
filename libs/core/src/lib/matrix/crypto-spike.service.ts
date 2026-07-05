import { Injectable } from '@angular/core';
import { createClient } from 'matrix-js-sdk';
import { Observable, catchError, defer, from, map, of, switchMap } from 'rxjs';
import { preloadCryptoWasm } from '@trinity/util-matrix';

export interface CryptoSpikeResult {
  ok: boolean;
  cryptoVersion?: string;
  deviceEd25519?: string | null;
  hasIndexedDB: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Gating smoke test for the E2EE-in-MVP decision: proves that
 * `@matrix-org/matrix-sdk-crypto-wasm` loads and the Rust crypto store
 * initializes inside the current runtime (browser, WKWebView, Android
 * WebView, or Electron renderer).
 *
 * It creates a throwaway, unauthenticated client — initRustCrypto() does not
 * touch the network — so it is safe to run anywhere with no real account.
 * Kept in core so the same spike can be triggered from a device build.
 */
@Injectable({ providedIn: 'root' })
export class CryptoSpikeService {
  run(): Observable<CryptoSpikeResult> {
    return defer(() => {
      const start = performance.now();
      const hasIndexedDB = typeof indexedDB !== 'undefined';

      const client = createClient({
        baseUrl: 'https://matrix.org',
        // Dummy identity: enough for crypto store init, no login performed.
        userId: '@spike:example.org',
        deviceId: 'SPIKE_DEVICE',
        accessToken: 'spike-no-network',
      });

      // Preload the WASM from the served asset path (see crypto-wasm-loader),
      // then the gating call that opens the crypto store.
      return preloadCryptoWasm().pipe(
        switchMap(() => from(client.initRustCrypto())),
        switchMap(() => {
          const crypto = client.getCrypto();
          if (!crypto) {
            throw new Error(
              'getCrypto() returned undefined after initRustCrypto()',
            );
          }
          const cryptoVersion = crypto.getVersion();
          return from(crypto.getOwnDeviceKeys()).pipe(
            map((ownKeys): CryptoSpikeResult => {
              client.stopClient();
              return {
                ok: true,
                cryptoVersion,
                deviceEd25519: ownKeys?.ed25519 ?? null,
                hasIndexedDB,
                durationMs: Math.round(performance.now() - start),
              };
            }),
          );
        }),
        catchError((err) =>
          of<CryptoSpikeResult>({
            ok: false,
            hasIndexedDB,
            durationMs: Math.round(performance.now() - start),
            error:
              err instanceof Error
                ? `${err.name}: ${err.message}`
                : String(err),
          }),
        ),
      );
    });
  }
}
