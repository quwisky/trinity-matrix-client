import { TestBed } from '@angular/core/testing';
import { createHmac } from 'node:crypto';
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

// The gated Synapse specs run only when TRINITY_ENGINE_CONTRACT_HS is set.
export const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

export async function register(username: string, admin = false) {
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
export async function cs(
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

export const room = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;

let sequence = 0;

export function localpart(role: string): string {
  sequence += 1;
  return `nt-${role}-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`;
}

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
