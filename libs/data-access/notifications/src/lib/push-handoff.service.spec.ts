import { EventEmitter } from 'node:events';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClientEvent, EventType, RoomEvent, SyncState } from 'matrix-js-sdk';
import {
  MatrixClientService,
  type AccessTokenRotation,
} from '@trinity/data-access/matrix-client';
import { PushHandoffBridge } from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import {
  Subject,
  firstValueFrom,
  of,
  throwError,
  type Observable,
  type Subscription,
} from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_SOUND_EVENT,
  NotificationSoundService,
} from './notification-sound.service';
import { PushHandoffService } from './push-handoff.service';

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
}

/** The parts of one account's MatrixClient the handoff reads, with a real event emitter. */
function fakeClient(userId: string, rooms: FakeRoom[]) {
  const events = new EventEmitter();
  const state = {
    token: `token-${userId}`,
    rooms,
    direct: {} as Record<string, string[]>,
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
      })),
    getAccountData: (type: string) =>
      type === EventType.Direct
        ? { getContent: () => state.direct }
        : undefined,
  };
}

type FakeClient = ReturnType<typeof fakeClient>;

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
  };
  const sound = { isOn: vi.fn(() => true) };
  TestBed.configureTestingModule({
    providers: [
      PushHandoffService,
      MockProvider(MatrixClientService, {
        accountIds: accountIds.asReadonly(),
        clientFor: (id: string) => (clients.get(id) as never) ?? null,
        accessTokenRotations: rotations.asObservable(),
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

describe('PushHandoffService', () => {
  beforeEach(() => TestBed.resetTestingModule());

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

    expect(h.bridge.setRooms).toHaveBeenCalledOnce();
    expect(h.bridge.setRooms).toHaveBeenCalledWith('@me:hs', [
      { roomId: '!a:hs', name: 'Team', direct: false },
      { roomId: '!dm:hs', name: 'Bob', direct: true },
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
      { roomId: '!a:hs', name: 'Renamed', direct: false },
    ]);

    me(h).state.rooms.push({
      roomId: '!b:hs',
      name: 'New',
      membership: 'join',
    });
    me(h).emit(ClientEvent.Sync, SyncState.Syncing);
    await flush();
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith('@me:hs', [
      { roomId: '!b:hs', name: 'New', direct: false },
    ]);
  });

  it('retries rooms whose write failed at the next sync', async () => {
    const h = setup();
    h.bridge.setRooms.mockReturnValueOnce(
      throwError(() => new Error('keychain locked')),
    );
    await start(h);

    me(h).emit(ClientEvent.Sync, SyncState.Syncing);
    await flush();

    expect(h.bridge.setRooms).toHaveBeenCalledTimes(2);
    expect(h.bridge.setRooms).toHaveBeenLastCalledWith('@me:hs', [
      { roomId: '!a:hs', name: 'Team', direct: false },
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
    expect(h.bridge.setRooms).toHaveBeenCalledOnce();
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
});
