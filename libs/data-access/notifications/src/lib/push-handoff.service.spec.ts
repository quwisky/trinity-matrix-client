import { EventEmitter } from 'node:events';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClientEvent, EventType, RoomEvent, SyncState } from 'matrix-js-sdk';
import {
  MatrixClientService,
  type AccessTokenRotation,
} from '@trinity/data-access/matrix-client';
import {
  PushHandoffBridge,
  type BackgroundWork,
} from '@trinity/capacitor-push';
import { MockProvider } from 'ng-mocks';
import {
  NEVER,
  Subject,
  defer,
  firstValueFrom,
  of,
  take,
  throwError,
  type Observable,
  type Subscription,
} from 'rxjs';
import type { NotificationTextMode } from './notification-text.port';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_SOUND_EVENT,
  NotificationSoundService,
} from './notification-sound.service';
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

interface FakeRoom {
  roomId: string;
  name: string;
  membership: string;
  /** Whether the room's state holds `m.room.encryption`. */
  encryptionState?: boolean;
}

/** The parts of one account's MatrixClient the handoff reads, with a real event emitter. */
function fakeClient(userId: string, rooms: FakeRoom[]) {
  const events = new EventEmitter();
  const state = {
    token: `token-${userId}`,
    rooms,
    direct: {} as Record<string, string[]>,
    /** What the crypto store answers per room; unlisted rooms are not encrypted. */
    storeEncrypted: {} as Record<string, boolean>,
  };
  return {
    userId,
    state,
    emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
    listeners: () => events.eventNames().length,
    on: (event: string, listener: (...args: unknown[]) => void) =>
      events.on(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) =>
      events.off(event, listener),
    getAccessToken: () => state.token,
    getHomeserverUrl: () => 'https://hs.example',
    getRooms: () =>
      state.rooms.map((room) => ({
        roomId: room.roomId,
        name: room.name,
        getMyMembership: () => room.membership,
        hasEncryptionStateEvent: () => room.encryptionState === true,
      })),
    getCrypto: () => ({
      isEncryptionEnabledInRoom: (roomId: string) =>
        Promise.resolve(state.storeEncrypted[roomId] === true),
    }),
    getAccountData: (type: string) =>
      type === EventType.Direct
        ? { getContent: () => state.direct }
        : undefined,
  };
}

type FakeClient = ReturnType<typeof fakeClient>;

/** Background time granted with the given id; protected data available unless overridden. */
function grant(
  id: number,
  state: Partial<BackgroundWork> = {},
): BackgroundWork {
  return { id, protectedDataAvailable: true, locking: false, ...state };
}

function setup(opts: { available?: boolean; clients?: FakeClient[] } = {}) {
  const clients = new Map(
    (
      opts.clients ?? [
        fakeClient('@me:hs', [
          { roomId: '!a:hs', name: 'Team', membership: 'join' },
        ]),
      ]
    ).map((client) => [client.userId, client]),
  );
  const accountIds = signal<readonly string[]>([...clients.keys()]);
  const rotations = new Subject<AccessTokenRotation>();
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
  const sound = { isOn: vi.fn(() => true) };
  const expiry = vi.fn(
    (_userId: string, _accessToken: string): number | undefined => undefined,
  );
  const refresh = vi.fn(
    (_userId: string, _options?: { timeoutMs?: number }): Observable<boolean> =>
      of(true),
  );
  const refreshable = vi.fn((_userId: string): boolean => true);
  const adoptNativeTokens = vi.fn((): Observable<void> => of(void 0));
  TestBed.configureTestingModule({
    providers: [
      PushHandoffService,
      MockProvider(MatrixClientService, {
        accountIds: accountIds.asReadonly(),
        clientFor: (id: string) => (clients.get(id) as never) ?? null,
        accessTokenRotations: rotations.asObservable(),
        accessTokenExpiry: expiry,
        refreshAccessToken: refresh,
        canRefreshAccessToken: refreshable,
        adoptNativeTokens,
      }),
      { provide: PushHandoffBridge, useValue: bridge },
      { provide: NotificationSoundService, useValue: sound },
    ],
  });
  return {
    service: TestBed.inject(PushHandoffService),
    clients,
    accountIds,
    rotations,
    bridge,
    sound,
    expiry,
    refresh,
    refreshable,
    adoptNativeTokens,
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

const me = (h: ReturnType<typeof setup>) => h.clients.get('@me:hs')!;

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
      const forgetting = firstValueFrom(h.service.forget('@me:hs'), {
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
      userId: '@me:hs',
      homeserverUrl: 'https://hs.example',
      accessToken: 'token-@me:hs',
      sound: true,
    });
  });

  it('rewrites the account with the refreshed access token', async () => {
    const h = setup();
    await start(h);

    h.rotations.next({ userId: '@me:hs', accessToken: 'fresh' });
    await flush();

    expect(h.bridge.setAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: '@me:hs', accessToken: 'fresh' }),
    );
  });

  it('hands the access-token expiry over with the token it belongs to', async () => {
    const h = setup();
    h.expiry.mockImplementation((userId: string, token: string) =>
      userId === '@me:hs' && token === 'token-@me:hs'
        ? 1_760_000_000_000
        : undefined,
    );
    await start(h);

    expect(h.bridge.setAccount).toHaveBeenCalledWith({
      userId: '@me:hs',
      homeserverUrl: 'https://hs.example',
      accessToken: 'token-@me:hs',
      sound: true,
      accessTokenExpiresAt: 1_760_000_000_000,
    });
  });

  it('writes a refreshed token with its own expiry', async () => {
    const h = setup();
    h.expiry.mockImplementation((_userId: string, token: string) =>
      token === 'fresh' ? 1_760_000_300_000 : undefined,
    );
    await start(h);

    h.rotations.next({ userId: '@me:hs', accessToken: 'fresh' });
    await flush();

    expect(h.bridge.setAccount).toHaveBeenLastCalledWith({
      userId: '@me:hs',
      homeserverUrl: 'https://hs.example',
      accessToken: 'fresh',
      sound: true,
      accessTokenExpiresAt: 1_760_000_300_000,
    });
  });

  it('hands over no expiry for a token the client does not hold', async () => {
    const h = setup();
    h.expiry.mockImplementation((_userId: string, token: string) =>
      token === 'token-@me:hs' ? 1_760_000_000_000 : undefined,
    );
    await start(h);

    h.rotations.next({ userId: '@me:hs', accessToken: 'stale' });
    await flush();

    expect(h.bridge.setAccount).toHaveBeenLastCalledWith({
      userId: '@me:hs',
      homeserverUrl: 'https://hs.example',
      accessToken: 'stale',
      sound: true,
    });
  });

  it('writes joined room names and DM flags as one batch', async () => {
    const h = setup({
      clients: [
        fakeClient('@me:hs', [
          { roomId: '!a:hs', name: 'Team', membership: 'join' },
          { roomId: '!dm:hs', name: 'Bob', membership: 'join' },
          { roomId: '!inv:hs', name: 'Invite', membership: 'invite' },
        ]),
      ],
    });
    h.clients.get('@me:hs')!.state.direct = { '@bob:hs': ['!dm:hs'] };
    await start(h);

    // Once before the crypto store answered (both encrypted), once after.
    expect(h.bridge.setRooms).toHaveBeenCalledTimes(2);
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith('@me:hs', [
      { roomId: '!a:hs', name: 'Team', direct: false, encrypted: false },
      { roomId: '!dm:hs', name: 'Bob', direct: true, encrypted: false },
    ]);
  });

  it('writes a room as encrypted until the crypto store has answered for it', async () => {
    const h = setup({
      clients: [
        fakeClient('@me:hs', [
          { roomId: '!plain:hs', name: 'Plain', membership: 'join' },
          { roomId: '!stored:hs', name: 'Stored', membership: 'join' },
          {
            roomId: '!state:hs',
            name: 'State',
            membership: 'join',
            encryptionState: true,
          },
        ]),
      ],
    });
    me(h).state.storeEncrypted = { '!stored:hs': true };
    await start(h);

    expect(h.bridge.setRooms).toHaveBeenNthCalledWith(1, '@me:hs', [
      { roomId: '!plain:hs', name: 'Plain', direct: false, encrypted: true },
      { roomId: '!stored:hs', name: 'Stored', direct: false, encrypted: true },
      { roomId: '!state:hs', name: 'State', direct: false, encrypted: true },
    ]);
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith('@me:hs', [
      { roomId: '!plain:hs', name: 'Plain', direct: false, encrypted: false },
    ]);
  });

  it('rewrites a room stored as unencrypted once its state turns encryption on', async () => {
    const h = setup();
    await start(h);
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith('@me:hs', [
      { roomId: '!a:hs', name: 'Team', direct: false, encrypted: false },
    ]);
    h.bridge.setRooms.mockClear();

    me(h).state.rooms[0].encryptionState = true;
    me(h).emit(ClientEvent.Sync, SyncState.Syncing);
    await flush();

    expect(h.bridge.setRooms).toHaveBeenCalledOnce();
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith('@me:hs', [
      { roomId: '!a:hs', name: 'Team', direct: false, encrypted: true },
    ]);
  });

  it('writes only what a sync or rename changed, and nothing for a quiet sync', async () => {
    const h = setup();
    await start(h);
    h.bridge.setRooms.mockClear();

    me(h).emit(ClientEvent.Sync, SyncState.Syncing);
    await flush();
    expect(h.bridge.setRooms).not.toHaveBeenCalled();

    me(h).state.rooms[0].name = 'Renamed';
    me(h).emit(RoomEvent.Name);
    await flush();
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith('@me:hs', [
      { roomId: '!a:hs', name: 'Renamed', direct: false, encrypted: false },
    ]);

    me(h).state.rooms.push({
      roomId: '!b:hs',
      name: 'New',
      membership: 'join',
    });
    me(h).emit(ClientEvent.Sync, SyncState.Syncing);
    await flush();
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith('@me:hs', [
      { roomId: '!b:hs', name: 'New', direct: false, encrypted: false },
    ]);
  });

  it('retries rooms whose write failed at the next sync', async () => {
    const h = setup();
    await start(h);
    h.bridge.setRooms.mockReturnValueOnce(
      throwError(() => new Error('keychain locked')),
    );
    me(h).state.rooms[0].name = 'Renamed';
    me(h).emit(RoomEvent.Name);
    await flush();
    h.bridge.setRooms.mockClear();

    me(h).emit(ClientEvent.Sync, SyncState.Syncing);
    await flush();

    expect(h.bridge.setRooms).toHaveBeenCalledOnce();
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith('@me:hs', [
      { roomId: '!a:hs', name: 'Renamed', direct: false, encrypted: false },
    ]);
  });

  it('rewrites the account when its sound setting changes', async () => {
    const h = setup();
    await start(h);
    h.sound.isOn.mockReturnValue(false);

    me(h).emit(ClientEvent.AccountData, {
      getType: () => NOTIFICATION_SOUND_EVENT,
    });
    await flush();

    expect(h.sound.isOn).toHaveBeenCalledWith('@me:hs');
    expect(h.bridge.setAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: '@me:hs', sound: false }),
    );
  });

  it('does not write an account again after forgetting it, until it signs in again', async () => {
    const h = setup();
    await start(h);
    h.bridge.setAccount.mockClear();
    h.bridge.setRooms.mockClear();

    await firstValueFrom(h.service.forget('@me:hs'));
    expect(h.bridge.removeAccount).toHaveBeenCalledWith('@me:hs');

    // Late events while sign-out is still running must not recreate the entry.
    me(h).state.rooms[0].name = 'Late rename';
    me(h).emit(RoomEvent.Name);
    me(h).emit(ClientEvent.Sync, SyncState.Syncing);
    h.rotations.next({ userId: '@me:hs', accessToken: 'late' });
    await flush();
    expect(h.bridge.setAccount).not.toHaveBeenCalled();
    expect(h.bridge.setRooms).not.toHaveBeenCalled();

    // Signed out, then signed in again: written afresh.
    h.accountIds.set([]);
    TestBed.tick();
    h.accountIds.set(['@me:hs']);
    TestBed.tick();
    await flush();
    expect(h.bridge.setAccount).toHaveBeenCalledOnce();
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith('@me:hs', [
      { roomId: '!a:hs', name: 'Late rename', direct: false, encrypted: false },
    ]);
  });

  it('writes a signed-in-again account afresh when only its client changed', async () => {
    const h = setup();
    await start(h);
    await firstValueFrom(h.service.forget());
    h.bridge.setAccount.mockClear();

    // Replacing every live account with the same user: a new client under the same id,
    // with no change of the id list observed in between.
    const fresh = fakeClient('@me:hs', [
      { roomId: '!a:hs', name: 'Team', membership: 'join' },
    ]);
    fresh.state.token = 'new-session';
    h.clients.set('@me:hs', fresh);
    h.accountIds.set(['@me:hs']);
    TestBed.tick();
    await flush();

    expect(h.bridge.setAccount).toHaveBeenCalledOnce();
    expect(h.bridge.setAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'new-session' }),
    );
  });

  it('writes nothing for an account whose client was swapped while it was being forgotten', async () => {
    const h = setup();
    await start(h);
    const old = me(h);
    h.bridge.setAccount.mockClear();
    h.bridge.setRooms.mockClear();

    // A re-authentication swapped the client, and sign-out began before the handoff
    // observed the swap.
    const swapped = fakeClient('@me:hs', [
      { roomId: '!a:hs', name: 'Team', membership: 'join' },
    ]);
    swapped.state.token = 'swapped-session';
    h.clients.set('@me:hs', swapped);
    h.accountIds.set(['@me:hs']);
    await firstValueFrom(h.service.forget('@me:hs'));
    TestBed.tick();
    await flush();
    old.emit(ClientEvent.Sync, SyncState.Syncing);
    swapped.emit(ClientEvent.Sync, SyncState.Syncing);
    swapped.emit(RoomEvent.Name);
    h.rotations.next({ userId: '@me:hs', accessToken: 'late' });
    await flush();

    expect(h.bridge.removeAccount).toHaveBeenCalledWith('@me:hs');
    expect(h.bridge.setAccount).not.toHaveBeenCalled();
    expect(h.bridge.setRooms).not.toHaveBeenCalled();

    // A genuinely new sign-in afterwards is written again.
    const signedIn = fakeClient('@me:hs', [
      { roomId: '!a:hs', name: 'Team', membership: 'join' },
    ]);
    signedIn.state.token = 'new-session';
    h.clients.set('@me:hs', signedIn);
    h.accountIds.set(['@me:hs']);
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
    await firstValueFrom(h.service.forget('@me:hs'));
    // The session ends before it sees the account leave.
    lifetime.unsubscribe();
    h.bridge.setAccount.mockClear();

    const fresh = fakeClient('@me:hs', [
      { roomId: '!a:hs', name: 'Team', membership: 'join' },
    ]);
    fresh.state.token = 'new-session';
    h.clients.set('@me:hs', fresh);
    await start(h);

    expect(h.bridge.setAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'new-session' }),
    );
  });

  it('keeps a forgotten account unwritten when a new session finds it still live', async () => {
    const h = setup();
    const lifetime = await start(h);
    await firstValueFrom(h.service.forget('@me:hs'));
    lifetime.unsubscribe();
    h.bridge.setAccount.mockClear();
    h.bridge.setRooms.mockClear();

    await start(h);
    me(h).emit(ClientEvent.Sync, SyncState.Syncing);
    await flush();

    expect(h.bridge.setAccount).not.toHaveBeenCalled();
    expect(h.bridge.setRooms).not.toHaveBeenCalled();
  });

  it('removes an account only after a write already in flight settles', async () => {
    const h = setup();
    const inFlight = new Subject<void>();
    h.bridge.setAccount.mockReturnValueOnce(inFlight);
    await start(h);

    const forgotten = firstValueFrom(h.service.forget('@me:hs'));
    await flush();
    expect(h.bridge.removeAccount).not.toHaveBeenCalled();

    inFlight.next();
    inFlight.complete();
    await forgotten;
    expect(h.bridge.removeAccount).toHaveBeenCalledWith('@me:hs');
  });

  it('reports a removal the native store refused', async () => {
    const h = setup();
    h.bridge.removeAccount.mockReturnValue(
      throwError(() => new Error('keychain locked')),
    );
    await start(h);

    await expect(firstValueFrom(h.service.forget('@me:hs'))).rejects.toThrow(
      'keychain locked',
    );
  });

  it('empties the whole store for clear-all-data and stops writing every account', async () => {
    const h = setup();
    await start(h);
    h.bridge.setRooms.mockClear();

    await firstValueFrom(h.service.forget());
    me(h).state.rooms[0].name = 'Late rename';
    me(h).emit(RoomEvent.Name);
    await flush();

    expect(h.bridge.clear).toHaveBeenCalledOnce();
    expect(h.bridge.removeAccount).not.toHaveBeenCalled();
    expect(h.bridge.setRooms).not.toHaveBeenCalled();
  });

  it('writes nothing on web or desktop', async () => {
    const h = setup({ available: false });
    await start(h);
    me(h).emit(ClientEvent.Sync, SyncState.Syncing);
    await firstValueFrom(h.service.forget('@me:hs'));
    await firstValueFrom(h.service.forget());
    await firstValueFrom(h.service.clearRoom('@me:hs', '!a:hs'));
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

    await firstValueFrom(h.service.clearRoom('@me:hs', '!a:hs'));

    expect(h.bridge.clearRoom).toHaveBeenCalledOnce();
    expect(h.bridge.clearRoom).toHaveBeenCalledWith('@me:hs', '!a:hs');
  });

  it('completes quietly when the native side cannot clear a room', async () => {
    const h = setup();
    h.bridge.clearRoom.mockReturnValue(
      throwError(() => new Error('notification center unavailable')),
    );

    await expect(
      firstValueFrom(h.service.clearRoom('@me:hs', '!a:hs')),
    ).resolves.toBeUndefined();
  });

  it('detaches every client listener when its lifetime ends', async () => {
    const h = setup();
    const lifetime = await start(h);
    expect(me(h).listeners()).toBeGreaterThan(0);

    lifetime.unsubscribe();

    expect(me(h).listeners()).toBe(0);
  });

  it('adopts on resume only on native', async () => {
    const native = setup();
    await firstValueFrom(native.service.adoptOnResume());
    expect(native.adoptNativeTokens).toHaveBeenCalledOnce();

    TestBed.resetTestingModule();
    const web = setup({ available: false });
    await firstValueFrom(web.service.adoptOnResume());
    expect(web.adoptNativeTokens).not.toHaveBeenCalled();
  });

  describe('refreshBeforeBackground', () => {
    afterEach(() => vi.useRealTimers());

    it('refreshes each account whose token expires, and no other', async () => {
      const h = setup({
        clients: [fakeClient('@me:hs', []), fakeClient('@pw:hs', [])],
      });
      h.expiry.mockImplementation((userId: string) =>
        userId === '@me:hs' ? Date.now() + 300_000 : undefined,
      );
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(refreshed(h)).toEqual(['@me:hs']);
    });

    it('skips an account whose token rotated within the last minute', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_000_000);
      const h = setup();
      h.expiry.mockReturnValue(1_300_000);
      await start(h);
      h.rotations.next({ userId: '@me:hs', accessToken: 'token-@me:hs' });
      await flush();

      vi.setSystemTime(1_000_000 + BACKGROUND_REFRESH_MIN_AGE_MS - 1);
      await firstValueFrom(h.service.refreshBeforeBackground());
      expect(h.refresh).not.toHaveBeenCalled();

      vi.setSystemTime(1_000_000 + BACKGROUND_REFRESH_MIN_AGE_MS);
      await firstValueFrom(h.service.refreshBeforeBackground());
      expect(refreshed(h)).toEqual(['@me:hs']);
    });

    it("does not let one account's rotation suppress another's refresh", async () => {
      const h = setup({
        clients: [fakeClient('@me:hs', []), fakeClient('@pw:hs', [])],
      });
      h.expiry.mockReturnValue(Date.now() + 300_000);
      await start(h);
      h.rotations.next({ userId: '@me:hs', accessToken: 'token-@me:hs' });
      await flush();

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(refreshed(h)).toEqual(['@pw:hs']);
    });

    it('forgets a recent rotation when the account leaves and is added again', async () => {
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
      await start(h);
      h.rotations.next({ userId: '@me:hs', accessToken: 'token-@me:hs' });
      await flush();
      h.accountIds.set([]);
      TestBed.tick();
      h.accountIds.set(['@me:hs']);
      TestBed.tick();
      await flush();

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(refreshed(h)).toEqual(['@me:hs']);
    });

    it('ignores a rotation that arrives after the account left', async () => {
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
      await start(h);
      h.accountIds.set([]);
      TestBed.tick();
      h.rotations.next({ userId: '@me:hs', accessToken: 'late' });
      h.accountIds.set(['@me:hs']);
      TestBed.tick();
      await flush();

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(refreshed(h)).toEqual(['@me:hs']);
    });

    it('refreshes nothing off a native host', async () => {
      const h = setup({ available: false });
      h.expiry.mockReturnValue(Date.now() + 300_000);
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(h.refresh).not.toHaveBeenCalled();
    });

    it('does not refresh an account whose sign-out began', async () => {
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
      await start(h);
      await firstValueFrom(h.service.forget('@me:hs'));

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(h.refresh).not.toHaveBeenCalled();
    });

    it('completes even when a refresh fails', async () => {
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
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
          h.rotations.next({ userId, accessToken: `new-${userId}` });
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
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
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
      expect(refreshed(h)).toEqual(['@me:hs', '@me:hs']);
    });

    it('finishes the other accounts in a run where one refresh hangs', async () => {
      const h = setup({
        clients: [fakeClient('@me:hs', []), fakeClient('@pw:hs', [])],
      });
      h.expiry.mockReturnValue(Date.now() + 300_000);
      await start(h);
      h.bridge.setAccount.mockClear();
      useFakeTimers();
      const rotate = rotating(h);
      h.refresh.mockImplementation((userId) =>
        userId === '@me:hs' ? NEVER : rotate(userId),
      );

      const { outcome } = watch(h.service.refreshBeforeBackground());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.bridge.setAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: '@pw:hs',
          accessToken: 'new-@pw:hs',
        }),
      );
      expect(outcome.done).toBe(false);

      await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_TIMEOUT_MS);
      expect(outcome).toEqual({ done: true, error: undefined });
      expect(refreshed(h)).toEqual(['@me:hs', '@pw:hs']);
    });

    it('holds background time from before the refresh until its store write has landed, and completes after the release', async () => {
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
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
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
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
      const h = setup({
        clients: [fakeClient('@me:hs', []), fakeClient('@pw:hs', [])],
      });
      h.expiry.mockReturnValue(Date.now() + 300_000);
      await start(h);
      useFakeTimers();
      h.bridge.setAccount.mockReturnValue(NEVER);
      const rotate = rotating(h);
      h.refresh.mockImplementation((userId) =>
        userId === '@me:hs' ? NEVER : rotate(userId),
      );

      const { outcome } = watch(h.service.refreshBeforeBackground());
      await vi.advanceTimersByTimeAsync(BACKGROUND_RUN_DEADLINE_MS - 1);
      expect(outcome.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(outcome).toEqual({ done: true, error: undefined });
      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[7]]);
    });

    it('releases background time when the refresh gives up', async () => {
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
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
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
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
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
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
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
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
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
      await start(h);
      h.bridge.beginBackgroundWork.mockReturnValue(
        throwError(() => new Error('no background time')),
      );

      await expect(
        firstValueFrom(h.service.refreshBeforeBackground()),
      ).resolves.toBeUndefined();

      expect(refreshed(h)).toEqual(['@me:hs']);
      expect(h.bridge.endBackgroundWork).not.toHaveBeenCalled();
    });

    it('bounds the token grant of every refresh it starts', async () => {
      const h = setup({
        clients: [fakeClient('@me:hs', []), fakeClient('@pw:hs', [])],
      });
      h.expiry.mockReturnValue(Date.now() + 300_000);
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(h.refresh.mock.calls).toEqual([
        ['@me:hs', { timeoutMs: BACKGROUND_REFRESH_GRANT_TIMEOUT_MS }],
        ['@pw:hs', { timeoutMs: BACKGROUND_REFRESH_GRANT_TIMEOUT_MS }],
      ]);
      // Inside the roughly 10 s iOS keeps the session's keychain items writable after a lock.
      expect(BACKGROUND_REFRESH_GRANT_TIMEOUT_MS).toBeLessThan(10_000);
    });

    it('refreshes nothing when protected data is unavailable, and still releases background time', async () => {
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
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
      const h = setup();
      h.expiry.mockReturnValue(Date.now() + 300_000);
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
      expect(refreshed(h)).toEqual(['@me:hs']);
      expect(h.bridge.endBackgroundWork.mock.calls).toEqual([[7], [8]]);
    });

    it('starts every due refresh as soon as background time is granted, so a lock that follows finds none left to start', async () => {
      const h = setup({
        clients: [fakeClient('@me:hs', []), fakeClient('@pw:hs', [])],
      });
      h.expiry.mockReturnValue(Date.now() + 300_000);
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
      expect(refreshed(h)).toEqual(['@me:hs', '@pw:hs']);

      // A lock now can stop nothing further; the run ends with its bounds and releases.
      await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_TIMEOUT_MS);
      expect(outcome).toEqual({ done: true, error: undefined });
      expect(refreshed(h)).toEqual(['@me:hs', '@pw:hs']);
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
        clients: [fakeClient('@me:hs', []), fakeClient('@pw:hs', [])],
      });
      h.expiry.mockReturnValue(Date.now() + 300_000);
      h.refreshable.mockReturnValue(false);
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(h.refresh).not.toHaveBeenCalled();
      expect(h.bridge.beginBackgroundWork).not.toHaveBeenCalled();
      expect(h.bridge.endBackgroundWork).not.toHaveBeenCalled();
    });

    it('refreshes only the accounts that can refresh', async () => {
      const h = setup({
        clients: [fakeClient('@me:hs', []), fakeClient('@pw:hs', [])],
      });
      h.expiry.mockReturnValue(Date.now() + 300_000);
      h.refreshable.mockImplementation((userId) => userId === '@pw:hs');
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(refreshed(h)).toEqual(['@pw:hs']);
      expect(h.bridge.beginBackgroundWork).toHaveBeenCalledOnce();
    });

    it('asks for no background time off a native host', async () => {
      const h = setup({ available: false });
      h.expiry.mockReturnValue(Date.now() + 300_000);
      await start(h);

      await firstValueFrom(h.service.refreshBeforeBackground());

      expect(h.bridge.beginBackgroundWork).not.toHaveBeenCalled();
      expect(h.bridge.endBackgroundWork).not.toHaveBeenCalled();
    });
  });
});
