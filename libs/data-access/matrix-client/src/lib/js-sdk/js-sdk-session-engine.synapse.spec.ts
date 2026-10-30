import { TestBed } from '@angular/core/testing';
import { HttpApiEvent, MatrixClient, MatrixError } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, vi } from 'vitest';
import {
  CryptoStoreKeyService,
  SessionStorageService,
} from '@trinity/platform-native';
import { defineSessionEngineContract } from '../../contract/session-engine.contract';
import { sessionSynapseFixture } from '../../contract/session-synapse-fixture';
import { JsSdkSessionEngine } from './js-sdk-session-engine';
import { MatrixClientService } from './matrix-client.service';

// jsdom serves no crypto .wasm and has no IndexedDB (the sync store falls back to memory).
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

// Runs the session engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

const synapse = sessionSynapseFixture(baseUrl, secret);

describe.skipIf(!baseUrl)('JsSdkSessionEngine against Synapse', () => {
  // Stopping a client aborts its in-flight /sync long-poll and the SDK leaves that rejection
  // unhandled; Vitest would fail the run for it, so only that abort is kept from Vitest.
  let listeners: NodeJS.UnhandledRejectionListener[] = [];
  const ignoreSyncAbort = (reason: unknown, promise: Promise<unknown>) => {
    if ((reason as { name?: string } | null)?.name === 'AbortError') return;
    for (const listener of listeners) listener(reason, promise);
  };
  beforeAll(async () => {
    listeners = process.listeners(
      'unhandledRejection',
    ) as NodeJS.UnhandledRejectionListener[];
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', ignoreSyncAbort);
    await synapse.waitForBackgroundUpdates();
  }, 120_000);
  afterAll(() => {
    process.removeListener('unhandledRejection', ignoreSyncAbort);
    for (const listener of listeners)
      process.on('unhandledRejection', listener);
  });

  beforeEach(() => {
    vi.spyOn(MatrixClient.prototype, 'initRustCrypto').mockResolvedValue();
  });

  defineSessionEngineContract(
    async () => {
      TestBed.configureTestingModule({
        providers: [
          MatrixClientService,
          MockProvider(SessionStorageService, {
            record: () => of(null),
            invalidateToken: () => of(void 0),
            remove: () => of(void 0),
            setActive: () => of(void 0),
            updateTokens: () => of(void 0),
          }),
          MockProvider(CryptoStoreKeyService),
        ],
      });
      return {
        engine: TestBed.inject(JsSdkSessionEngine),
        newSession: synapse.newSession,
        tokenAccepted: synapse.tokenAccepted,
        // What the SDK emits when the server answers 401 M_UNKNOWN_TOKEN with soft_logout.
        softLogout: async (session) => {
          TestBed.inject(MatrixClientService)
            .clientFor(session.userId)
            ?.emit(
              HttpApiEvent.SessionLoggedOut,
              new MatrixError(
                { errcode: 'M_UNKNOWN_TOKEN', soft_logout: true },
                401,
              ),
            );
        },
        revokeToken: synapse.revokeToken,
        passwordFor: synapse.passwordFor,
        signInAgain: synapse.signInAgain,
        dispose: async () => {
          TestBed.resetTestingModule();
        },
      };
    },
    { syncTimeoutMs: 90_000, testTimeoutMs: 180_000 },
  );
});
