import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { MatrixSession } from '@trinity/util/matrix';
import { accountStartFailureReason } from '../lib/session-engine';
import { FakeSessionEngine } from './fake-session-engine';
import { defineSessionEngineContract } from './session-engine.contract';

let counter = 0;
function session(): MatrixSession {
  counter += 1;
  return {
    baseUrl: 'https://matrix.example.org',
    userId: `@user${counter}:example.org`,
    deviceId: `DEVICE${counter}`,
    accessToken: `token-${counter}`,
  };
}

defineSessionEngineContract(
  async () => {
    const engine = new FakeSessionEngine();
    return {
      engine,
      newSession: async () => session(),
      tokenAccepted: async (s) => !engine.revokedTokens.has(s.accessToken),
      dispose: async () => undefined,
    };
  },
  { syncTimeoutMs: 500, testTimeoutMs: 5_000 },
);

describe('FakeSessionEngine', () => {
  it('maps a failed start to its reason', async () => {
    const engine = new FakeSessionEngine();
    const s = session();
    engine.failStart(s.userId, 'crypto-failure');

    const result = await firstValueFrom(engine.restorePersisted(s, 'activate'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(accountStartFailureReason(result.failure)).toBe('crypto-failure');
  });

  it('lands reauthentication-required in softLoggedOut', async () => {
    const engine = new FakeSessionEngine();
    const s = session();
    engine.failStart(s.userId, 'reauthentication-required');

    await firstValueFrom(engine.restorePersisted(s, 'activate'));

    const snap = await firstValueFrom(engine.session());
    expect(snap.softLoggedOut).toEqual([s.userId]);
    expect(snap.accounts).toEqual([]);
  });

  it('lands crypto-store-key-lost in softLoggedOut', async () => {
    const engine = new FakeSessionEngine();
    const s = session();
    engine.failStart(s.userId, 'crypto-store-key-lost');

    await firstValueFrom(engine.restorePersisted(s, 'activate'));

    const snap = await firstValueFrom(engine.session());
    expect(snap.softLoggedOut).toEqual([s.userId]);
  });

  it('reports the failure kind the adapter would', async () => {
    const engine = new FakeSessionEngine();
    const s = session();
    engine.failStart(s.userId, 'reauthentication-required');

    const result = await firstValueFrom(engine.restorePersisted(s, 'activate'));

    expect(!result.ok && result.failure.kind).toBe('authentication');
  });

  it('derives token expiry and refreshability only for OIDC sessions', async () => {
    const engine = new FakeSessionEngine();
    const plain = {
      ...session(),
      accessTokenExpiresAt: 99,
      refreshToken: 'r',
    };
    const oidc = {
      ...session(),
      accessTokenExpiresAt: 99,
      refreshToken: 'r',
      oidc: {} as NonNullable<MatrixSession['oidc']>,
    };
    await firstValueFrom(engine.restorePersisted(plain, 'activate'));
    await firstValueFrom(engine.restorePersisted(oidc, 'background'));

    expect(await firstValueFrom(engine.accessToken(plain.userId))).toEqual({
      accessToken: plain.accessToken,
      expiresAt: null,
      refreshable: false,
    });
    expect(await firstValueFrom(engine.accessToken(oidc.userId))).toEqual({
      accessToken: oidc.accessToken,
      expiresAt: 99,
      refreshable: true,
    });
  });

  it('re-emits on accessToken after a rotation', async () => {
    const engine = new FakeSessionEngine();
    const s = session();
    await firstValueFrom(engine.restorePersisted(s, 'activate'));
    const seen: (string | undefined)[] = [];
    const sub = engine
      .accessToken(s.userId)
      .subscribe((t) => seen.push(t?.accessToken));

    engine.setToken(s.userId, {
      accessToken: 'rotated',
      expiresAt: 1,
      refreshable: true,
    });
    sub.unsubscribe();

    expect(seen).toEqual([s.accessToken, 'rotated']);
  });
});
