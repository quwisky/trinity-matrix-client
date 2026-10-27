import { TestBed } from '@angular/core/testing';
import { createHmac } from 'node:crypto';
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
import { defineRoomListEngineContract } from '../../contract/room-list-engine.contract';
import { JsSdkRoomListEngine } from './js-sdk-room-list-engine';

// jsdom serves no crypto .wasm and has no IndexedDB (the sync store falls back to memory).
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

// Runs the room list engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

async function register(username: string, admin = false) {
  const api = `${baseUrl}/_synapse/admin/v1/register`;
  const nonceRes = await fetch(api);
  if (!nonceRes.ok)
    throw new Error(`Synapse nonce request failed: ${nonceRes.status}`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const password = `pw-${Math.random().toString(36).slice(2)}`;
  const mac = createHmac('sha1', secret)
    .update(
      `${nonce}\0${username}\0${password}\0${admin ? 'admin' : 'notadmin'}`,
    )
    .digest('hex');
  const res = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({ nonce, username, password, mac, admin }),
  });
  if (!res.ok) throw new Error(`Synapse registration failed: ${res.status}`);
  const body = (await res.json()) as { user_id: string; access_token: string };
  return { userId: body.user_id, password, accessToken: body.access_token };
}

// A fresh Synapse rebuilds its user directory in a background update and drops users
// registered meanwhile, so the contract users are only created once it has finished.
async function waitForBackgroundUpdates(): Promise<void> {
  const admin = await register(`admin-${Date.now().toString(36)}`, true);
  for (let i = 0; i < 240; i++) {
    const res = await fetch(
      `${baseUrl}/_synapse/admin/v1/background_updates/status`,
      { headers: { authorization: `Bearer ${admin.accessToken}` } },
    );
    if (!res.ok)
      throw new Error(`Synapse background update status failed: ${res.status}`);
    const { current_updates } = (await res.json()) as {
      current_updates: Record<string, unknown>;
    };
    if (Object.keys(current_updates).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Synapse background updates did not finish');
}

/** A client-server API call as the token's user; returns the JSON body. */
async function cs(
  accessToken: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}/_matrix/client/v3${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`Synapse ${method} failed: ${res.status}`);
  return res.json();
}

/** MSC4380 through its unstable flags or spec v1.18 and later, as `/versions` reports it. */
async function advertisesInviteBlocking(): Promise<boolean> {
  const res = await fetch(`${baseUrl}/_matrix/client/versions`);
  if (!res.ok) throw new Error(`Synapse /versions failed: ${res.status}`);
  const { versions = [], unstable_features = {} } = (await res.json()) as {
    versions?: string[];
    unstable_features?: Record<string, boolean>;
  };
  return (
    unstable_features['org.matrix.msc4380'] === true ||
    unstable_features['org.matrix.msc4380.stable'] === true ||
    versions.some((v) => Number(/^v1\.(\d+)$/.exec(v)?.[1]) >= 18)
  );
}

const room = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;

let sequence = 0;

function localpart(role: string): string {
  sequence += 1;
  return `rl-${role}-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`;
}

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
    await waitForBackgroundUpdates();
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
      const [aliceUser, bob] = await Promise.all([
        register(localpart('alice')),
        register(localpart('bob')),
      ]);
      const login = (await fetch(`${baseUrl}/_matrix/client/v3/login`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: aliceUser.userId },
          password: aliceUser.password,
        }),
      }).then((res) => {
        if (!res.ok) throw new Error(`Synapse login failed: ${res.status}`);
        return res.json();
      })) as { user_id: string; device_id: string; access_token: string };
      const alice = login.user_id;

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
            userId: alice,
            deviceId: login.device_id,
            accessToken: login.access_token,
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
              (a) => a.accountId === alice && a.serverSynced && a.roomsPrepared,
            ),
          ),
          timeout(90_000),
        ),
      );

      return {
        engine: TestBed.inject(JsSdkRoomListEngine),
        alice,
        bob: bob.userId,
        serverName,
        serverBlocksInvites: await advertisesInviteBlocking(),
        asAlice: {
          publishAlias: async (roomId, name) => {
            const alias = `#${name}:${serverName}`;
            await cs(
              login.access_token,
              'PUT',
              `/directory/room/${encodeURIComponent(alias)}`,
              { room_id: roomId },
            );
            return alias;
          },
          join: async (roomId) => {
            await cs(login.access_token, 'POST', `${room(roomId)}/join`, {});
          },
          spaceParents: async (roomId) => {
            const state = (await cs(
              login.access_token,
              'GET',
              `${room(roomId)}/state`,
            )) as { type: string; state_key: string; content: object }[];
            return state
              .filter(
                (e) =>
                  e.type === 'm.space.parent' &&
                  Object.keys(e.content).length > 0,
              )
              .map((e) => e.state_key);
          },
        },
        asBob: {
          createRoom: async (name) =>
            (
              (await cs(bob.accessToken, 'POST', '/createRoom', {
                name,
              })) as { room_id: string }
            ).room_id,
          createPublicRoom: async (name, aliasLocalpart) => {
            const { room_id } = (await cs(
              bob.accessToken,
              'POST',
              '/createRoom',
              { name, preset: 'public_chat', room_alias_name: aliasLocalpart },
            )) as { room_id: string };
            return {
              roomId: room_id,
              alias: `#${aliasLocalpart}:${serverName}`,
            };
          },
          join: async (roomId) => {
            await cs(bob.accessToken, 'POST', `${room(roomId)}/join`, {});
          },
          // The invite endpoint takes no is_direct; the member event carries it.
          invite: async (roomId, userId, options) => {
            await cs(
              bob.accessToken,
              'PUT',
              `${room(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`,
              {
                membership: 'invite',
                ...(options?.isDirect ? { is_direct: true } : {}),
              },
            );
          },
          sendTyping: async (roomId) => {
            await cs(
              bob.accessToken,
              'PUT',
              `${room(roomId)}/typing/${encodeURIComponent(bob.userId)}`,
              { typing: true, timeout: 30_000 },
            );
          },
          sendMessage: async (roomId, body) => {
            await cs(
              bob.accessToken,
              'PUT',
              `${room(roomId)}/send/m.room.message/${localpart('txn')}`,
              { msgtype: 'm.text', body },
            );
          },
        },
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
