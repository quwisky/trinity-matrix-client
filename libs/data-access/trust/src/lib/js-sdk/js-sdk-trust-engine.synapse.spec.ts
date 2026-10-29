import { TestBed } from '@angular/core/testing';
import { describe, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineTrustEngineContract } from '../../contract/trust-engine.contract';
import { JsSdkTrustEngine } from './js-sdk-trust-engine';
import {
  baseUrl,
  cs,
  localpart,
  register,
  startSession,
  useSynapseSuite,
} from './synapse.spec-harness';

// Real Rust crypto: the WASM loads from the package's Node entry, not a served asset.
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { from: rxFrom, map: rxMap } = await import('rxjs');
  const { initAsync } = await import('@matrix-org/matrix-sdk-crypto-wasm');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxFrom(initAsync()).pipe(rxMap(() => undefined)),
  };
});

// Runs the trust contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
describe.skipIf(!baseUrl)('JsSdkTrustEngine against Synapse', () => {
  useSynapseSuite();

  defineTrustEngineContract(
    async () => {
      const session = await startSession(await register(localpart('alice')));
      return {
        engine: TestBed.inject(JsSdkTrustEngine),
        alice: session.userId,
        publishIdentity: async () => {
          const crypto = TestBed.inject(JS_SDK_CLIENTS)
            .clientFor(session.userId)
            ?.getCrypto();
          if (!crypto) throw new Error('No crypto for alice');
          await crypto.bootstrapCrossSigning({
            setupNewCrossSigning: true,
            authUploadDeviceSigningKeys: async (makeRequest) => {
              await makeRequest({
                type: 'm.login.password',
                identifier: { type: 'm.id.user', user: session.userId },
                password: session.password,
              });
            },
          });
        },
        setServerDefaultKey: async (keyId) => {
          await cs(
            session.accessToken,
            'PUT',
            `/user/${encodeURIComponent(session.userId)}/account_data/m.secret_storage.default_key`,
            { key: keyId },
          );
        },
        dispose: () => session.dispose(),
      };
    },
    { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
  );
});
