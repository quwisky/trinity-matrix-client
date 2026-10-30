import { TestBed } from '@angular/core/testing';
import { createHmac } from 'node:crypto';
import { HttpApiEvent, MatrixClient, MatrixError } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, vi } from 'vitest';
import {
  CryptoStoreKeyService,
  SessionStorageService,
} from '@trinity/platform-native';
import type { MatrixSession } from '@trinity/util/matrix';
import { defineSessionEngineContract } from '../../contract/session-engine.contract';
import { JsSdkSessionEngine } from './js-sdk-session-engine';
import { MatrixClientService } from './matrix-client.service';

// jsdom serves no crypto .wasm and has no IndexedDB (the sync store falls back to memory).
vi.mock('./crypto-wasm-loader', async () => {
  const { of: rxOf } = await import('rxjs');
  return { preloadCryptoWasm: () => rxOf(undefined) };
});

// Runs the session engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
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

let sequence = 0;
const passwords = new Map<string, string>();

/** A password session with its own device; no refresh token or lifetime is requested. */
async function newPasswordSession(): Promise<MatrixSession> {
  sequence += 1;
  const user = await register(
    `sess-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`,
  );
  passwords.set(user.userId, user.password);
  return login(user.userId);
}

/** Signs in with the account's password as a new device. */
async function login(userId: string): Promise<MatrixSession> {
  const res = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: userId },
      password: passwords.get(userId),
    }),
  });
  if (!res.ok) throw new Error(`Synapse login failed: ${res.status}`);
  const body = (await res.json()) as {
    user_id: string;
    device_id: string;
    access_token: string;
  };
  return {
    baseUrl: baseUrl as string,
    userId: body.user_id,
    deviceId: body.device_id,
    accessToken: body.access_token,
  };
}

async function asUser(
  session: MatrixSession,
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
): Promise<void> {
  const res = await fetch(`${baseUrl}/_matrix/client/v3${path}`, {
    method,
    headers: { authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`Synapse ${method} ${path} failed: ${res.status}`);
}

async function whoamiAccepts(token: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/_matrix/client/v3/account/whoami`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.ok) return true;
  const body = (await res.json().catch(() => ({}))) as { errcode?: string };
  if (res.status === 401 || body.errcode === 'M_UNKNOWN_TOKEN') return false;
  throw new Error(`Synapse whoami failed: ${res.status}`);
}

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
        newSession: newPasswordSession,
        tokenAccepted: (session) => whoamiAccepts(session.accessToken),
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
        revokeToken: async (session) => {
          const res = await fetch(`${baseUrl}/_matrix/client/v3/logout`, {
            method: 'POST',
            headers: { authorization: `Bearer ${session.accessToken}` },
          });
          if (!res.ok) throw new Error(`Synapse logout failed: ${res.status}`);
        },
        passwordFor: (session) => passwords.get(session.userId) ?? '',
        signInAgain: (session) => login(session.userId),
        createNamedRoom: async (session, names) => {
          await asUser(
            session,
            'PUT',
            `/profile/${encodeURIComponent(session.userId)}/displayname`,
            { displayname: names.displayName },
          );
          await asUser(session, 'POST', '/createRoom', {
            name: names.roomName,
            topic: names.roomTopic,
            preset: 'private_chat',
          });
        },
        dispose: async () => {
          TestBed.resetTestingModule();
        },
      };
    },
    { syncTimeoutMs: 90_000, testTimeoutMs: 180_000 },
  );
});
