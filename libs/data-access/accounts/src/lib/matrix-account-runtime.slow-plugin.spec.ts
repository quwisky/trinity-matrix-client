import { TestBed } from '@angular/core/testing';
import { NativeTokenBridge } from '@trinity/platform-native';
import type { MatrixSession } from '@trinity/util/matrix';
import { firstValueFrom, from, map, of, switchMap } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_RESTORE_POLICY } from './account-runtime.adapter';
import { restoreAccountWithinPolicy } from './account-restore-attempt';
import { setup } from './matrix-account-runtime.spec-harness';

/** The plugin a test runs on, read as the real bridge is built. */
const host = vi.hoisted(() => ({ plugin: {} as Record<string, unknown> }));

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'PushHandoff',
    },
    registerPlugin: (name: string) =>
      name === 'PushHandoff'
        ? new Proxy({}, { get: (_, method: string) => host.plugin[method] })
        : actual.registerPlugin(name),
  };
});

/** Just under the bridge's 13 s call limit and its 3 s vault-read limit. */
const SLOW_CALL_MS = 12_900;
const SLOW_READ_MS = 2_900;

const SESSION: MatrixSession = {
  baseUrl: 'https://hs',
  userId: '@oidc:hs',
  deviceId: 'D',
  accessToken: 'a0',
  refreshToken: 'r0',
  lineage: 'L',
  oidc: {
    issuer: 'https://op.example',
    clientId: 'c',
    tokenEndpoint: 'https://op.example/token',
    revocationEndpoint: 'https://op.example/revoke',
  },
};

describe('restoring an account behind a very slow native plugin', () => {
  afterEach(() => vi.useRealTimers());

  it('times the restore out without signing out or wiping anything', async () => {
    vi.useFakeTimers();
    const slow = <T>(ms: number, value: T) =>
      vi.fn(
        () => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms)),
      );
    const plugin = {
      migrateTokens: slow(SLOW_CALL_MS, { stored: true }),
      currentTokens: slow(SLOW_READ_MS, {
        kind: 'current' as const,
        accessToken: 'a0',
      }),
      refreshTokens: slow(SLOW_CALL_MS, {
        kind: 'current' as const,
        accessToken: 'a0',
      }),
      revokeTokens: slow(SLOW_CALL_MS, { kind: 'revoked' as const }),
      removeTokens: slow(SLOW_CALL_MS, undefined),
    };
    host.plugin = plugin;
    const test = setup();
    const bridge = TestBed.runInInjectionContext(() => new NativeTokenBridge());
    vi.mocked(test.storage.load).mockReturnValue(of(SESSION));
    vi.mocked(test.storage.dropRefreshToken).mockReturnValue(of(void 0));
    // The client's start: the prepared session, a refresh, then a read, each through the bridge.
    vi.mocked(test.matrix.restorePersisted).mockImplementation((session) =>
      bridge.prepare(session).pipe(
        switchMap(() => from(bridge.host(session).refresh('a0'))),
        switchMap(() => from(bridge.host(session).current())),
        map(() => ({ kind: 'ready' as const })),
      ),
    );

    const outcome = firstValueFrom(
      restoreAccountWithinPolicy(
        test.adapter,
        TestBed.inject(ACCOUNT_RESTORE_POLICY),
        SESSION.userId,
        'active',
      ),
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(outcome).resolves.toEqual({
      kind: 'timed-out',
      accountId: SESSION.userId,
      role: 'active',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(plugin.migrateTokens).toHaveBeenCalledTimes(1);
    expect(plugin.revokeTokens).not.toHaveBeenCalled();
    expect(plugin.removeTokens).not.toHaveBeenCalled();
    expect(test.storage.invalidateToken).not.toHaveBeenCalled();
    expect(test.storage.remove).not.toHaveBeenCalled();
    expect(test.storage.clear).not.toHaveBeenCalled();
    expect(test.matrix.requireReauthentication).not.toHaveBeenCalled();
    expect(test.matrix.signOutAll).not.toHaveBeenCalled();
    expect(test.matrix.remove).not.toHaveBeenCalled();
    expect(test.wipe.wipeIndexedDb).not.toHaveBeenCalled();
    expect(test.wipe.wipeKeyValueStores).not.toHaveBeenCalled();
  });
});
