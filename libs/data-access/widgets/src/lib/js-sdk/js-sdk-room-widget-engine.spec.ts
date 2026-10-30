import { TestBed } from '@angular/core/testing';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { assertPlainData } from '@trinity/util/matrix';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { RoomWidgetSnapshot } from '../room-widget-engine';
import { WIDGET_EVENT_TYPE } from '../widget.model';
import { JsSdkRoomWidgetEngine } from './js-sdk-room-widget-engine';

const USER_ID = '@alice:example.org';
const ROOM_ID = '!room:example.org';

interface WidgetFixture {
  id: string;
  content: Record<string, unknown>;
  sender?: string;
  eventId?: string;
}

function widgetEvent(fixture: WidgetFixture) {
  return {
    getStateKey: () => fixture.id,
    getId: () => fixture.eventId ?? `$${fixture.id || 'empty'}`,
    getContent: () => fixture.content,
    getSender: () => fixture.sender,
  };
}

function liveEvent(type: string, roomId: string, stateKey = '') {
  return {
    getType: () => type,
    getRoomId: () => roomId,
    getStateKey: () => stateKey,
  };
}

function handlerFor(client: { on: Mock }, event: string) {
  return client.on.mock.calls.find(([name]) => name === event)?.[1] as
    ((event: unknown) => void) | undefined;
}

function setup(initial: WidgetFixture[] = []) {
  let membership = 'join';
  let guest = false;
  let maySend = true;
  let live = true;
  const events = initial.map(widgetEvent);
  const getStateEvents = vi.fn((type: string, stateKey?: string) => {
    if (type !== WIDGET_EVENT_TYPE) {
      return stateKey === undefined ? [] : null;
    }
    return stateKey === undefined
      ? events
      : (events.find((event) => event.getStateKey() === stateKey) ?? null);
  });
  const member = {
    rawDisplayName: 'Alice in room',
    getMxcAvatarUrl: () => 'mxc://example.org/avatar',
  };
  const room = {
    roomId: ROOM_ID,
    getMember: (userId: string) => (userId === USER_ID ? member : null),
    getMyMembership: () => membership,
    getLiveTimeline: () => ({
      getState: () => ({
        getStateEvents,
        mayClientSendStateEvent: () => maySend,
      }),
    }),
  };
  const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$written' });
  const client = {
    getRoom: vi.fn((roomId: string) => (roomId === ROOM_ID ? room : null)),
    getUserId: () => USER_ID,
    getUser: () => null,
    getDeviceId: () => 'DEVICE',
    getHomeserverUrl: () => 'https://matrix.example.org',
    isGuest: () => guest,
    mxcUrlToHttp: vi.fn(() => 'https://matrix.example.org/thumb'),
    sendStateEvent,
    on: vi.fn(),
    off: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: {
          clientFor: (accountId: string) =>
            live && accountId === USER_ID ? client : null,
        },
      },
    ],
  });
  return {
    engine: TestBed.inject(JsSdkRoomWidgetEngine),
    client,
    events,
    getStateEvents,
    sendStateEvent,
    member,
    setMembership: (value: string) => (membership = value),
    setGuest: (value: boolean) => (guest = value),
    setMaySend: (value: boolean) => (maySend = value),
    setLive: (value: boolean) => (live = value),
  };
}

function watch(engine: JsSdkRoomWidgetEngine, roomId = ROOM_ID) {
  const seen: RoomWidgetSnapshot[] = [];
  const subscription = engine
    .roomWidgets(USER_ID, roomId)
    .subscribe((snapshot) => {
      assertPlainData(snapshot);
      seen.push(snapshot);
    });
  return { seen, latest: () => seen.at(-1), subscription };
}

const CONTENT = {
  id: 'generated-id',
  name: 'Planning board',
  type: 'm.custom',
  url: 'https://widgets.example/$matrix_room_id',
  creatorUserId: USER_ID,
  data: {},
  waitForIframeLoad: true,
};

describe('JsSdkRoomWidgetEngine', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('roomWidgets', () => {
    it('emits synchronously and normalizes widget metadata', () => {
      const { engine } = setup([
        {
          id: 'board',
          sender: USER_ID,
          content: {
            name: 'Planning',
            type: 'm.custom',
            url: 'https://widgets.example/$matrix_room_id',
            data: { title: 'Fallback title', board: 'roadmap' },
            waitForIframeLoad: false,
          },
        },
        {
          id: 'titled',
          content: {
            type: 'm.custom',
            url: 'https://widgets.example/titled',
            data: { title: 'Title from data' },
          },
        },
        {
          id: 'creator',
          sender: '@sender:example.org',
          content: {
            creatorUserId: ' @creator:example.org ',
            type: 'm.custom',
            url: 'https://widgets.example',
            waitForIframeLoad: 'false',
          },
        },
      ]);

      const { latest } = watch(engine);

      expect(latest()).toEqual({
        widgets: [
          {
            id: 'board',
            name: 'Planning',
            type: 'm.custom',
            rawUrl: 'https://widgets.example/$matrix_room_id',
            data: { title: 'Fallback title', board: 'roadmap' },
            creatorUserId: USER_ID,
            waitForIframeLoad: false,
            sourceEventId: '$board',
          },
          {
            id: 'titled',
            name: 'Title from data',
            type: 'm.custom',
            rawUrl: 'https://widgets.example/titled',
            data: { title: 'Title from data' },
            creatorUserId: null,
            waitForIframeLoad: true,
            sourceEventId: '$titled',
          },
          {
            id: 'creator',
            name: 'Unnamed widget',
            type: 'm.custom',
            rawUrl: 'https://widgets.example',
            data: {},
            creatorUserId: '@creator:example.org',
            waitForIframeLoad: true,
            sourceEventId: '$creator',
          },
        ],
        canManage: true,
        identity: {
          userId: USER_ID,
          displayName: 'Alice in room',
          avatarUrl: 'https://matrix.example.org/thumb',
          deviceId: 'DEVICE',
          homeserverUrl: 'https://matrix.example.org',
        },
      });
    });

    it('drops tombstones and malformed declarations but keeps unsafe URLs visible', () => {
      const { engine } = setup([
        { id: 'gone', content: {} },
        { id: 'no-type', content: { url: 'https://widgets.example' } },
        { id: 'blank', content: { type: ' ', url: ' ' } },
        { id: '', content: { type: 'm.custom', url: 'https://example.org' } },
        {
          id: 'unsafe',
          content: { type: 'm.custom', url: 'javascript:alert(1)' },
        },
      ]);

      expect(watch(engine).latest()?.widgets).toEqual([
        expect.objectContaining({
          id: 'unsafe',
          rawUrl: 'javascript:alert(1)',
        }),
      ]);
    });

    it('emits the empty snapshot when the account is not live', () => {
      const { engine, setLive } = setup();
      setLive(false);

      expect(watch(engine).seen).toEqual([
        { widgets: [], canManage: false, identity: null },
      ]);
    });

    it('falls back to the user id when the account has no profile', () => {
      const { engine, client } = setup();
      client.getRoom.mockReturnValue(null);

      expect(watch(engine).latest()).toEqual({
        widgets: [],
        canManage: false,
        identity: {
          userId: USER_ID,
          displayName: USER_ID,
          avatarUrl: '',
          deviceId: 'DEVICE',
          homeserverUrl: 'https://matrix.example.org',
        },
      });
    });

    it('follows relevant live state and coalesces a sync burst', async () => {
      const { engine, client, events, getStateEvents } = setup();
      const { latest } = watch(engine);
      const readsBefore = getStateEvents.mock.calls.length;
      events.push(
        widgetEvent({
          id: 'board',
          content: { type: 'm.custom', url: 'https://widgets.example' },
        }),
      );

      const onState = handlerFor(client, 'RoomState.events');
      onState?.(liveEvent(WIDGET_EVENT_TYPE, ROOM_ID));
      onState?.(liveEvent(WIDGET_EVENT_TYPE, ROOM_ID));
      await Promise.resolve();

      expect(latest()?.widgets.map((item) => item.id)).toEqual(['board']);
      expect(getStateEvents).toHaveBeenCalledTimes(readsBefore + 1);
    });

    it('re-emits when the own room profile changes', async () => {
      const { engine, client, member } = setup();
      const { latest } = watch(engine);
      member.rawDisplayName = 'Renamed';

      handlerFor(
        client,
        'RoomState.events',
      )?.(liveEvent('m.room.member', ROOM_ID, USER_ID));
      await Promise.resolve();

      expect(latest()?.identity?.displayName).toBe('Renamed');
    });

    it('ignores other event types, other members and other rooms', async () => {
      const { engine, client, getStateEvents } = setup();
      watch(engine);
      const readsBefore = getStateEvents.mock.calls.length;
      const onState = handlerFor(client, 'RoomState.events');

      onState?.(liveEvent('m.room.name', ROOM_ID));
      onState?.(liveEvent('m.room.member', ROOM_ID, '@bob:example.org'));
      onState?.(liveEvent(WIDGET_EVENT_TYPE, '!unwatched:example.org'));
      await Promise.resolve();

      expect(getStateEvents).toHaveBeenCalledTimes(readsBefore);
    });

    it('projects joined, non-guest power authorization and updates it live', async () => {
      const { engine, client, setMembership, setGuest, setMaySend } = setup();
      const { latest } = watch(engine);
      expect(latest()?.canManage).toBe(true);

      setMaySend(false);
      handlerFor(
        client,
        'RoomState.events',
      )?.(liveEvent('m.room.power_levels', ROOM_ID));
      await Promise.resolve();
      expect(latest()?.canManage).toBe(false);

      setMaySend(true);
      setMembership('leave');
      const onMembership = handlerFor(client, 'Room.myMembership');
      onMembership?.({ roomId: ROOM_ID });
      await Promise.resolve();
      expect(latest()?.canManage).toBe(false);

      setMembership('join');
      setGuest(true);
      onMembership?.({ roomId: ROOM_ID });
      await Promise.resolve();
      expect(latest()?.canManage).toBe(false);

      setGuest(false);
      onMembership?.({ roomId: ROOM_ID });
      await Promise.resolve();
      expect(latest()?.canManage).toBe(true);
    });

    it('detaches on unsubscribe and cancels a queued rebuild', async () => {
      const { engine, client, getStateEvents } = setup();
      const { seen, subscription } = watch(engine);
      handlerFor(
        client,
        'RoomState.events',
      )?.(liveEvent(WIDGET_EVENT_TYPE, ROOM_ID));

      subscription.unsubscribe();
      const readsBefore = getStateEvents.mock.calls.length;
      await Promise.resolve();

      expect(client.off).toHaveBeenCalledWith(
        'RoomState.events',
        expect.any(Function),
      );
      expect(client.off).toHaveBeenCalledWith(
        'Room.myMembership',
        expect.any(Function),
      );
      expect(seen).toHaveLength(1);
      expect(getStateEvents).toHaveBeenCalledTimes(readsBefore);
    });

    it('stops publishing once the client is no longer the account client', async () => {
      const { engine, client, setLive } = setup();
      const { seen } = watch(engine);
      setLive(false);

      handlerFor(
        client,
        'RoomState.events',
      )?.(liveEvent(WIDGET_EVENT_TYPE, ROOM_ID));
      await Promise.resolve();

      expect(seen).toHaveLength(1);
    });
  });

  describe('putRoomWidget', () => {
    it('is cold and sends the exact payload under its id', async () => {
      const { engine, sendStateEvent } = setup();
      const put = engine.putRoomWidget(USER_ID, ROOM_ID, CONTENT);

      expect(sendStateEvent).not.toHaveBeenCalled();
      await expect(firstValueFrom(put)).resolves.toEqual({
        ok: true,
        value: null,
      });
      expect(sendStateEvent).toHaveBeenCalledWith(
        ROOM_ID,
        WIDGET_EVENT_TYPE,
        CONTENT,
        'generated-id',
      );
    });

    it('answers state-key-taken for an id room state already holds', async () => {
      const { engine, sendStateEvent } = setup([
        { id: 'generated-id', content: {} },
      ]);

      const result = await firstValueFrom(
        engine.putRoomWidget(USER_ID, ROOM_ID, CONTENT),
      );

      expect(!result.ok && result.failure.code).toBe('state-key-taken');
      expect(sendStateEvent).not.toHaveBeenCalled();
    });

    it.each([
      [
        'left member',
        (f: ReturnType<typeof setup>) => f.setMembership('leave'),
      ],
      ['guest', (f: ReturnType<typeof setup>) => f.setGuest(true)],
      [
        'insufficient power',
        (f: ReturnType<typeof setup>) => f.setMaySend(false),
      ],
    ])('answers forbidden for a %s', async (_label, deny) => {
      const fixture = setup();
      deny(fixture);

      const result = await firstValueFrom(
        fixture.engine.putRoomWidget(USER_ID, ROOM_ID, CONTENT),
      );

      expect(!result.ok && result.failure.code).toBe('forbidden');
      expect(fixture.sendStateEvent).not.toHaveBeenCalled();
    });

    it('answers not-signed-in for an unknown room', async () => {
      const { engine } = setup();

      const result = await firstValueFrom(
        engine.putRoomWidget(USER_ID, '!other:example.org', CONTENT),
      );

      expect(!result.ok && result.failure.code).toBe('not-signed-in');
    });
  });

  describe('removeRoomWidget', () => {
    const BOARD = {
      id: 'board',
      eventId: '$board-v1',
      content: { type: 'm.custom', url: 'https://widgets.example/board' },
    };

    it('tombstones only the exact active revision', async () => {
      const { engine, sendStateEvent } = setup([BOARD]);

      await expect(
        firstValueFrom(
          engine.removeRoomWidget(USER_ID, ROOM_ID, 'board', '$board-v1'),
        ),
      ).resolves.toEqual({ ok: true, value: null });
      expect(sendStateEvent).toHaveBeenCalledWith(
        ROOM_ID,
        WIDGET_EVENT_TYPE,
        {},
        'board',
      );
    });

    it.each([
      ['missing event', []],
      ['replaced event', [{ ...BOARD, eventId: '$board-v2' }]],
      ['tombstone', [{ ...BOARD, content: {} }]],
    ])('answers conflict for a %s', async (_label, initial) => {
      const { engine, sendStateEvent } = setup(initial);

      const result = await firstValueFrom(
        engine.removeRoomWidget(USER_ID, ROOM_ID, 'board', '$board-v1'),
      );

      expect(!result.ok && result.failure.code).toBe('conflict');
      expect(sendStateEvent).not.toHaveBeenCalled();
    });

    it('answers unsupported for a call widget in current state', async () => {
      const { engine, sendStateEvent } = setup([
        { ...BOARD, content: { type: 'm.jitsi', url: 'https://call.example' } },
      ]);

      const result = await firstValueFrom(
        engine.removeRoomWidget(USER_ID, ROOM_ID, 'board', '$board-v1'),
      );

      expect(!result.ok && result.failure.code).toBe('unsupported');
      expect(sendStateEvent).not.toHaveBeenCalled();
    });

    it('answers request-failed when the homeserver refuses the write', async () => {
      const { engine, sendStateEvent } = setup([BOARD]);
      sendStateEvent.mockRejectedValueOnce(new Error('M_FORBIDDEN'));

      const result = await firstValueFrom(
        engine.removeRoomWidget(USER_ID, ROOM_ID, 'board', '$board-v1'),
      );

      expect(!result.ok && result.failure.code).toBe('request-failed');
      expect(() => assertPlainData(result)).not.toThrow();
    });
  });
});
