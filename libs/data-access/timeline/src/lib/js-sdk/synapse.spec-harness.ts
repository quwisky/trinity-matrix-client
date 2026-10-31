import { TestBed } from '@angular/core/testing';
import { MatrixClient } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { filter, firstValueFrom, of, timeout } from 'rxjs';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import {
  MatrixClientService,
  SESSION_ENGINE,
} from '@trinity/data-access/matrix-client';
import {
  CryptoStoreKeyService,
  SessionStorageService,
} from '@trinity/platform-native';
import { waitForSynapseBackgroundUpdates } from '@trinity/testing';

// The gated Synapse specs run only when TRINITY_ENGINE_CONTRACT_HS is set.
export const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
export const serverName =
  process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
export const secret =
  process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

/**
 * Registers the suite hooks: waits for Synapse's background updates, stubs Rust crypto,
 * and keeps from Vitest the sync abort the SDK leaves unhandled when a client stops.
 */
export function useSynapseSuite(): void {
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
}

/** Stubs the crypto store as knowing every room is unencrypted; returns the restore. */
export function stubUnencryptedRooms(): () => void {
  const spy = vi.spyOn(MatrixClient.prototype, 'getCrypto').mockReturnValue({
    isEncryptionEnabledInRoom: async () => false,
  } as unknown as ReturnType<MatrixClient['getCrypto']>);
  return () => spy.mockRestore();
}

/** Logs `user` in and starts a synced session for them in a fresh TestBed. */
export async function startSession(user: {
  readonly userId: string;
  readonly password: string;
}): Promise<{
  readonly userId: string;
  readonly accessToken: string;
  dispose(): Promise<void>;
}> {
  const login = (await fetch(`${baseUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: user.userId },
      password: user.password,
    }),
  }).then((res) => {
    if (!res.ok) throw new Error(`Synapse login failed: ${res.status}`);
    return res.json();
  })) as { user_id: string; device_id: string; access_token: string };

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
        userId: login.user_id,
        deviceId: login.device_id,
        accessToken: login.access_token,
      },
      'activate',
    ),
  );
  if (!restored.ok) throw new Error(`Restore failed: ${restored.failure.code}`);
  await firstValueFrom(
    session.session().pipe(
      filter((s) =>
        s.accounts.some(
          (a) =>
            a.accountId === login.user_id && a.serverSynced && a.roomsPrepared,
        ),
      ),
      timeout(90_000),
    ),
  );
  return {
    userId: login.user_id,
    accessToken: login.access_token,
    dispose: async () => {
      try {
        await firstValueFrom(session.stop());
      } finally {
        TestBed.resetTestingModule();
      }
    },
  };
}
