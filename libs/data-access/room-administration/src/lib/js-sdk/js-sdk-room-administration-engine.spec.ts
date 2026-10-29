import { TestBed } from '@angular/core/testing';
import { MatrixError, MatrixEvent, RoomState } from 'matrix-js-sdk';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { assertPlainData } from '@trinity/util/matrix';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdministeredRoom,
  RoomMembers,
} from '../room-administration-engine';
import { JsSdkRoomAdministrationEngine } from './js-sdk-room-administration-engine';

const ME = '@alice:example.org';
const CO = '@bob:example.org';
const ROOM_ID = '!room:example.org';

let nextEvent = 0;

function stateEvent(
  type: string,
  stateKey: string,
  sender: string,
  content: Record<string, unknown>,
): MatrixEvent {
  return new MatrixEvent({
    type,
    state_key: stateKey,
    sender,
    room_id: ROOM_ID,
    event_id: `$e${++nextEvent}`,
    origin_server_ts: 1_700_000_000_000,
    content,
  });
}

/** A v12 room I created with bob as additional creator, as the SDK holds it. */
function setup(options: { encrypted?: boolean; roomVersion?: string } = {}) {
  const state = new RoomState(ROOM_ID);
  const powerLevels = { users: { '@carol:example.org': 50 }, kick: 50 };
  state.setStateEvents([
    stateEvent('m.room.create', '', ME, {
      room_version: options.roomVersion ?? '12',
      additional_creators: [CO],
    }),
    stateEvent('m.room.power_levels', '', ME, powerLevels),
    stateEvent('m.room.member', ME, ME, { membership: 'join' }),
    stateEvent('m.room.member', CO, CO, {
      membership: 'ban',
      reason: '  ',
    }),
    stateEvent('m.room.member', '@carol:example.org', ME, {
      membership: 'knock',
      displayname: 'Carol',
      reason: 'let me in',
    }),
    ...(options.encrypted
      ? [
          stateEvent('m.room.encryption', '', ME, {
            algorithm: 'm.megolm.v1.aes-sha2',
          }),
        ]
      : []),
  ]);
  let membership = 'join';
  let loaded = false;
  let known = true;
  const loadMembersIfNeeded = vi.fn(() =>
    Promise.resolve().then(() => (loaded = true)),
  );
  const room = {
    roomId: ROOM_ID,
    getMyMembership: () => membership,
    getMember: (userId: string) => state.getMember(userId),
    getMembers: () => state.getMembers(),
    hasEncryptionStateEvent: () => !!options.encrypted,
    isSpaceRoom: () => false,
    membersLoaded: () => loaded,
    loadMembersIfNeeded,
    getLiveTimeline: () => ({ getState: () => state }),
  };
  let answer: (encrypted: boolean) => void = () => undefined;
  const crypto = {
    isEncryptionEnabledInRoom: vi.fn(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
    ),
  };
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const sendStateEvent = vi.fn(async () => ({ event_id: '$sent' }));
  const client = {
    getRoom: vi.fn((roomId: string) =>
      roomId === ROOM_ID && known ? room : null,
    ),
    getUserId: () => ME,
    getCrypto: () => crypto,
    sendStateEvent,
    on: (event: string, listener: (...args: unknown[]) => void) =>
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
    off: (event: string, listener: (...args: unknown[]) => void) =>
      listeners.get(event)?.delete(listener),
  };
  let current: typeof client | null = client;
  TestBed.configureTestingModule({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: {
          clientFor: (accountId: string) => (accountId === ME ? current : null),
        },
      },
    ],
  });
  return {
    engine: TestBed.inject(JsSdkRoomAdministrationEngine),
    powerLevels,
    crypto,
    answer: (encrypted: boolean) => answer(encrypted),
    loadMembersIfNeeded,
    sendStateEvent,
    listenerCount: () =>
      [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    emit: (event: string, ...args: unknown[]) =>
      listeners.get(event)?.forEach((listener) => listener(...args)),
    setMembership: (value: string) => (membership = value),
    setKnown: (value: boolean) => (known = value),
    state,
    getRoom: client.getRoom,
    replaceClient: () => (current = { ...client }),
  };
}

function watch<T>(source: {
  subscribe(next: (value: T) => void): { unsubscribe(): void };
}) {
  const seen: T[] = [];
  const subscription = source.subscribe((value) => {
    assertPlainData(value);
    seen.push(value);
  });
  return { seen, close: () => subscription.unsubscribe() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('JsSdkRoomAdministrationEngine', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('emits null at once for an account that is not live or a room it does not know', () => {
    const { engine } = setup();
    const seen = [
      watch(engine.room('@nobody:example.org', ROOM_ID)),
      watch(engine.room(ME, '!other:example.org')),
      watch(engine.members('@nobody:example.org', ROOM_ID)),
      watch(engine.members(ME, '!other:example.org')),
    ].map(({ seen }) => seen);

    expect(seen).toEqual([[null], [null], [null], [null]]);
  });

  it('room crosses v12 creators as infinite power, deep-copied and synchronously', () => {
    const { engine, powerLevels } = setup();
    const { seen } = watch<AdministeredRoom | null>(engine.room(ME, ROOM_ID));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      ownUserId: ME,
      ownMembership: 'join',
      ownPower: 'infinite',
      powerLevels,
      creators: [
        { userId: ME, displayName: ME },
        { userId: CO, displayName: CO },
      ],
      state: {
        create: {
          sender: ME,
          originServerTs: 1_700_000_000_000,
          content: { room_version: '12', additional_creators: [CO] },
        },
        name: null,
      },
    });
    expect(seen[0]?.powerLevels).not.toBe(powerLevels);
  });

  it.each([
    {
      roomVersion: 'org.example.custom',
      creators: [ME, CO],
      power: 'infinite',
    },
    { roomVersion: '11', creators: [ME], power: 0 },
  ])(
    'lists additional creators exactly when they have creator power (version $roomVersion)',
    ({ roomVersion, creators, power }) => {
      const { engine } = setup({ roomVersion });
      const [room] = watch<AdministeredRoom | null>(
        engine.room(ME, ROOM_ID),
      ).seen;
      const [members] = watch<RoomMembers | null>(
        engine.members(ME, ROOM_ID),
      ).seen;

      expect(room?.creators.map(({ userId }) => userId)).toEqual(creators);
      expect(members?.members.find(({ userId }) => userId === CO)?.power).toBe(
        power,
      );
    },
  );

  it('lists each creator once, falling back to the legacy creator field', () => {
    const { engine, state } = setup();
    const creators = () =>
      watch<AdministeredRoom | null>(
        engine.room(ME, ROOM_ID),
      ).seen[0]?.creators.map(({ userId }) => userId);

    state.setStateEvents([
      stateEvent('m.room.create', '', ME, {
        room_version: '12',
        additional_creators: ['@carol:example.org', ME, 7],
      }),
    ]);
    expect(creators()).toEqual([ME, '@carol:example.org']);

    state.setStateEvents([
      stateEvent('m.room.create', '', '', { creator: CO }),
    ]);
    expect(creators()).toEqual([CO]);
  });

  it('reports encryption unknown until the crypto store answers', async () => {
    const { engine, answer, crypto } = setup();
    const { seen } = watch<AdministeredRoom | null>(engine.room(ME, ROOM_ID));

    answer(false);
    await settle();

    expect(seen.map((room) => room?.encryption)).toEqual([
      'unknown',
      'unencrypted',
    ]);
    expect(crypto.isEncryptionEnabledInRoom).toHaveBeenCalledTimes(1);
  });

  it('reports encryption from room state without asking the store', () => {
    const { engine, crypto } = setup({ encrypted: true });
    const { seen } = watch<AdministeredRoom | null>(engine.room(ME, ROOM_ID));

    expect(seen.map((room) => room?.encryption)).toEqual(['encrypted']);
    expect(crypto.isEncryptionEnabledInRoom).not.toHaveBeenCalled();
  });

  it('coalesces a burst into one re-emission and skips unchanged values', async () => {
    const { engine, emit, setMembership } = setup({ encrypted: true });
    const { seen } = watch<AdministeredRoom | null>(engine.room(ME, ROOM_ID));

    setMembership('leave');
    emit('Room.myMembership', { roomId: ROOM_ID });
    emit('sync');
    await settle();
    emit('sync');
    await settle();

    expect(seen.map((room) => room?.ownMembership)).toEqual(['join', 'leave']);
  });

  it('stops publishing when the account gets a new client, and detaches', async () => {
    const { engine, emit, setMembership, replaceClient, listenerCount } = setup(
      { encrypted: true },
    );
    const { seen, close } = watch<AdministeredRoom | null>(
      engine.room(ME, ROOM_ID),
    );

    replaceClient();
    setMembership('leave');
    emit('Room.myMembership', { roomId: ROOM_ID });
    await settle();
    close();

    expect(seen).toHaveLength(1);
    expect(listenerCount()).toBe(0);
  });

  it('stops re-reading on sync once the room is known, yet follows member and power changes', async () => {
    const { engine, emit, getRoom, setKnown, state } = setup({
      encrypted: true,
    });
    setKnown(false);
    const room = watch<AdministeredRoom | null>(engine.room(ME, ROOM_ID));
    const members = watch<RoomMembers | null>(engine.members(ME, ROOM_ID));
    setKnown(true);
    emit('sync');
    await settle();
    expect(room.seen.at(-1)?.roomId).toBe(ROOM_ID);
    expect(members.seen.at(-1)?.roomId).toBe(ROOM_ID);
    const reads = getRoom.mock.calls.length;

    emit('sync');
    await settle();
    expect(getRoom.mock.calls.length).toBe(reads);

    const power = stateEvent('m.room.power_levels', '', ME, {
      users: { '@carol:example.org': 75 },
    });
    state.setStateEvents([power]);
    emit('RoomState.events', power, state);
    emit('RoomState.members', power, state);
    await settle();
    expect(room.seen.at(-1)?.powerLevels).toEqual({
      users: { '@carol:example.org': 75 },
    });
    expect(
      members.seen
        .at(-1)
        ?.members.find(({ userId }) => userId === '@carol:example.org')?.power,
    ).toBe(75);
  });

  it('members skips a sync that changed no member', async () => {
    const { engine, emit } = setup();
    const { seen } = watch<RoomMembers | null>(engine.members(ME, ROOM_ID));
    await settle();
    const before = seen.length;

    emit('sync');
    await settle();

    expect(seen).toHaveLength(before);
  });

  it('members loads lazy members and crosses power, names and reasons', async () => {
    const { engine, loadMembersIfNeeded } = setup();
    const { seen } = watch<RoomMembers | null>(engine.members(ME, ROOM_ID));
    await settle();

    expect(loadMembersIfNeeded).toHaveBeenCalledTimes(1);
    expect(seen.map((members) => members?.complete)).toEqual([false, true]);
    expect(seen[1]?.members).toEqual([
      {
        userId: ME,
        displayName: ME,
        avatarMxc: null,
        membership: 'join',
        reason: null,
        power: 'infinite',
      },
      {
        userId: CO,
        displayName: CO,
        avatarMxc: null,
        membership: 'ban',
        reason: null,
        power: 'infinite',
      },
      {
        userId: '@carol:example.org',
        displayName: 'Carol',
        avatarMxc: null,
        membership: 'knock',
        reason: 'let me in',
        power: 50,
      },
    ]);
  });

  describe('setState', () => {
    it('sends the content as given', async () => {
      const { engine, sendStateEvent } = setup();
      const content = { users: {}, 'org.example.custom': { a: [1] } };

      const result = await firstValueFrom(
        engine.setState(ME, ROOM_ID, 'm.room.power_levels', '', content),
      );

      expect(result).toEqual({ ok: true, value: null });
      expect(sendStateEvent).toHaveBeenCalledWith(
        ROOM_ID,
        'm.room.power_levels',
        content,
        '',
      );
    });

    it('fails without a live account or a joined room, before sending', async () => {
      const { engine, sendStateEvent, setMembership } = setup();
      setMembership('invite');

      const codes = await Promise.all(
        [
          engine.setState('@nobody:example.org', ROOM_ID, 't', '', {}),
          engine.setState(ME, ROOM_ID, 't', '', {}),
          engine.setState(ME, '!other:example.org', 't', '', {}),
        ].map(async (command) => {
          const result = await firstValueFrom(command);
          return result.ok ? null : result.failure.code;
        }),
      );

      expect(codes).toEqual([
        'account-not-live',
        'room-unavailable',
        'room-unavailable',
      ]);
      expect(sendStateEvent).not.toHaveBeenCalled();
    });

    it('reports a refusal as request-failed', async () => {
      const { engine, sendStateEvent } = setup();
      sendStateEvent.mockRejectedValueOnce(
        new MatrixError({ errcode: 'M_FORBIDDEN', error: 'no' }, 403),
      );

      const result = await firstValueFrom(
        engine.setState(ME, ROOM_ID, 'm.room.topic', '', { topic: 'x' }),
      );

      expect(result).toMatchObject({
        ok: false,
        failure: { code: 'request-failed', kind: 'permission' },
      });
    });
  });

  describe('stateEvents', () => {
    it('lists every current state event as a deep, plain copy', async () => {
      const { engine, state } = setup();

      const result = await firstValueFrom(engine.stateEvents(ME, ROOM_ID));

      assertPlainData(result);
      const events = result.ok ? result.value : [];
      expect(events.map(({ type, stateKey }) => `${type}|${stateKey}`)).toEqual(
        [
          'm.room.create|',
          'm.room.power_levels|',
          `m.room.member|${ME}`,
          `m.room.member|${CO}`,
          'm.room.member|@carol:example.org',
        ],
      );
      const create = state.getStateEvents('m.room.create', '');
      expect(events[0].event).toEqual(create?.event);
      expect(events[0].event['content']).not.toBe(create?.event.content);
    });

    it('fails without a live account or a known room', async () => {
      const { engine } = setup();

      const codes = await Promise.all(
        [
          engine.stateEvents('@nobody:example.org', ROOM_ID),
          engine.stateEvents(ME, '!other:example.org'),
        ].map(async (command) => {
          const result = await firstValueFrom(command);
          return result.ok ? null : result.failure.code;
        }),
      );

      expect(codes).toEqual(['account-not-live', 'room-unavailable']);
    });
  });
});
