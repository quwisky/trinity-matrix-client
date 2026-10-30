import { ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionAccessToken,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { plainEqual } from '@trinity/util/matrix';
import {
  PushHandoffBridge,
  type BackgroundWork,
} from '@trinity/capacitor-push';
import {
  BehaviorSubject,
  NEVER,
  Subject,
  defer,
  distinctUntilChanged,
  firstValueFrom,
  of,
  take,
  throwError,
  type Observable,
  type Subscription,
} from 'rxjs';
import type { NotificationTextMode } from './notification-text.port';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNotificationEngine } from '../contract/fake-notification-engine';
import type { PushRoom } from './notification-engine';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import {
  BACKGROUND_REFRESH_GRANT_TIMEOUT_MS,
  BACKGROUND_REFRESH_MIN_AGE_MS,
  BACKGROUND_REFRESH_TIMEOUT_MS,
  BACKGROUND_RUN_DEADLINE_MS,
  PushHandoffService,
} from './push-handoff.service';

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({})),
  Capacitor: {
    getPlatform: () => 'web',
    isNativePlatform: () => false,
    isPluginAvailable: () => false,
  },
}));

/** The fake engine's account with settings and `m.direct`. */
const ME = '@alice:fake';
const PW = '@pw:fake';
const TEAM = { roomId: '!a:hs', name: 'Team', direct: false, encrypted: false };

function status(accountId: string, generation: number): SessionAccountStatus {
  return {
    accountId,
    deviceId: 'DEVICE',
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

/** Background time granted with the given id; protected data available unless overridden. */
function grant(
  id: number,
  state: Partial<BackgroundWork> = {},
): BackgroundWork {
  return { id, protectedDataAvailable: true, locking: false, ...state };
}

/**
 * The fake engine with one room, `Team`, every account is in; a session whose accounts each
 * hold a token that expires at `expiresAt`.
 */
function setup(
  opts: {
    available?: boolean;
    accounts?: string[];
    expiresAt?: number | null;
    refreshable?: boolean;
  } = {},
) {
  const engine = new FakeNotificationEngine();
  engine.createRoom('Team', { roomId: TEAM.roomId });
  const snapshot = signal<SessionSnapshot>(EMPTY_SESSION);
  const tokens = new Map<string, BehaviorSubject<SessionAccessToken | null>>();
  const tokenOf = (accountId: string) => {
    let token = tokens.get(accountId);
    if (!token)
      tokens.set(
        accountId,
        (token = new BehaviorSubject<SessionAccessToken | null>(null)),
      );
    return token;
  };
  /** The session's token for the account changes, as a refresh or a new sign-in leaves it. */
  const setToken = (
    accountId: string,
    patch: Partial<SessionAccessToken>,
  ): void => {
    const current = tokenOf(accountId).value as SessionAccessToken;
    tokenOf(accountId).next({ ...current, ...patch });
  };
  /** The live accounts, each at generation 1 unless given; a new generation is a new sign-in. */
  const setAccounts = (
    ids: readonly string[],
    generations: Record<string, number> = {},
  ): void => {
    for (const id of ids) engine.live.add(id);
    snapshot.set({
      ...EMPTY_SESSION,
      activeAccountId: ids[0] ?? null,
      accounts: ids.map((id) => status(id, generations[id] ?? 1)),
    });
  };
  const accounts = opts.accounts ?? [ME];
  for (const id of accounts) {
    tokenOf(id).next({
      homeserverUrl: 'https://hs.example',
      accessToken: `token-${id}`,
      expiresAt: opts.expiresAt ?? null,
      refreshable: opts.refreshable ?? true,
    });
  }
  setAccounts(accounts);
  const bridge = {
    available: opts.available ?? true,
    setAccount: vi.fn((): Observable<void> => of(void 0)),
    setRooms: vi.fn((): Observable<void> => of(void 0)),
    removeAccount: vi.fn((): Observable<void> => of(void 0)),
    clear: vi.fn((): Observable<void> => of(void 0)),
    clearRoom: vi.fn((): Observable<void> => of(void 0)),
    beginBackgroundWork: vi.fn((): Observable<BackgroundWork> => of(grant(7))),
    endBackgroundWork: vi.fn((_id: number): Observable<void> => of(void 0)),
    setNotificationText: vi.fn(
      (_mode: NotificationTextMode): Observable<void> => of(void 0),
    ),
    clearDelivered: vi.fn((): Observable<void> => of(void 0)),
  };
  const refresh = vi.fn(
    (_userId: string, _options?: { timeoutMs?: number }): Observable<boolean> =>
      of(true),
  );
  TestBed.configureTestingModule({
    providers: [
      PushHandoffService,
      { provide: NOTIFICATION_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: snapshot },
      {
        provide: SESSION_ENGINE,
        useValue: {
          accessToken: (accountId: string) =>
            tokenOf(accountId).pipe(
              distinctUntilChanged<SessionAccessToken | null>(plainEqual),
            ),
          refreshAccessToken: refresh,
        },
      },
      { provide: PushHandoffBridge, useValue: bridge },
    ],
  });
  return {
    service: TestBed.inject(PushHandoffService),
    engine,
    tokens,
    setToken,
    setAccounts,
    bridge,
    refresh,
  };
}

/** Let the serialized bridge queue settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve));

async function start(h: ReturnType<typeof setup>): Promise<Subscription> {
  const lifetime = h.service.run().subscribe();
  TestBed.tick();
  await flush();
  return lifetime;
}

/** The accounts refreshed so far, in order. */
const refreshed = (h: ReturnType<typeof setup>) =>
  h.refresh.mock.calls.map(([userId]) => userId);

describe('PushHandoffService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('notification text', () => {
    it('mirrors the notification text and clears delivered notifications in order', async () => {
      const h = setup();
      await firstValueFrom(h.service.writeNotificationText('always-hide'), {
        defaultValue: undefined,
      });
      await firstValueFrom(h.service.clearDelivered(), {
        defaultValue: undefined,
      });
      expect(h.bridge.setNotificationText).toHaveBeenCalledWith('always-hide');
      expect(h.bridge.clearDelivered).toHaveBeenCalledOnce();
      expect(
        h.bridge.setNotificationText.mock.invocationCallOrder[0],
      ).toBeLessThan(h.bridge.clearDelivered.mock.invocationCallOrder[0]);
    });

    it('queues the mirror after earlier writes', async () => {
      const h = setup();
      const gate = new Subject<void>();
      h.bridge.removeAccount.mockReturnValueOnce(gate.pipe(take(1)));
      const forgetting = firstValueFrom(h.service.forget(ME), {
        defaultValue: undefined,
      });
      const writing = firstValueFrom(
        h.service.writeNotificationText('hide-on-lock-screen'),
        { defaultValue: undefined },
      );
      await flush();
      expect(h.bridge.removeAccount).toHaveBeenCalledOnce();
      expect(h.bridge.setNotificationText).not.toHaveBeenCalled();
      gate.next();
      await Promise.all([forgetting, writing]);
      expect(h.bridge.setNotificationText).toHaveBeenCalledWith(
        'hide-on-lock-screen',
      );
    });

    it('writes the mirrored text again after emptying the store', async () => {
      const h = setup();
      await firstValueFrom(h.service.writeNotificationText('always-hide'), {
        defaultValue: undefined,
      });
      await firstValueFrom(h.service.forget());
      expect(h.bridge.clear).toHaveBeenCalledOnce();
      expect(h.bridge.setNotificationText).toHaveBeenLastCalledWith(
        'always-hide',
      );
      expect(h.bridge.setNotificationText).toHaveBeenCalledTimes(2);
      expect(h.bridge.clear.mock.invocationCallOrder[0]).toBeLessThan(
        h.bridge.setNotificationText.mock.invocationCallOrder[1],
      );
    });

    it('reports a mirror it could not write again after emptying the store', async () => {
      const h = setup();
      const lost: void[] = [];
      h.service.notificationTextLost.subscribe(() => lost.push(undefined));
      await firstValueFrom(h.service.writeNotificationText('always-hide'), {
        defaultValue: undefined,
      });
      h.bridge.setNotificationText.mockReturnValueOnce(
        throwError(() => new Error('refused')),
      );
      await firstValueFrom(h.service.forget());
      await flush();
      expect(h.bridge.setNotificationText).toHaveBeenCalledTimes(2);
      expect(lost).toHaveLength(1);
    });

    it('writes nothing after emptying the store when it never mirrored', async () => {
      const h = setup();
      await firstValueFrom(h.service.forget());
      expect(h.bridge.setNotificationText).not.toHaveBeenCalled();
    });

    it('is inert without the native store', async () => {
      const h = setup({ available: false });
      await firstValueFrom(h.service.writeNotificationText('always-hide'), {
        defaultValue: undefined,
      });
      await firstValueFrom(h.service.clearDelivered(), {
        defaultValue: undefined,
      });
      expect(h.bridge.setNotificationText).not.toHaveBeenCalled();
      expect(h.bridge.clearDelivered).not.toHaveBeenCalled();
    });
  });

  it('writes an account when it signs in', async () => {
    const h = setup();
    await start(h);

    expect(h.bridge.setAccount).toHaveBeenCalledWith({
      userId: ME,
      homeserverUrl: 'https://hs.example',
      accessToken: `token-${ME}`,
      sound: true,
    });
  });

  it('rewrites the account with the refreshed access token', async () => {
    const h = setup();
    await start(h);

    h.setToken(ME, { accessToken: 'fresh' });
    await flush();

    expect(h.bridge.setAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: ME, accessToken: 'fresh' }),
    );
  });

  it('hands the access-token expiry over with the token it belongs to', async () => {
    const h = setup({ expiresAt: 1_760_000_000_000 });
    await start(h);

    expect(h.bridge.setAccount).toHaveBeenCalledWith({
      userId: ME,
      homeserverUrl: 'https://hs.example',
      accessToken: `token-${ME}`,
      sound: true,
      accessTokenExpiresAt: 1_760_000_000_000,
    });
  });

  it('writes a refreshed token with its own expiry', async () => {
    const h = setup();
    await start(h);

    h.setToken(ME, { accessToken: 'fresh', expiresAt: 1_760_000_300_000 });
    await flush();

    expect(h.bridge.setAccount).toHaveBeenLastCalledWith({
      userId: ME,
      homeserverUrl: 'https://hs.example',
      accessToken: 'fresh',
      sound: true,
      accessTokenExpiresAt: 1_760_000_300_000,
    });
  });

  it('hands over no expiry for a token without one', async () => {
    const h = setup({ expiresAt: 1_760_000_000_000 });
    await start(h);

    h.setToken(ME, { accessToken: 'stale', expiresAt: null });
    await flush();

    expect(h.bridge.setAccount).toHaveBeenLastCalledWith({
      userId: ME,
      homeserverUrl: 'https://hs.example',
      accessToken: 'stale',
      sound: true,
    });
  });

  it('writes joined room names and DM and encryption flags as one batch', async () => {
    const h = setup();
    const dm = h.engine.createRoom('Bob', { roomId: '!dm:hs' });
    h.engine.createRoom('Secret', { roomId: '!s:hs', encrypted: true });
    h.engine.writeAccountData('m.direct', { '@bob:hs': [dm] });
    await start(h);

    expect(h.bridge.setRooms).toHaveBeenCalledOnce();
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith(ME, [
      TEAM,
      { roomId: '!dm:hs', name: 'Bob', direct: true, encrypted: false },
      { roomId: '!s:hs', name: 'Secret', direct: false, encrypted: true },
    ]);
  });

  it('rewrites a room whose encryption or DM flag changed', async () => {
    const h = setup();
    const rooms = new Subject<readonly PushRoom[]>();
    vi.spyOn(h.engine, 'pushRooms').mockReturnValue(rooms);
    await start(h);

    rooms.next([TEAM]);
    rooms.next([{ ...TEAM, encrypted: true }]);
    rooms.next([{ ...TEAM, encrypted: true, direct: true }]);
    await flush();

    expect(h.bridge.setRooms.mock.calls).toEqual([
      [ME, [TEAM]],
      [ME, [{ ...TEAM, encrypted: true }]],
      [ME, [{ ...TEAM, encrypted: true, direct: true }]],
    ]);
  });

  it('writes only what a sync or rename changed, and nothing for a quiet sync', async () => {
    const h = setup();
    await start(h);
    h.bridge.setRooms.mockClear();

    h.engine.syncRooms();
    await flush();
    expect(h.bridge.setRooms).not.toHaveBeenCalled();

    h.engine.renameRoom(TEAM.roomId, 'Renamed');
    await flush();
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith(ME, [
      { ...TEAM, name: 'Renamed' },
    ]);

    h.engine.createRoom('New', { roomId: '!b:hs' });
    await flush();
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith(ME, [
      { roomId: '!b:hs', name: 'New', direct: false, encrypted: false },
    ]);
  });

  it('retries rooms whose write failed at the next sync', async () => {
    const h = setup();
    await start(h);
    h.bridge.setRooms.mockReturnValueOnce(
      throwError(() => new Error('keychain locked')),
    );
    h.engine.renameRoom(TEAM.roomId, 'Renamed');
    await flush();
    h.bridge.setRooms.mockClear();

    h.engine.syncRooms();
    await flush();

    expect(h.bridge.setRooms).toHaveBeenCalledOnce();
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith(ME, [
      { ...TEAM, name: 'Renamed' },
    ]);
  });

  it('rewrites the account when its sound setting changes', async () => {
    const h = setup();
    await start(h);

    await firstValueFrom(h.engine.setPreference(ME, 'sound', false));
    await flush();

    expect(h.bridge.setAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: ME, sound: false }),
    );
  });

  it('reports a faulted account stream to the error handler', async () => {
    const h = setup();
    const handleError = vi
      .spyOn(TestBed.inject(ErrorHandler), 'handleError')
      .mockImplementation(() => undefined);
    await start(h);
    const fault = new Error('token store gone');

    h.tokens.get(ME)?.error(fault);

    expect(handleError).toHaveBeenCalledWith(fault);
  });

  it('does not write an account again after forgetting it, until it signs in again', async () => {
    const h = setup();
    await start(h);
    h.bridge.setAccount.mockClear();
    h.bridge.setRooms.mockClear();

    await firstValueFrom(h.service.forget(ME));
    expect(h.bridge.removeAccount).toHaveBeenCalledWith(ME);

    // Late events while sign-out is still running must not recreate the entry.
    h.engine.renameRoom(TEAM.roomId, 'Late rename');
    h.engine.syncRooms();
    h.setToken(ME, { accessToken: 'late' });
    await flush();
    expect(h.bridge.setAccount).not.toHaveBeenCalled();
    expect(h.bridge.setRooms).not.toHaveBeenCalled();

    // Signed out, then signed in again: written afresh.
    h.setAccounts([]);
    TestBed.tick();
    h.setAccounts([ME]);
    TestBed.tick();
    await flush();
    expect(h.bridge.setAccount).toHaveBeenCalledOnce();
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith(ME, [
      { ...TEAM, name: 'Late rename' },
    ]);
  });

  it('writes a signed-in-again account afresh when only its session generation changed', async () => {
    const h = setup();
    await start(h);
    await firstValueFrom(h.service.forget());
    h.bridge.setAccount.mockClear();

    // Replacing every live account with the same user: a new session under the same id,
    // with no change of the id list observed in between.
    h.setToken(ME, { accessToken: 'new-session' });
    h.setAccounts([ME], { [ME]: 2 });
    TestBed.tick();
    await flush();

    expect(h.bridge.setAccount).toHaveBeenCalledOnce();
    expect(h.bridge.setAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'new-session' }),
    );
  });

  it('writes nothing for an account whose session was replaced while it was being forgotten', async () => {
    const h = setup();
    await start(h);
    h.bridge.setAccount.mockClear();
    h.bridge.setRooms.mockClear();

    // A re-authentication replaced the session, and sign-out began before the handoff
    // observed the change.
    h.setAccounts([ME], { [ME]: 2 });
    await firstValueFrom(h.service.forget(ME));
    h.setToken(ME, { accessToken: 'swapped-session' });
    TestBed.tick();
    await flush();
    h.engine.syncRooms();
    h.engine.renameRoom(TEAM.roomId, 'Late rename');
    h.setToken(ME, { accessToken: 'late' });
    await flush();

    expect(h.bridge.removeAccount).toHaveBeenCalledWith(ME);
    expect(h.bridge.setAccount).not.toHaveBeenCalled();
    expect(h.bridge.setRooms).not.toHaveBeenCalled();

    // A genuinely new sign-in afterwards is written again.
    h.setToken(ME, { accessToken: 'new-session' });
    h.setAccounts([ME], { [ME]: 3 });
    TestBed.tick();
    await flush();
    expect(h.bridge.setAccount).toHaveBeenCalledOnce();
    expect(h.bridge.setAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'new-session' }),
    );
  });

  it('writes an account signed in again after the session ended during its sign-out', async () => {
    const h = setup();
    const lifetime = await start(h);
    await firstValueFrom(h.service.forget(ME));
    // The session ends before it sees the account leave.
    lifetime.unsubscribe();
    h.bridge.setAccount.mockClear();

    h.setToken(ME, { accessToken: 'new-session' });
    h.setAccounts([ME], { [ME]: 2 });
    await start(h);

    expect(h.bridge.setAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'new-session' }),
    );
  });

  it('keeps a forgotten account unwritten when a new session finds it still live', async () => {
    const h = setup();
    const lifetime = await start(h);
    await firstValueFrom(h.service.forget(ME));
    lifetime.unsubscribe();
    h.bridge.setAccount.mockClear();
    h.bridge.setRooms.mockClear();

    await start(h);
    h.engine.syncRooms();
    await flush();

    expect(h.bridge.setAccount).not.toHaveBeenCalled();
    expect(h.bridge.setRooms).not.toHaveBeenCalled();
  });

  it('removes an account only after a write already in flight settles', async () => {
    const h = setup();
    const inFlight = new Subject<void>();
    h.bridge.setAccount.mockReturnValueOnce(inFlight);
    await start(h);

    const forgotten = firstValueFrom(h.service.forget(ME));
    await flush();
    expect(h.bridge.removeAccount).not.toHaveBeenCalled();

    inFlight.next();
    inFlight.complete();
    await forgotten;
    expect(h.bridge.removeAccount).toHaveBeenCalledWith(ME);
  });

  it('reports a removal the native store refused', async () => {
    const h = setup();
    h.bridge.removeAccount.mockReturnValue(
      throwError(() => new Error('keychain locked')),
    );
    await start(h);

    await expect(firstValueFrom(h.service.forget(ME))).rejects.toThrow(
      'keychain locked',
    );
  });

  it('empties the whole store for clear-all-data and stops writing every account', async () => {
    const h = setup();
    await start(h);
    h.bridge.setRooms.mockClear();

    await firstValueFrom(h.service.forget());
    h.engine.renameRoom(TEAM.roomId, 'Late rename');
    await flush();

    expect(h.bridge.clear).toHaveBeenCalledOnce();
    expect(h.bridge.removeAccount).not.toHaveBeenCalled();
    expect(h.bridge.setRooms).not.toHaveBeenCalled();
  });

  it('writes nothing on web or desktop', async () => {
    const h = setup({ available: false });
    await start(h);
    h.engine.syncRooms();
    await firstValueFrom(h.service.forget(ME));
    await firstValueFrom(h.service.forget());
    await firstValueFrom(h.service.clearRoom(ME, TEAM.roomId));
    await flush();

    for (const method of [
      h.bridge.setAccount,
      h.bridge.setRooms,
      h.bridge.removeAccount,
      h.bridge.clear,
      h.bridge.clearRoom,
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("clears an opened room's delivered notifications through the bridge", async () => {
    const h = setup();

    await firstValueFrom(h.service.clearRoom(ME, TEAM.roomId));

    expect(h.bridge.clearRoom).toHaveBeenCalledOnce();
    expect(h.bridge.clearRoom).toHaveBeenCalledWith(ME, TEAM.roomId);
  });

  it('completes quietly when the native side cannot clear a room', async () => {
    const h = setup();
    h.bridge.clearRoom.mockReturnValue(
      throwError(() => new Error('notification center unavailable')),
    );

    await expect(
      firstValueFrom(h.service.clearRoom(ME, TEAM.roomId)),
    ).resolves.toBeUndefined();
  });

  it('stops following every account when its lifetime ends', async () => {
    const h = setup();
    const lifetime = await start(h);
    expect(h.tokens.get(ME)?.observed).toBe(true);
    h.bridge.setAccount.mockClear();
    h.bridge.setRooms.mockClear();

    lifetime.unsubscribe();
    h.engine.renameRoom(TEAM.roomId, 'Renamed');
    await firstValueFrom(h.engine.setPreference(ME, 'sound', false));
    await flush();

    expect(h.tokens.get(ME)?.observed).toBe(false);
    expect(h.bridge.setAccount).not.toHaveBeenCalled();
    expect(h.bridge.setRooms).not.toHaveBeenCalled();
  });

  describe('refreshBeforeBackground', () => {
    afterEach(() => vi.useRealTimers());

    it('refreshes each account whose token expires, and no other', async () => {
      const h = setup({ accounts: [ME, PW] });
      h.setToken(ME, { expiresAt: Date.now() + 300_000 });
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(refreshed(h)).toEqual([ME]);
    });

    it('skips an account whose token rotated within the last minute', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_000_000);
      const h = setup({ expiresAt: 1_300_000 });
      await start(h);
      h.setToken(ME, { accessToken: 'rotated' });
      await flush();

      vi.setSystemTime(1_000_000 + BACKGROUND_REFRESH_MIN_AGE_MS - 1);
      await firstValueFrom(h.service.refreshBeforeBackground());
      expect(h.refresh).not.toHaveBeenCalled();

      vi.setSystemTime(1_000_000 + BACKGROUND_REFRESH_MIN_AGE_MS);
      await firstValueFrom(h.service.refreshBeforeBackground());
      expect(refreshed(h)).toEqual([ME]);
    });

    it("does not let one account's rotation suppress another's refresh", async () => {
      const h = setup({ accounts: [ME, PW], expiresAt: Date.now() + 300_000 });
      await start(h);
      h.setToken(ME, { accessToken: 'rotated' });
      await flush();

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(refreshed(h)).toEqual([PW]);
    });

    it('forgets a recent rotation when the account leaves and is added again', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      h.setToken(ME, { accessToken: 'rotated' });
      await flush();
      h.setAccounts([]);
      TestBed.tick();
      h.setAccounts([ME]);
      TestBed.tick();
      await flush();

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(refreshed(h)).toEqual([ME]);
    });

    it('ignores a rotation that arrives after the account left', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      h.setAccounts([]);
      TestBed.tick();
      h.setToken(ME, { accessToken: 'late' });
      h.setAccounts([ME]);
      TestBed.tick();
      await flush();

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(refreshed(h)).toEqual([ME]);
    });

    it('refreshes nothing off a native host', async () => {
      const h = setup({ available: false, expiresAt: Date.now() + 300_000 });
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(h.refresh).not.toHaveBeenCalled();
    });

    it('does not refresh an account whose sign-out began', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      await firstValueFrom(h.service.forget(ME));

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(h.refresh).not.toHaveBeenCalled();
    });

    it('completes even when a refresh fails', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      h.refresh.mockReturnValue(throwError(() => new Error('offline')));
      await start(h);

      await expect(
        firstValueFrom(h.service.refreshBeforeBackground()),
      ).resolves.toBeUndefined();
    });

    /** RxJS schedules its timeouts with setInterval. */
    const useFakeTimers = () =>
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });

    /** A refresh that rotates: its store write is queued before it resolves, as in the SDK. */
    function rotating(h: ReturnType<typeof setup>) {
      return (userId: string): Observable<boolean> =>
        defer(() => {
          h.setToken(userId, { accessToken: `new-${userId}` });
          return of(true);
        });
    }

    /** Subscribe and record how the action ended. */
    function watch(action: Observable<void>) {
      const outcome = { done: false, error: undefined as unknown };
      const subscription = action.subscribe({
        complete: () => (outcome.done = true),
        error: (error: unknown) => (outcome.error = error),
      });
      return { outcome, subscription };
    }

    it('gives up on a hung refresh after the bound, without an error, and refreshes again next time', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      useFakeTimers();
      h.refresh.mockReturnValueOnce(NEVER);

      const { outcome } = watch(h.service.refreshBeforeBackground());
      await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_TIMEOUT_MS - 1);
      expect(outcome.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toEqual({ done: true, error: undefined });

      // The action is finite, so the next background event is not held off by the hung one.
      const next = watch(h.service.refreshBeforeBackground());
      await vi.advanceTimersByTimeAsync(0);
      expect(next.outcome).toEqual({ done: true, error: undefined });
      expect(refreshed(h)).toEqual([ME, ME]);
    });

    it('finishes the other accounts in a run where one refresh hangs', async () => {
      const h = setup({ accounts: [ME, PW], expiresAt: Date.now() + 300_000 });
      await start(h);
      h.bridge.setAccount.mockClear();
      useFakeTimers();
      const rotate = rotating(h);
      h.refresh.mockImplementation((userId) =>
        userId === ME ? NEVER : rotate(userId),
      );

      const { outcome } = watch(h.service.refreshBeforeBackground());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.bridge.setAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: PW,
          accessToken: `new-${PW}`,
        }),
      );
      expect(outcome.done).toBe(false);

      await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_TIMEOUT_MS);
      expect(outcome).toEqual({ done: true, error: undefined });
      expect(refreshed(h)).toEqual([ME, PW]);
    });

    it('holds background time from before the refresh until its store write has landed, and completes after the release', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      const order: string[] = [];
      h.bridge.beginBackgroundWork.mockImplementation(() =>
        defer(() => {
          order.push('begin');
          return of(grant(7));
        }),
      );
      const write = new Subject<void>();
      h.bridge.setAccount.mockImplementation(() => {
        order.push('write');
        return write;
      });
      const released = new Subject<void>();
      h.bridge.endBackgroundWork.mockImplementation((id) =>
        defer(() => {
          order.push(`end ${id}`);
          return released;
        }),
      );
      const rotate = rotating(h);
      h.refresh.mockImplementation((userId) => {
        order.push('refresh');
        return rotate(userId);
      });

      const { outcome } = watch(h.service.refreshBeforeBackground());
      await flush();
      expect(order).toEqual(['begin', 'refresh', 'write']);
      expect(outcome.done).toBe(false);

      write.next();
      write.complete();
      await flush();
      expect(order).toEqual(['begin', 'refresh', 'write', 'end 7']);
      expect(outcome.done).toBe(false);

      released.next();
      released.complete();
      await flush();

      expect(outcome).toEqual({ done: true, error: undefined });
      expect(h.bridge.beginBackgroundWork).toHaveBeenCalledOnce();
      expect(h.bridge.endBackgroundWork).toHaveBeenCalledOnce();
    });

    it('completes by the run deadline when background time is never granted, and still ends a late grant', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      useFakeTimers();
      const granted = new Subject<BackgroundWork>();
      h.bridge.beginBackgroundWork.mockReturnValue(granted);

      const { outcome } = watch(h.service.refreshBeforeBackground());
      await vi.advanceTimersByTimeAsync(BACKGROUND_RUN_DEADLINE_MS - 1);
      expect(outcome.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toEqual({ done: true, error: undefined });
      expect(h.refresh).not.toHaveBeenCalled();

      granted.next(grant(9));
      granted.complete();
      await vi.advanceTimersByTimeAsync(0);

      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[9]]);
    });

    it('cuts a run whose refresh and store write both hang off at the run deadline', async () => {
      const h = setup({ accounts: [ME, PW], expiresAt: Date.now() + 300_000 });
      await start(h);
      useFakeTimers();
      h.bridge.setAccount.mockReturnValue(NEVER);
      const rotate = rotating(h);
      h.refresh.mockImplementation((userId) =>
        userId === ME ? NEVER : rotate(userId),
      );

      const { outcome } = watch(h.service.refreshBeforeBackground());
      await vi.advanceTimersByTimeAsync(BACKGROUND_RUN_DEADLINE_MS - 1);
      expect(outcome.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(outcome).toEqual({ done: true, error: undefined });
      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[7]]);
    });

    it('releases background time when the refresh gives up', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      useFakeTimers();
      h.refresh.mockReturnValue(NEVER);

      watch(h.service.refreshBeforeBackground());
      await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_TIMEOUT_MS - 1);
      expect(h.bridge.endBackgroundWork).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(h.bridge.beginBackgroundWork).toHaveBeenCalledOnce();
      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[7]]);
    });

    it('stops waiting for a store write that never lands, and releases background time', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      useFakeTimers();
      h.bridge.setAccount.mockReturnValue(NEVER);
      h.refresh.mockImplementation(rotating(h));

      const { outcome } = watch(h.service.refreshBeforeBackground());
      await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_TIMEOUT_MS - 1);
      expect(outcome.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(outcome).toEqual({ done: true, error: undefined });
      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[7]]);
    });

    it('releases background time when the action is unsubscribed', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      h.refresh.mockReturnValue(NEVER);

      const { subscription } = watch(h.service.refreshBeforeBackground());
      await flush();
      expect(h.bridge.endBackgroundWork).not.toHaveBeenCalled();
      subscription.unsubscribe();
      await flush();

      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[7]]);
    });

    it('releases background time granted only after the action was unsubscribed', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      const granted = new Subject<BackgroundWork>();
      h.bridge.beginBackgroundWork.mockReturnValue(granted);

      const { subscription } = watch(h.service.refreshBeforeBackground());
      subscription.unsubscribe();
      granted.next(grant(9));
      granted.complete();
      await flush();

      expect(h.refresh).not.toHaveBeenCalled();
      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[9]]);
    });

    it('still refreshes when the host grants no background time', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      h.bridge.beginBackgroundWork.mockReturnValue(
        throwError(() => new Error('no background time')),
      );

      await expect(
        firstValueFrom(h.service.refreshBeforeBackground()),
      ).resolves.toBeUndefined();

      expect(refreshed(h)).toEqual([ME]);
      expect(h.bridge.endBackgroundWork).not.toHaveBeenCalled();
    });

    it('bounds the token grant of every refresh it starts', async () => {
      const h = setup({ accounts: [ME, PW], expiresAt: Date.now() + 300_000 });
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(h.refresh.mock.calls).toEqual([
        [ME, { timeoutMs: BACKGROUND_REFRESH_GRANT_TIMEOUT_MS }],
        [PW, { timeoutMs: BACKGROUND_REFRESH_GRANT_TIMEOUT_MS }],
      ]);
      // Inside the roughly 10 s iOS keeps the session's keychain items writable after a lock.
      expect(BACKGROUND_REFRESH_GRANT_TIMEOUT_MS).toBeLessThan(10_000);
    });

    it('refreshes nothing when protected data is unavailable, and still releases background time', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      h.bridge.beginBackgroundWork.mockReturnValue(
        of(grant(7, { protectedDataAvailable: false })),
      );

      await expect(
        firstValueFrom(h.service.refreshBeforeBackground()),
      ).resolves.toBeUndefined();

      expect(h.refresh).not.toHaveBeenCalled();
      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[7]]);
    });

    it('refreshes nothing while the device is locking, and still releases background time', async () => {
      const h = setup({ expiresAt: Date.now() + 300_000 });
      await start(h);
      h.bridge.beginBackgroundWork.mockReturnValue(
        of(grant(7, { locking: true })),
      );

      await expect(
        firstValueFrom(h.service.refreshBeforeBackground()),
      ).resolves.toBeUndefined();

      expect(h.refresh).not.toHaveBeenCalled();
      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[7]]);

      // The next background event, with the device unlocked, refreshes again.
      h.bridge.beginBackgroundWork.mockReturnValue(of(grant(8)));
      await firstValueFrom(h.service.refreshBeforeBackground());
      expect(refreshed(h)).toEqual([ME]);
      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[7], [8]]);
    });

    it('starts every due refresh as soon as background time is granted, so a lock that follows finds none left to start', async () => {
      const h = setup({ accounts: [ME, PW], expiresAt: Date.now() + 300_000 });
      await start(h);
      useFakeTimers();
      const granted = new Subject<BackgroundWork>();
      h.bridge.beginBackgroundWork.mockReturnValue(granted);
      h.refresh.mockReturnValue(NEVER);

      const { outcome } = watch(h.service.refreshBeforeBackground());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.refresh).not.toHaveBeenCalled();

      granted.next(grant(7));
      granted.complete();
      // Microtasks only: no timer, bridge event or other task runs in between.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(refreshed(h)).toEqual([ME, PW]);

      // A lock now can stop nothing further; the run ends with its bounds and releases.
      await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_TIMEOUT_MS);
      expect(outcome).toEqual({ done: true, error: undefined });
      expect(refreshed(h)).toEqual([ME, PW]);
      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[7]]);
    });

    it('asks for no background time when no account is due', async () => {
      const h = setup();
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(h.refresh).not.toHaveBeenCalled();
      expect(h.bridge.beginBackgroundWork).not.toHaveBeenCalled();
      expect(h.bridge.endBackgroundWork).not.toHaveBeenCalled();
    });

    it('asks for no background time when no due account can refresh', async () => {
      const h = setup({
        accounts: [ME, PW],
        expiresAt: Date.now() + 300_000,
        refreshable: false,
      });
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(h.refresh).not.toHaveBeenCalled();
      expect(h.bridge.beginBackgroundWork).not.toHaveBeenCalled();
      expect(h.bridge.endBackgroundWork).not.toHaveBeenCalled();
    });

    it('refreshes only the accounts that can refresh', async () => {
      const h = setup({ accounts: [ME, PW], expiresAt: Date.now() + 300_000 });
      h.setToken(ME, { refreshable: false });
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(refreshed(h)).toEqual([PW]);
      expect(h.bridge.beginBackgroundWork).toHaveBeenCalledOnce();
    });

    it('asks for no background time off a native host', async () => {
      const h = setup({ available: false, expiresAt: Date.now() + 300_000 });
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(h.bridge.beginBackgroundWork).not.toHaveBeenCalled();
      expect(h.bridge.endBackgroundWork).not.toHaveBeenCalled();
    });
  });
});
