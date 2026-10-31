import { TestBed } from '@angular/core/testing';
import {
  PushHandoffBridge,
  type NativeTokenRecord,
  type NativeTokenResult,
  type NativeTokenRevocation,
} from '@trinity/capacitor-push';
import type { MatrixSession } from '@trinity/util/matrix';
import { NEVER, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_REFRESH_MARKER,
  NativeTokenBridge,
} from './native-token-bridge.service';
import { SessionStorageService } from './session-storage.service';

const TIMEOUT_MS = 13_000;
const USER = '@me:hs';
const LINEAGE = 'L';

const SESSION = {
  baseUrl: 'https://hs',
  userId: USER,
  deviceId: 'D',
  accessToken: 'a0',
  refreshToken: 'r0',
  accessTokenExpiresAt: 300,
  lineage: LINEAGE,
  oidc: {
    issuer: 'https://op.example',
    clientId: 'c',
    tokenEndpoint: 'https://op.example/token',
    revocationEndpoint: 'https://op.example/revoke',
  },
} satisfies MatrixSession;

const NO_COPY: MatrixSession = { ...SESSION, refreshToken: undefined };

type VaultRecord = Pick<
  NativeTokenRecord,
  'lineage' | 'accessToken' | 'refreshToken' | 'accessTokenExpiresAt'
>;

/** Answers as `TokenRefresher` does: a record of this lineage stays, it may be newer. */
function setup(stored?: VaultRecord) {
  const state = {
    record: stored,
    unreadable: false,
    refused: false,
    jsCopy: true,
  };
  const bridge = {
    available: true,
    migrateTokens: vi.fn<PushHandoffBridge['migrateTokens']>((record) => {
      if (state.unreadable) return of(false);
      if (state.record?.lineage !== record.lineage) state.record = record;
      return of(true);
    }),
    currentTokens: vi.fn<PushHandoffBridge['currentTokens']>(
      (_userId, lineage) => {
        if (state.unreadable) return of({ kind: 'transient' });
        if (state.record?.lineage !== lineage) return of({ kind: 'gone' });
        if (state.refused) return of({ kind: 'refused' });
        return of({
          kind: 'current',
          accessToken: state.record.accessToken,
          accessTokenExpiresAt: state.record.accessTokenExpiresAt,
        });
      },
    ),
    refreshTokens: vi.fn<PushHandoffBridge['refreshTokens']>(() =>
      of<NativeTokenResult>({ kind: 'transient' }),
    ),
    revokeTokens: vi.fn<PushHandoffBridge['revokeTokens']>(() =>
      of<NativeTokenRevocation>({ kind: 'gone' }),
    ),
    removeTokens: vi.fn<PushHandoffBridge['removeTokens']>(() => {
      state.record = undefined;
      state.unreadable = false;
      return of(undefined);
    }),
  };
  const storage = {
    dropRefreshToken: vi.fn<SessionStorageService['dropRefreshToken']>(() => {
      state.jsCopy = false;
      return of(undefined);
    }),
    invalidateToken: vi.fn<SessionStorageService['invalidateToken']>(() => {
      state.jsCopy = false;
      return of(undefined);
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      NativeTokenBridge,
      { provide: PushHandoffBridge, useValue: bridge },
      { provide: SessionStorageService, useValue: storage },
    ],
  });
  return {
    bridge,
    storage,
    state,
    tokens: TestBed.inject(NativeTokenBridge),
  };
}

const R0: VaultRecord = {
  lineage: LINEAGE,
  accessToken: 'a0',
  refreshToken: 'r0',
  accessTokenExpiresAt: 300,
};
const R2: VaultRecord = {
  lineage: LINEAGE,
  accessToken: 'a2',
  refreshToken: 'r2',
  accessTokenExpiresAt: 900,
};

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('NativeTokenBridge', () => {
  describe('migration', () => {
    it('crash point 0: nothing moved yet, migrates and drops the copy', async () => {
      const { tokens, bridge, storage, state } = setup();

      const prepared = await firstValueFrom(tokens.prepare(SESSION));

      expect(bridge.migrateTokens).toHaveBeenCalledExactlyOnceWith({
        userId: USER,
        lineage: LINEAGE,
        accessToken: 'a0',
        refreshToken: 'r0',
        accessTokenExpiresAt: 300,
        tokenEndpoint: 'https://op.example/token',
        revocationEndpoint: 'https://op.example/revoke',
        clientId: 'c',
        deviceId: 'D',
      });
      expect(storage.dropRefreshToken).toHaveBeenCalledExactlyOnceWith(
        USER,
        LINEAGE,
      );
      expect(state.record?.refreshToken).toBe('r0');
      expect(prepared).toEqual({
        kind: 'ready',
        session: { ...SESSION, refreshToken: NATIVE_REFRESH_MARKER },
      });
    });

    it('crash point 1: native wrote, the JS copy survived, the next start only drops the copy', async () => {
      const { tokens, storage, state } = setup(R0);

      await firstValueFrom(tokens.prepare(SESSION));

      expect(state.record).toBe(R0);
      expect(storage.dropRefreshToken).toHaveBeenCalledOnce();
    });

    it('crash point 2: native rotated meanwhile, the stale JS copy does not overwrite the vault', async () => {
      const { tokens, storage, state } = setup(R2);

      const prepared = await firstValueFrom(tokens.prepare(SESSION));

      expect(state.record).toBe(R2);
      expect(storage.dropRefreshToken).toHaveBeenCalledOnce();
      expect(prepared).toEqual({
        kind: 'ready',
        session: {
          ...SESSION,
          accessToken: 'a2',
          accessTokenExpiresAt: 900,
          refreshToken: NATIVE_REFRESH_MARKER,
        },
      });
    });

    it('crash point 3: the copy is gone and the next start uses the vault', async () => {
      const { tokens, bridge, storage } = setup(R2);

      const prepared = await firstValueFrom(tokens.prepare(NO_COPY));

      expect(bridge.migrateTokens).not.toHaveBeenCalled();
      expect(storage.dropRefreshToken).not.toHaveBeenCalled();
      expect(prepared).toMatchObject({
        session: { accessToken: 'a2', refreshToken: NATIVE_REFRESH_MARKER },
      });
    });

    it('a second run changes nothing', async () => {
      const { tokens, state } = setup();

      const first = await firstValueFrom(tokens.prepare(SESSION));
      const record = state.record;
      const second = await firstValueFrom(tokens.prepare(NO_COPY));

      expect(state.record).toBe(record);
      expect(second).toEqual(first);
    });

    it('keeps the JS copy and the old path when native refuses the write', async () => {
      const { tokens, bridge, storage } = setup();
      bridge.migrateTokens.mockReturnValue(of(false));

      const prepared = await firstValueFrom(tokens.prepare(SESSION));

      expect(prepared).toEqual({ kind: 'ready', session: SESSION });
      expect(storage.dropRefreshToken).not.toHaveBeenCalled();
    });

    it('a false migration answer with a vault pair already stored starts from the vault pair with the marker', async () => {
      const { tokens, bridge, storage } = setup(R2);
      bridge.migrateTokens.mockReturnValue(of(false));

      const prepared = await firstValueFrom(tokens.prepare(SESSION));

      expect(prepared).toMatchObject({
        session: { accessToken: 'a2', refreshToken: NATIVE_REFRESH_MARKER },
      });
      expect(storage.dropRefreshToken).not.toHaveBeenCalled();
    });

    it.each([
      ['gone', { kind: 'gone' }],
      ['unavailable', { kind: 'unavailable' }],
    ] as const)(
      'keeps the JS copy and the old path when the bridge rejects and current is %s',
      async (_name, answer) => {
        const { tokens, bridge, storage } = setup();
        bridge.migrateTokens.mockReturnValue(
          throwError(() => new Error('rejected')),
        );
        bridge.currentTokens.mockReturnValue(of(answer));

        const prepared = await firstValueFrom(tokens.prepare(SESSION));

        expect(prepared).toEqual({ kind: 'ready', session: SESSION });
        expect(storage.dropRefreshToken).not.toHaveBeenCalled();
      },
    );

    it('a failed migrateTokens followed by current starts from the vault pair with the marker', async () => {
      const { tokens, bridge, storage } = setup(R2);
      bridge.migrateTokens.mockReturnValue(
        throwError(() => new Error('rejected')),
      );

      const prepared = await firstValueFrom(tokens.prepare(SESSION));

      expect(prepared).toMatchObject({
        session: { accessToken: 'a2', refreshToken: NATIVE_REFRESH_MARKER },
      });
      expect(storage.dropRefreshToken).not.toHaveBeenCalled();
    });

    it('a native call that never answers reads as a failure and starts on the stored copy', async () => {
      vi.useFakeTimers();
      const { tokens, bridge, storage } = setup();
      bridge.migrateTokens.mockReturnValue(NEVER);
      bridge.currentTokens.mockReturnValue(NEVER);
      const next = vi.fn();

      tokens.prepare(SESSION).subscribe(next);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(bridge.currentTokens).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(next).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(next).toHaveBeenCalledExactlyOnceWith({
        kind: 'ready',
        session: { ...SESSION, refreshToken: NATIVE_REFRESH_MARKER },
      });
      expect(storage.dropRefreshToken).not.toHaveBeenCalled();
    });

    it.each(['gone', 'unavailable'] as const)(
      'a migrate that times out never takes the old path, its write may still land: current is %s',
      async (kind) => {
        vi.useFakeTimers();
        const { tokens, bridge, storage } = setup();
        bridge.migrateTokens.mockReturnValue(NEVER);
        bridge.currentTokens.mockReturnValue(of({ kind }));
        const next = vi.fn();

        tokens.prepare(SESSION).subscribe(next);
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

        expect(next).toHaveBeenCalledExactlyOnceWith({
          kind: 'ready',
          session: { ...SESSION, refreshToken: NATIVE_REFRESH_MARKER },
        });
        expect(storage.dropRefreshToken).not.toHaveBeenCalled();

        bridge.refreshTokens.mockReturnValue(of({ kind: 'gone' }));
        await expect(tokens.host(SESSION).refresh('a0')).resolves.toEqual({
          kind: 'transient',
        });
      },
    );

    it('a storage call that never answers does not hold the start', async () => {
      vi.useFakeTimers();
      const { tokens, storage } = setup();
      storage.dropRefreshToken.mockReturnValue(NEVER);
      const next = vi.fn();

      tokens.prepare(SESSION).subscribe(next);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

      expect(next).toHaveBeenCalledOnce();
    });

    it('a failed drop is ignored and the next start repeats it', async () => {
      const { tokens, storage } = setup();
      storage.dropRefreshToken.mockReturnValueOnce(
        throwError(() => new Error('locked')),
      );

      const prepared = await firstValueFrom(tokens.prepare(SESSION));
      await firstValueFrom(tokens.prepare(SESSION));

      expect(prepared).toMatchObject({
        session: { refreshToken: NATIVE_REFRESH_MARKER },
      });
      expect(storage.dropRefreshToken).toHaveBeenCalledTimes(2);
    });

    it('migrates nothing for a binding with no token endpoint', async () => {
      const { tokens, bridge, storage } = setup();
      const unpinned: MatrixSession = {
        ...SESSION,
        oidc: { issuer: 'https://op.example', clientId: 'c' },
      };

      const prepared = await firstValueFrom(tokens.prepare(unpinned));

      expect(prepared).toEqual({ kind: 'ready', session: unpinned });
      expect(bridge.migrateTokens).not.toHaveBeenCalled();
      expect(bridge.currentTokens).not.toHaveBeenCalled();
      expect(storage.dropRefreshToken).not.toHaveBeenCalled();
    });

    it('sends an empty lineage for a session saved before lineages', async () => {
      const { tokens, bridge, storage } = setup();
      const old: MatrixSession = { ...SESSION, lineage: undefined };

      await firstValueFrom(tokens.prepare(old));

      expect(bridge.migrateTokens.mock.calls[0]?.[0].lineage).toBe('');
      expect(bridge.currentTokens).toHaveBeenCalledWith(USER, '');
      expect(storage.dropRefreshToken).toHaveBeenCalledWith(USER, undefined);
    });
  });

  describe('start', () => {
    it('starts from the vault pair, not the stored copy (failure 7)', async () => {
      const { tokens } = setup(R2);

      const prepared = await firstValueFrom(tokens.prepare(NO_COPY));

      expect(prepared).toEqual({
        kind: 'ready',
        session: {
          ...NO_COPY,
          accessToken: 'a2',
          accessTokenExpiresAt: 900,
          refreshToken: NATIVE_REFRESH_MARKER,
        },
      });
    });

    it('clears a stored expiry when the vault pair has no known expiry', async () => {
      const { tokens } = setup({
        lineage: LINEAGE,
        accessToken: 'a2',
        refreshToken: 'r2',
      });

      const prepared = await firstValueFrom(tokens.prepare(NO_COPY));

      expect(prepared).toMatchObject({ session: { accessToken: 'a2' } });
      expect(
        prepared.kind === 'ready' && prepared.session.accessTokenExpiresAt,
      ).toBeUndefined();
    });

    it('soft-logs out a refused record and invalidates its tokens', async () => {
      const { tokens, storage, state } = setup(R2);
      state.refused = true;

      const prepared = await firstValueFrom(tokens.prepare(NO_COPY));

      expect(prepared).toEqual({ kind: 'refused' });
      expect(storage.invalidateToken).toHaveBeenCalledExactlyOnceWith(USER);
    });

    it('still reports a refused record when invalidating it fails', async () => {
      const { tokens, storage, state } = setup(R2);
      state.refused = true;
      storage.invalidateToken.mockReturnValue(
        throwError(() => new Error('locked')),
      );

      await expect(firstValueFrom(tokens.prepare(NO_COPY))).resolves.toEqual({
        kind: 'refused',
      });
    });

    it.each([
      ['rejects', throwError(() => new Error('rejected'))],
      ['is transient', of<NativeTokenResult>({ kind: 'transient' })],
      ['is busy', of<NativeTokenResult>({ kind: 'busy' })],
      ['has no refresher', of<NativeTokenResult>({ kind: 'unavailable' })],
    ])(
      'starts on the stored copy with the marker when currentTokens %s',
      async (_name, answer) => {
        const { tokens, bridge } = setup(R2);
        bridge.currentTokens.mockReturnValue(answer);

        const prepared = await firstValueFrom(tokens.prepare(NO_COPY));

        expect(prepared).toEqual({
          kind: 'ready',
          session: { ...NO_COPY, refreshToken: NATIVE_REFRESH_MARKER },
        });
      },
    );

    it('leaves an OAuth session with no refresh token and no record unchanged', async () => {
      const { tokens, bridge } = setup();

      const prepared = await firstValueFrom(tokens.prepare(NO_COPY));

      expect(prepared).toEqual({ kind: 'ready', session: NO_COPY });
      expect(bridge.migrateTokens).not.toHaveBeenCalled();
    });

    it('does nothing off native or for a password account', () => {
      const offNative = setup();
      offNative.bridge.available = false;
      const emitted = vi.fn();

      offNative.tokens.prepare(SESSION).subscribe(emitted);

      // Synchronously, so the client's start keeps its timing there.
      expect(emitted).toHaveBeenCalledExactlyOnceWith({
        kind: 'ready',
        session: SESSION,
      });
      expect(offNative.bridge.migrateTokens).not.toHaveBeenCalled();
      expect(offNative.bridge.currentTokens).not.toHaveBeenCalled();
      TestBed.resetTestingModule();

      const password = setup();
      const session: MatrixSession = {
        baseUrl: 'https://hs',
        userId: USER,
        deviceId: 'D',
        accessToken: 'a0',
      };
      const passwordEmitted = vi.fn();

      password.tokens.prepare(session).subscribe(passwordEmitted);

      expect(passwordEmitted).toHaveBeenCalledExactlyOnceWith({
        kind: 'ready',
        session,
      });
      expect(password.bridge.currentTokens).not.toHaveBeenCalled();
    });

    it('a restart over an unreadable record removes nothing and keeps the copy', async () => {
      const { tokens, bridge, storage, state } = setup(R2);
      state.unreadable = true;

      const prepared = await firstValueFrom(tokens.prepare(SESSION));

      expect(bridge.removeTokens).not.toHaveBeenCalled();
      expect(storage.dropRefreshToken).not.toHaveBeenCalled();
      expect(state.record).toBe(R2);
      expect(prepared).toMatchObject({
        session: { refreshToken: NATIVE_REFRESH_MARKER },
      });
    });
  });

  describe('a sign-in', () => {
    const SIGN_IN: MatrixSession = {
      ...SESSION,
      accessToken: 'new-a',
      refreshToken: 'new-r',
      lineage: 'NEW',
    };

    it('a sign-in over an unreadable record replaces it', async () => {
      const { tokens, bridge, state } = setup(R2);
      state.unreadable = true;

      await firstValueFrom(tokens.removeUnreadableRecord(SIGN_IN));
      const prepared = await firstValueFrom(tokens.prepare(SIGN_IN));

      expect(bridge.removeTokens).toHaveBeenCalledExactlyOnceWith(USER);
      expect(state.record?.refreshToken).toBe('new-r');
      expect(prepared).toMatchObject({
        session: { accessToken: 'new-a', refreshToken: NATIVE_REFRESH_MARKER },
      });
      expect(state.jsCopy).toBe(false);
    });

    it('still completes when the removal fails', async () => {
      const { tokens, bridge, state } = setup(R2);
      state.unreadable = true;
      bridge.removeTokens.mockReturnValue(
        throwError(() => new Error('refused')),
      );
      const completed = vi.fn();

      tokens.removeUnreadableRecord(SIGN_IN).subscribe({ complete: completed });
      await vi.waitFor(() => expect(completed).toHaveBeenCalled());

      expect(bridge.removeTokens).toHaveBeenCalledOnce();
    });

    it('removes nothing over a readable record', async () => {
      const { tokens, bridge, state } = setup(R2);

      await firstValueFrom(tokens.removeUnreadableRecord(SIGN_IN));

      expect(bridge.removeTokens).not.toHaveBeenCalled();
      expect(state.record).toBe(R2);
    });

    it('an OAuth sign-in in the gap writes nothing to the vault', async () => {
      const { tokens, bridge, state } = setup();

      await firstValueFrom(tokens.removeUnreadableRecord(SIGN_IN));

      expect(bridge.migrateTokens).not.toHaveBeenCalled();
      expect(state.record).toBeUndefined();

      state.unreadable = true;
      await firstValueFrom(tokens.removeUnreadableRecord(SIGN_IN));

      expect(bridge.migrateTokens).not.toHaveBeenCalled();
      expect(state.record).toBeUndefined();
    });

    it.each([
      ['a busy vault answering gone', of<NativeTokenResult>({ kind: 'gone' })],
      ['a failed read', throwError(() => new Error('rejected'))],
    ])('removes nothing for %s', async (_name, answer) => {
      const { tokens, bridge } = setup(R2);
      bridge.currentTokens.mockReturnValue(answer);

      await firstValueFrom(tokens.removeUnreadableRecord(SIGN_IN));

      expect(bridge.removeTokens).not.toHaveBeenCalled();
    });

    it('a call that never answers does not hold the sign-in and removes nothing', async () => {
      vi.useFakeTimers();
      const { tokens, bridge } = setup(R2);
      bridge.currentTokens.mockReturnValue(NEVER);
      const completed = vi.fn();

      tokens.removeUnreadableRecord(SIGN_IN).subscribe({ complete: completed });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

      expect(completed).toHaveBeenCalledOnce();
      expect(bridge.removeTokens).not.toHaveBeenCalled();
    });

    it('does nothing with no refresh token, no endpoint, off native or for a password account', async () => {
      const { tokens, bridge } = setup(R2);

      await firstValueFrom(tokens.removeUnreadableRecord(NO_COPY));
      await firstValueFrom(
        tokens.removeUnreadableRecord({
          ...SIGN_IN,
          oidc: { issuer: 'https://op.example', clientId: 'c' },
        }),
      );
      await firstValueFrom(
        tokens.removeUnreadableRecord({ ...SIGN_IN, oidc: undefined }),
      );
      bridge.available = false;
      await firstValueFrom(tokens.removeUnreadableRecord(SIGN_IN));

      expect(bridge.currentTokens).not.toHaveBeenCalled();
    });
  });

  describe('detachedSession', () => {
    it('marks an OAuth session with no JS copy, on native', () => {
      const { tokens } = setup();

      expect(tokens.detachedSession(NO_COPY).refreshToken).toBe(
        NATIVE_REFRESH_MARKER,
      );
    });

    it('leaves a JS copy, a password account and off native alone', () => {
      const { tokens, bridge } = setup();
      const password: MatrixSession = { ...NO_COPY, oidc: undefined };

      expect(tokens.detachedSession(SESSION)).toBe(SESSION);
      expect(tokens.detachedSession(password)).toBe(password);
      bridge.available = false;
      expect(tokens.detachedSession(NO_COPY)).toBe(NO_COPY);
    });
  });

  describe('host', () => {
    it.each<[string, NativeTokenResult, unknown]>([
      [
        'rotated',
        { kind: 'rotated', accessToken: 'a1', accessTokenExpiresAt: 500 },
        {
          kind: 'tokens',
          accessToken: 'a1',
          expiry: new Date(500),
          granted: true,
        },
      ],
      [
        'rotated and unsaved',
        { kind: 'rotated', accessToken: 'a1', unsaved: true },
        { kind: 'tokens', accessToken: 'a1', granted: true },
      ],
      [
        'current',
        { kind: 'current', accessToken: 'a1', accessTokenExpiresAt: 500 },
        {
          kind: 'tokens',
          accessToken: 'a1',
          expiry: new Date(500),
          granted: false,
        },
      ],
      ['refused', { kind: 'refused' }, { kind: 'refused' }],
      ['gone', { kind: 'gone' }, { kind: 'refused' }],
      ['unavailable', { kind: 'unavailable' }, { kind: 'transient' }],
      ['busy', { kind: 'busy' }, { kind: 'transient' }],
      ['transient', { kind: 'transient' }, { kind: 'transient' }],
    ])(
      'maps each native answer to the SDK host answer: %s',
      async (_name, answer, mapped) => {
        const { tokens, bridge } = setup();
        bridge.refreshTokens.mockReturnValue(of(answer));

        const result = await tokens.host(SESSION).refresh('a0');

        expect(result).toEqual(mapped);
        expect(bridge.refreshTokens).toHaveBeenCalledExactlyOnceWith(
          USER,
          LINEAGE,
          'a0',
        );
      },
    );

    it('a rotated answer with no expiry carries none', async () => {
      const { tokens, bridge } = setup();
      bridge.refreshTokens.mockReturnValue(
        of({ kind: 'rotated', accessToken: 'a1' }),
      );

      const result = await tokens.host(SESSION).refresh('a0');

      expect(result).toMatchObject({ kind: 'tokens' });
      expect(result.kind === 'tokens' && result.expiry).toBeUndefined();
    });

    it('asks with an empty lineage for a session saved before lineages', async () => {
      const { tokens, bridge } = setup();
      const host = tokens.host({ ...NO_COPY, lineage: undefined });

      await host.refresh('a0');
      await host.current();
      await host.revoke();

      expect(bridge.refreshTokens).toHaveBeenCalledWith(USER, '', 'a0');
      expect(bridge.currentTokens).toHaveBeenCalledWith(USER, '');
      expect(bridge.revokeTokens).toHaveBeenCalledWith(USER, '');
    });

    it('a rejected refresh is transient, whatever made it fail', async () => {
      const { tokens, bridge } = setup();
      bridge.refreshTokens.mockReturnValue(
        throwError(() => new Error('UNIMPLEMENTED')),
      );

      await expect(tokens.host(SESSION).refresh('a0')).resolves.toEqual({
        kind: 'transient',
      });
    });

    it('a refresh that never answers is transient', async () => {
      vi.useFakeTimers();
      const { tokens, bridge } = setup();
      bridge.refreshTokens.mockReturnValue(NEVER);
      const settled = vi.fn();

      void tokens.host(SESSION).refresh('a0').then(settled);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toHaveBeenCalledWith({ kind: 'transient' });
    });

    it('current gives the pair for current and undefined for anything else', async () => {
      const { tokens, bridge } = setup();
      const host = tokens.host(SESSION);

      bridge.currentTokens.mockReturnValue(
        of({ kind: 'current', accessToken: 'a1', accessTokenExpiresAt: 500 }),
      );
      await expect(host.current()).resolves.toEqual({
        accessToken: 'a1',
        expiry: new Date(500),
      });

      bridge.currentTokens.mockReturnValue(
        of({ kind: 'current', accessToken: 'a1' }),
      );
      expect((await host.current())?.expiry).toBeUndefined();

      for (const kind of [
        'gone',
        'refused',
        'unavailable',
        'busy',
        'transient',
      ] as const) {
        bridge.currentTokens.mockReturnValue(of({ kind }));
        await expect(host.current()).resolves.toBeUndefined();
      }

      bridge.currentTokens.mockReturnValue(
        throwError(() => new Error('rejected')),
      );
      await expect(host.current()).resolves.toBeUndefined();
    });

    it('a current read that never answers is undefined', async () => {
      vi.useFakeTimers();
      const { tokens, bridge } = setup();
      bridge.currentTokens.mockReturnValue(NEVER);
      const settled = vi.fn();

      void tokens.host(SESSION).current().then(settled);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toHaveBeenCalledWith(undefined);
    });

    it('revokes: true when revoked, false when gone', async () => {
      const { tokens, bridge } = setup();
      const host = tokens.host(SESSION);

      bridge.revokeTokens.mockReturnValue(of({ kind: 'revoked' }));
      await expect(host.revoke()).resolves.toBe(true);

      bridge.revokeTokens.mockReturnValue(of({ kind: 'gone' }));
      await expect(host.revoke()).resolves.toBe(false);
    });

    it('throws from revoke on transient so the sign-out retries', async () => {
      const { tokens, bridge } = setup();
      bridge.revokeTokens.mockReturnValue(of({ kind: 'transient' }));

      await expect(tokens.host(SESSION).revoke()).rejects.toThrow();
    });

    it('throws from revoke on a rejected call', async () => {
      const { tokens, bridge } = setup();
      bridge.revokeTokens.mockReturnValue(
        throwError(() => new Error('UNIMPLEMENTED')),
      );

      await expect(tokens.host(SESSION).revoke()).rejects.toThrow();
    });

    it('throws from a revoke that never answers', async () => {
      vi.useFakeTimers();
      const { tokens, bridge } = setup();
      bridge.revokeTokens.mockReturnValue(NEVER);
      const failed = vi.fn();

      void tokens.host(SESSION).revoke().catch(failed);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(failed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(failed).toHaveBeenCalledOnce();
    });

    it('gone is transient while the only refresh token is a JS copy native never confirmed', async () => {
      const { tokens, bridge } = setup();
      bridge.migrateTokens.mockReturnValue(of(false));
      bridge.currentTokens.mockReturnValue(of({ kind: 'transient' }));
      const prepared = await firstValueFrom(tokens.prepare(SESSION));
      expect(prepared).toMatchObject({
        session: { refreshToken: NATIVE_REFRESH_MARKER },
      });
      bridge.refreshTokens.mockReturnValue(of({ kind: 'gone' }));

      await expect(tokens.host(SESSION).refresh('a0')).resolves.toEqual({
        kind: 'transient',
      });

      // The next start confirms the write, and gone means a lost vault again.
      bridge.migrateTokens.mockReturnValue(of(true));
      bridge.currentTokens.mockReturnValue(
        of({ kind: 'current', accessToken: 'a0' }),
      );
      await firstValueFrom(tokens.prepare(SESSION));
      await expect(tokens.host(SESSION).refresh('a0')).resolves.toEqual({
        kind: 'refused',
      });
    });

    it('keeps the refresh token out of every answer and every log', async () => {
      const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
        (level) => vi.spyOn(console, level).mockImplementation(() => undefined),
      );
      const { tokens, bridge } = setup();

      const prepared = await firstValueFrom(tokens.prepare(SESSION));
      const host = tokens.host(SESSION);
      bridge.refreshTokens.mockReturnValue(
        of({ kind: 'rotated', accessToken: 'a1' }),
      );
      const refreshed = await host.refresh('a0');
      const current = await host.current();
      bridge.revokeTokens.mockReturnValue(of({ kind: 'transient' }));
      const thrown = await host.revoke().catch((error: unknown) => error);

      const answers = JSON.stringify([
        prepared,
        refreshed,
        current,
        String(thrown),
      ]);
      expect(answers).not.toContain('r0');
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    });
  });

  describe('revokeStored', () => {
    it('emits true when native revoked and false on gone, a throw or a timeout', async () => {
      vi.useFakeTimers();
      const { tokens, bridge } = setup();

      bridge.revokeTokens.mockReturnValue(of({ kind: 'revoked' }));
      await expect(firstValueFrom(tokens.revokeStored(SESSION))).resolves.toBe(
        true,
      );

      bridge.revokeTokens.mockReturnValue(of({ kind: 'gone' }));
      await expect(firstValueFrom(tokens.revokeStored(SESSION))).resolves.toBe(
        false,
      );

      bridge.revokeTokens.mockReturnValue(of({ kind: 'transient' }));
      await expect(firstValueFrom(tokens.revokeStored(SESSION))).resolves.toBe(
        false,
      );

      bridge.revokeTokens.mockReturnValue(
        throwError(() => new Error('rejected')),
      );
      await expect(firstValueFrom(tokens.revokeStored(SESSION))).resolves.toBe(
        false,
      );

      bridge.revokeTokens.mockReturnValue(NEVER);
      const next = vi.fn();
      tokens.revokeStored(SESSION).subscribe(next);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(next).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(next).toHaveBeenCalledExactlyOnceWith(false);
    });
  });
});
