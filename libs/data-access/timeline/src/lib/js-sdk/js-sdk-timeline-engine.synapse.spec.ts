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
import { defineTimelineEngineContract } from '../../contract/timeline-engine.contract';
import { JsSdkTimelineEngine } from './js-sdk-timeline-engine';

// jsdom serves no crypto .wasm and has no IndexedDB (the sync store falls back to memory).
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

// Runs the timeline engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const SETTLE_TIMEOUT_MS = 30_000;

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

/** A client-server API call as the token's user; returns the JSON body, or `null` on 404. */
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
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Synapse ${method} failed: ${res.status}`);
  return res.json();
}

const room = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;

let sequence = 0;

function localpart(role: string): string {
  sequence += 1;
  return `tl-${role}-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The event `userId`'s `m.read` receipt names in the room, from an initial sync of that room. */
async function receiptIn(
  accessToken: string,
  roomId: string,
  userId: string,
): Promise<string | null> {
  const syncFilter = JSON.stringify({
    presence: { not_types: ['*'] },
    account_data: { not_types: ['*'] },
    room: {
      rooms: [roomId],
      timeline: { limit: 1 },
      state: { lazy_load_members: true },
      ephemeral: { types: ['m.receipt'] },
    },
  });
  const sync = (await cs(
    accessToken,
    'GET',
    `/sync?filter=${encodeURIComponent(syncFilter)}`,
  )) as {
    rooms?: {
      join?: Record<
        string,
        { ephemeral?: { events?: { type: string; content: unknown }[] } }
      >;
    };
  };
  for (const event of sync.rooms?.join?.[roomId]?.ephemeral?.events ?? []) {
    if (event.type !== 'm.receipt') continue;
    for (const [eventId, kinds] of Object.entries(
      event.content as Record<string, Record<string, Record<string, unknown>>>,
    )) {
      if (kinds['m.read']?.[userId]) return eventId;
    }
  }
  return null;
}

describe.skipIf(!baseUrl)('JsSdkTimelineEngine against Synapse', () => {
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

  defineTimelineEngineContract(
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
        engine: TestBed.inject(JsSdkTimelineEngine),
        alice,
        bob: bob.userId,
        serverName,
        asAlice: {
          join: async (roomId) => {
            await cs(login.access_token, 'POST', `${room(roomId)}/join`, {});
          },
          fullyRead: async (roomId) => {
            const marker = (await cs(
              login.access_token,
              'GET',
              `/user/${encodeURIComponent(alice)}${room(roomId)}/account_data/m.fully_read`,
            )) as { event_id?: string } | null;
            return marker?.event_id ?? null;
          },
        },
        asBob: {
          createRoom: async (name) =>
            (
              (await cs(bob.accessToken, 'POST', '/createRoom', {
                name,
                preset: 'private_chat',
                initial_state: [
                  {
                    type: 'm.room.history_visibility',
                    state_key: '',
                    content: { history_visibility: 'shared' },
                  },
                ],
              })) as { room_id: string }
            ).room_id,
          invite: async (roomId, userId) => {
            await cs(bob.accessToken, 'POST', `${room(roomId)}/invite`, {
              user_id: userId,
            });
          },
          send: async (roomId, body) =>
            (
              (await cs(
                bob.accessToken,
                'PUT',
                `${room(roomId)}/send/m.room.message/${localpart('txn')}`,
                { msgtype: 'm.text', body },
              )) as { event_id: string }
            ).event_id,
          react: async (roomId, eventId, key) => {
            await cs(
              bob.accessToken,
              'PUT',
              `${room(roomId)}/send/m.reaction/${localpart('txn')}`,
              {
                'm.relates_to': {
                  rel_type: 'm.annotation',
                  event_id: eventId,
                  key,
                },
              },
            );
          },
          redact: async (roomId, eventId) => {
            await cs(
              bob.accessToken,
              'PUT',
              `${room(roomId)}/redact/${encodeURIComponent(eventId)}/${localpart('txn')}`,
              {},
            );
          },
          edit: async (roomId, eventId, body) => {
            await cs(
              bob.accessToken,
              'PUT',
              `${room(roomId)}/send/m.room.message/${localpart('txn')}`,
              {
                msgtype: 'm.text',
                body: `* ${body}`,
                'm.new_content': { msgtype: 'm.text', body },
                'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
              },
            );
          },
          // The receipt reaches bob's sync asynchronously, so poll until it names an event.
          readReceipt: async (roomId, userId) => {
            const deadline = Date.now() + SETTLE_TIMEOUT_MS;
            for (;;) {
              const eventId = await receiptIn(bob.accessToken, roomId, userId);
              if (eventId || Date.now() > deadline) return eventId;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          },
        },
        // A crypto store that knows the contract's rooms are unencrypted, as the real one would.
        knownUnencrypted: () => {
          const spy = vi
            .spyOn(MatrixClient.prototype, 'getCrypto')
            .mockReturnValue({
              isEncryptionEnabledInRoom: async () => false,
            } as never);
          return () => spy.mockRestore();
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
    { settleTimeoutMs: SETTLE_TIMEOUT_MS, testTimeoutMs: 180_000 },
  );
});
