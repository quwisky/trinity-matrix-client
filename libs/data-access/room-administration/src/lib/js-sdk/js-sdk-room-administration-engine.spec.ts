import { TestBed } from '@angular/core/testing';
import { MatrixError, MatrixEvent, RoomState } from 'matrix-js-sdk';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { type EngineResult, assertPlainData } from '@trinity/util/matrix';
import { type Observable, firstValueFrom } from 'rxjs';
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
  roomId = ROOM_ID,
): MatrixEvent {
  return new MatrixEvent({
    type,
    state_key: stateKey,
    sender,
    room_id: roomId,
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
    getCrypto: (): unknown => crypto,
    sendStateEvent,
    kick: vi.fn(async () => ({})),
    ban: vi.fn(async () => ({})),
    unban: vi.fn(async () => ({})),
    reportEvent: vi.fn(async () => ({})),
    reportRoom: vi.fn(async () => ({})),
    http: { authedRequest: vi.fn(async () => ({})) },
    getLocalAliases: vi.fn(async () => ({ aliases: ['#a:example.org'] })),
    createAlias: vi.fn(async () => ({})),
    deleteAlias: vi.fn(async () => ({})),
    getRoomDirectoryVisibility: vi.fn(async () => ({ visibility: 'public' })),
    setRoomDirectoryVisibility: vi.fn(async () => ({})),
    invite: vi.fn(async () => ({})),
    upgradeRoom: vi.fn(async () => ({ replacement_room: '!new:example.org' })),
    getRooms: vi.fn((): unknown[] => [room]),
    getStateEvent: vi.fn(async (): Promise<Record<string, unknown>> => ({
      users: {},
    })),
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
    client,
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

  describe('server commands', () => {
    it('call the client with the given arguments and answer its result', async () => {
      const { engine, client } = setup();
      const run = <T>(command: Observable<EngineResult<T>>) =>
        firstValueFrom(command);

      expect(await run(engine.kick(ME, ROOM_ID, CO, 'spam'))).toEqual({
        ok: true,
        value: null,
      });
      await run(engine.ban(ME, ROOM_ID, CO, null));
      await run(engine.unban(ME, ROOM_ID, CO));
      await run(engine.reportEvent(ME, ROOM_ID, '$e', 'why'));
      await run(engine.reportRoom(ME, ROOM_ID, ''));
      await run(engine.reportUser(ME, '@bad guy:example.org', 'spam'));
      expect(await run(engine.localAliases(ME, ROOM_ID))).toEqual({
        ok: true,
        value: ['#a:example.org'],
      });
      await run(engine.publishAlias(ME, ROOM_ID, '#new:example.org'));
      await run(engine.removeAlias(ME, '#old:example.org'));
      expect(await run(engine.directoryVisibility(ME, ROOM_ID))).toEqual({
        ok: true,
        value: 'public',
      });
      await run(engine.setDirectoryVisibility(ME, ROOM_ID, 'private'));

      expect(client.kick).toHaveBeenCalledWith(ROOM_ID, CO, 'spam');
      expect(client.ban).toHaveBeenCalledWith(ROOM_ID, CO, undefined);
      expect(client.unban).toHaveBeenCalledWith(ROOM_ID, CO);
      expect(client.reportEvent).toHaveBeenCalledWith(
        ROOM_ID,
        '$e',
        -100,
        'why',
      );
      expect(client.reportRoom).toHaveBeenCalledWith(ROOM_ID, '');
      expect(client.http.authedRequest).toHaveBeenCalledWith(
        'POST',
        '/users/%40bad%20guy%3Aexample.org/report',
        undefined,
        { reason: 'spam' },
      );
      expect(client.getLocalAliases).toHaveBeenCalledWith(ROOM_ID);
      expect(client.createAlias).toHaveBeenCalledWith(
        '#new:example.org',
        ROOM_ID,
      );
      expect(client.deleteAlias).toHaveBeenCalledWith('#old:example.org');
      expect(client.setRoomDirectoryVisibility).toHaveBeenCalledWith(
        ROOM_ID,
        'private',
      );
    });

    it('do not run before subscribe, nor without a live account', async () => {
      const { engine, client } = setup();

      const kick = engine.kick(ME, ROOM_ID, CO, null);
      expect(client.kick).not.toHaveBeenCalled();
      await firstValueFrom(kick);
      const result = await firstValueFrom(
        engine.reportUser('@nobody:example.org', CO, ''),
      );

      expect(result).toMatchObject({
        ok: false,
        failure: { code: 'account-not-live' },
      });
      expect(client.http.authedRequest).not.toHaveBeenCalled();
    });

    it('stateEvent answers the server content, or null when it has none', async () => {
      const { engine, client } = setup();

      expect(
        await firstValueFrom(
          engine.stateEvent(ME, ROOM_ID, 'm.room.power_levels', ''),
        ),
      ).toEqual({ ok: true, value: { users: {} } });
      expect(client.getStateEvent).toHaveBeenCalledWith(
        ROOM_ID,
        'm.room.power_levels',
        '',
      );

      client.getStateEvent.mockRejectedValueOnce(
        new MatrixError({ errcode: 'M_NOT_FOUND', error: 'none' }, 404),
      );
      expect(
        await firstValueFrom(engine.stateEvent(ME, ROOM_ID, 't', '')),
      ).toEqual({ ok: true, value: null });

      client.getStateEvent.mockRejectedValueOnce(
        new MatrixError({ errcode: 'M_FORBIDDEN', error: 'no' }, 403),
      );
      expect(
        await firstValueFrom(engine.stateEvent(ME, ROOM_ID, 't', '')),
      ).toMatchObject({ ok: false, failure: { code: 'request-failed' } });
    });

    it('answer a refusal as request-failed with its status and errcode', async () => {
      const { engine, client } = setup();
      client.reportRoom.mockRejectedValueOnce(
        new MatrixError({ errcode: 'M_NOT_FOUND', error: 'no room' }, 404),
      );

      const result = await firstValueFrom(engine.reportRoom(ME, ROOM_ID, ''));

      expect(result).toEqual({
        ok: false,
        failure: {
          kind: 'http',
          code: 'request-failed',
          diagnostic: { kind: 'http', httpStatus: 404, errcode: 'M_NOT_FOUND' },
        },
      });
    });
  });

  describe('invite and upgradeRoom', () => {
    it('call the client and answer the replacement room', async () => {
      const { engine, client } = setup();

      expect(await firstValueFrom(engine.invite(ME, ROOM_ID, CO))).toEqual({
        ok: true,
        value: null,
      });
      expect(
        await firstValueFrom(engine.upgradeRoom(ME, ROOM_ID, '12', [CO])),
      ).toEqual({ ok: true, value: { replacementRoomId: '!new:example.org' } });
      await firstValueFrom(engine.upgradeRoom(ME, ROOM_ID, '11', null));

      expect(client.invite).toHaveBeenCalledWith(ROOM_ID, CO);
      expect(client.upgradeRoom.mock.calls).toEqual([
        [ROOM_ID, '12', [CO]],
        [ROOM_ID, '11', undefined],
      ]);
    });
  });

  describe('enableEncryption', () => {
    const MEGOLM = { algorithm: 'm.megolm.v1.aes-sha2' };
    const notFound = () =>
      Promise.reject(
        new MatrixError({ errcode: 'M_NOT_FOUND', error: 'none' }, 404),
      );

    /** A crypto backend that answers `store` until applied, then `applied`. */
    function withCrypto(
      fixture: ReturnType<typeof setup>,
      {
        store = () => Promise.resolve(false),
        applied = () => Promise.resolve(true),
        onCryptoEvent = async () => undefined,
        sink = true,
      }: {
        store?: () => Promise<boolean>;
        applied?: () => Promise<boolean>;
        onCryptoEvent?: (room: unknown, event: MatrixEvent) => Promise<void>;
        sink?: boolean;
      } = {},
    ) {
      let done = false;
      const apply = vi.fn(async (room: unknown, event: MatrixEvent) => {
        await onCryptoEvent(room, event);
        done = true;
      });
      fixture.client.getCrypto = () => ({
        isEncryptionEnabledInRoom: () => (done ? applied() : store()),
        ...(sink ? { onCryptoEvent: apply } : {}),
      });
      return apply;
    }

    it('sends the Megolm content new rooms get and applies it here', async () => {
      const fixture = setup();
      const apply = withCrypto(fixture);
      fixture.client.getStateEvent.mockImplementationOnce(notFound);

      const command = fixture.engine.enableEncryption(ME, ROOM_ID);
      expect(fixture.sendStateEvent).not.toHaveBeenCalled();

      expect(await firstValueFrom(command)).toEqual({ ok: true, value: null });
      expect(fixture.client.getStateEvent).toHaveBeenCalledWith(
        ROOM_ID,
        'm.room.encryption',
        '',
      );
      expect(fixture.sendStateEvent).toHaveBeenCalledExactlyOnceWith(
        ROOM_ID,
        'm.room.encryption',
        MEGOLM,
        '',
      );
      const [room, event] = apply.mock.calls[0];
      expect((room as { roomId: string }).roomId).toBe(ROOM_ID);
      expect(event.getType()).toBe('m.room.encryption');
      expect(event.getStateKey()).toBe('');
      expect(event.getContent()).toEqual(MEGOLM);
    });

    it("adopts the server's event instead of sending a second one", async () => {
      const fixture = setup();
      const apply = withCrypto(fixture);
      const onServer = { ...MEGOLM, rotation_period_ms: 604_800_000 };
      fixture.client.getStateEvent.mockResolvedValueOnce(onServer);

      expect(
        await firstValueFrom(fixture.engine.enableEncryption(ME, ROOM_ID)),
      ).toEqual({ ok: true, value: null });
      expect(fixture.sendStateEvent).not.toHaveBeenCalled();
      expect(apply.mock.calls[0][1].getContent()).toEqual(onServer);
    });

    it.each([
      ['room state says so', { encrypted: true }, {}],
      ['the crypto store says so', {}, { store: () => Promise.resolve(true) }],
      [
        'the crypto store cannot answer',
        {},
        { store: () => Promise.reject(new Error('store unavailable')) },
      ],
    ])(
      'is already-encrypted, sending nothing, when %s',
      async (_label, options, crypto) => {
        const fixture = setup(options);
        const apply = withCrypto(fixture, crypto);

        expect(
          await firstValueFrom(fixture.engine.enableEncryption(ME, ROOM_ID)),
        ).toMatchObject({ ok: false, failure: { code: 'already-encrypted' } });
        expect(fixture.client.getStateEvent).not.toHaveBeenCalled();
        expect(fixture.sendStateEvent).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
      },
    );

    it('answers request-failed and applies nothing when the server read or send fails', async () => {
      const fixture = setup();
      const apply = withCrypto(fixture);
      fixture.client.getStateEvent.mockRejectedValueOnce(
        new MatrixError({ errcode: 'M_UNKNOWN', error: 'busy' }, 500),
      );
      expect(
        await firstValueFrom(fixture.engine.enableEncryption(ME, ROOM_ID)),
      ).toMatchObject({ ok: false, failure: { code: 'request-failed' } });
      expect(fixture.sendStateEvent).not.toHaveBeenCalled();

      fixture.client.getStateEvent.mockImplementationOnce(notFound);
      fixture.sendStateEvent.mockRejectedValueOnce(
        new MatrixError({ errcode: 'M_FORBIDDEN', error: 'no' }, 403),
      );
      expect(
        await firstValueFrom(fixture.engine.enableEncryption(ME, ROOM_ID)),
      ).toMatchObject({
        ok: false,
        failure: { code: 'request-failed', kind: 'permission' },
      });
      expect(apply).not.toHaveBeenCalled();
    });

    it.each([
      ['the backend cannot apply it', { sink: false }],
      [
        'applying it throws',
        { onCryptoEvent: () => Promise.reject(new Error('mismatch')) },
      ],
      [
        'the store does not read back encrypted',
        { applied: () => Promise.resolve(false) },
      ],
    ])(
      'is encryption-not-applied after sending when %s',
      async (_l, crypto) => {
        const fixture = setup();
        withCrypto(fixture, crypto);
        fixture.client.getStateEvent.mockImplementationOnce(notFound);

        expect(
          await firstValueFrom(fixture.engine.enableEncryption(ME, ROOM_ID)),
        ).toMatchObject({
          ok: false,
          failure: { code: 'encryption-not-applied' },
        });
        expect(fixture.sendStateEvent).toHaveBeenCalledTimes(1);
      },
    );

    it('fails without a live account or a known room', async () => {
      const { engine, setKnown } = setup();
      setKnown(false);
      const codes = await Promise.all(
        [
          engine.enableEncryption('@nobody:example.org', ROOM_ID),
          engine.enableEncryption(ME, ROOM_ID),
        ].map(async (command) => {
          const result = await firstValueFrom(command);
          return result.ok ? null : result.failure.code;
        }),
      );
      expect(codes).toEqual(['account-not-live', 'room-unavailable']);
    });
  });

  describe('linkingSpaces', () => {
    /** A room the client holds; `state: null` has no live state loaded. */
    function held(
      roomId: string,
      {
        name = roomId,
        space = true,
        membership = 'join',
        events = [],
        state = new RoomState(roomId),
      }: {
        name?: string;
        space?: boolean;
        membership?: string;
        events?: [string, string, Record<string, unknown>][];
        state?: RoomState | null;
      } = {},
    ) {
      state?.setStateEvents(
        [['m.room.create', '', { room_version: '10' }] as const, ...events].map(
          ([type, key, content]) => stateEvent(type, key, CO, content, roomId),
        ),
      );
      return {
        roomId,
        name,
        isSpaceRoom: () => space,
        getMyMembership: () => membership,
        getMember: (userId: string) => state?.getMember(userId) ?? null,
        getLiveTimeline: () => ({ getState: () => state ?? undefined }),
      };
    }
    const child = (
      via: string[],
    ): [string, string, Record<string, unknown>] => [
      'm.space.child',
      ROOM_ID,
      { via },
    ];
    const levels = { users: { [CO]: 100 }, events: { 'm.space.child': 100 } };

    it('lists joined spaces linking the room, and unloaded ones its parent events name', async () => {
      const fixture = setup();
      fixture.state.setStateEvents([
        stateEvent('m.space.parent', '!pending:example.org', ME, { via: [] }),
      ]);
      fixture.client.getRooms.mockReturnValue([
        fixture.getRoom(ROOM_ID),
        held('!design:example.org', {
          name: 'Design',
          events: [child(['example.org']), ['m.room.power_levels', '', levels]],
        }),
        held('!removed:example.org', { name: 'Removed', events: [child([])] }),
        held('!unlinked:example.org', {
          events: [
            ['m.space.child', '!other:example.org', { via: ['example.org'] }],
          ],
        }),
        held('!left:example.org', {
          membership: 'leave',
          events: [child(['example.org'])],
        }),
        held('!plain:example.org', {
          space: false,
          events: [child(['example.org'])],
        }),
        held('!pending:example.org', { name: 'Pending', state: null }),
        held('!unnamed:example.org', { state: null }),
      ]);

      const result = await firstValueFrom(
        fixture.engine.linkingSpaces(ME, ROOM_ID),
      );

      expect(() => assertPlainData(result)).not.toThrow();
      expect(result).toEqual({
        ok: true,
        value: [
          {
            spaceId: '!design:example.org',
            name: 'Design',
            childContent: { via: ['example.org'] },
            ownPower: 0,
            powerLevels: levels,
          },
          {
            spaceId: '!removed:example.org',
            name: 'Removed',
            childContent: { via: [] },
            ownPower: 0,
            powerLevels: null,
          },
          {
            spaceId: '!pending:example.org',
            name: 'Pending',
            childContent: null,
            ownPower: 0,
            powerLevels: null,
          },
        ],
      });
    });

    it('fails without a live account or a known room', async () => {
      const { engine, setKnown } = setup();
      expect(
        await firstValueFrom(
          engine.linkingSpaces('@nobody:example.org', ROOM_ID),
        ),
      ).toMatchObject({ ok: false, failure: { code: 'account-not-live' } });
      setKnown(false);
      expect(
        await firstValueFrom(engine.linkingSpaces(ME, ROOM_ID)),
      ).toMatchObject({ ok: false, failure: { code: 'room-unavailable' } });
    });
  });

  it('members reports complete once a failed member load ends', async () => {
    const { engine, loadMembersIfNeeded } = setup();
    loadMembersIfNeeded.mockImplementationOnce(() =>
      Promise.reject(new Error('offline')),
    );
    const { seen } = watch<RoomMembers | null>(engine.members(ME, ROOM_ID));
    await settle();

    expect(seen.map((members) => members?.complete)).toEqual([false, true]);
  });
});
