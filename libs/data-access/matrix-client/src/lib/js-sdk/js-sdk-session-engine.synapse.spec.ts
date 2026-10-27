import { TestBed } from '@angular/core/testing';
import { createHmac } from 'node:crypto';
import { MatrixClient } from 'matrix-js-sdk';
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
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
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

/** A password session with its own device; no refresh token or lifetime is requested. */
async function newPasswordSession(): Promise<MatrixSession> {
  sequence += 1;
  const user = await register(
    `sess-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`,
  );
  const res = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: user.userId },
      password: user.password,
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
  const listeners = process.listeners('unhandledRejection');
  const ignoreSyncAbort = (reason: unknown, promise: Promise<unknown>) => {
    if ((reason as { name?: string } | null)?.name === 'AbortError') return;
    for (const listener of listeners) listener(reason, promise);
  };
  beforeAll(() => {
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', ignoreSyncAbort);
  });
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
      await waitForBackgroundUpdates();
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
        dispose: async () => {
          TestBed.resetTestingModule();
        },
      };
    },
    { syncTimeoutMs: 90_000, testTimeoutMs: 180_000 },
  );
});
