import { TestBed } from '@angular/core/testing';
import { MatrixClient } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { filter, firstValueFrom, of, timeout } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, vi } from 'vitest';
import {
  MatrixClientService,
  SESSION_ENGINE,
} from '@trinity/data-access/matrix-client';
import {
  CryptoStoreKeyService,
  SessionStorageService,
} from '@trinity/platform-native';
import { waitForSynapseBackgroundUpdates } from '@trinity/testing';
import { defineRoomListEngineContract } from '../../contract/room-list-engine.contract';
import { roomListSynapseFixture } from '../../contract/room-list-synapse-fixture';
import { JsSdkRoomListEngine } from './js-sdk-room-list-engine';

// Runs the room list engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

describe.skipIf(!baseUrl)('JsSdkRoomListEngine against Synapse', () => {
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
    await waitForSynapseBackgroundUpdates(baseUrl as string, secret);
  }, 120_000);
  afterAll(() => {
    process.removeListener('unhandledRejection', ignoreSyncAbort);
    for (const listener of listeners)
      process.on('unhandledRejection', listener);
  });

  beforeEach(() => {
    vi.spyOn(MatrixClient.prototype, 'initRustCrypto').mockResolvedValue();
  });

  defineRoomListEngineContract(
    async () => {
      const { alice, ...fixture } = await roomListSynapseFixture(
        baseUrl as string,
        serverName,
        secret,
      );

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
      const session = TestBed.inject(SESSION_ENGINE);
      const restored = await firstValueFrom(
        session.restorePersisted(
          {
            baseUrl: baseUrl as string,
            userId: alice.userId,
            deviceId: alice.deviceId,
            accessToken: alice.accessToken,
          },
          'activate',
        ),
      );
      if (!restored.ok)
        throw new Error(`Restore failed: ${restored.failure.code}`);
      await firstValueFrom(
        session.session().pipe(
          filter((s) =>
            s.accounts.some(
              (a) =>
                a.accountId === alice.userId &&
                a.serverSynced &&
                a.roomsPrepared,
            ),
          ),
          timeout(90_000),
        ),
      );

      return {
        engine: TestBed.inject(JsSdkRoomListEngine),
        ...fixture,
        alice: alice.userId,
        dispose: async () => {
          try {
            await firstValueFrom(session.stop());
          } finally {
            TestBed.resetTestingModule();
          }
        },
      };
    },
    { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
  );
});
