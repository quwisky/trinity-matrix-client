import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ThemeService } from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WIDGET_EVENT_TYPE, WidgetsService } from './widgets.service';

interface WidgetFixture {
  id: string;
  content: Record<string, unknown>;
  sender?: string;
}

function widgetEvent(fixture: WidgetFixture) {
  return {
    getStateKey: () => fixture.id,
    getId: () => `$${fixture.id || 'empty'}`,
    getContent: () => fixture.content,
    getSender: () => fixture.sender,
  };
}

function liveEvent(type: string, roomId: string) {
  return { getType: () => type, getRoomId: () => roomId };
}

function handlerFor(client: { on: Mock }, event: string) {
  return client.on.mock.calls.find(([name]) => name === event)?.[1] as
    ((event: ReturnType<typeof liveEvent>) => void) | undefined;
}

function setup(initial: WidgetFixture[] = []) {
  const activeUserId = signal<string | null>('@alice:example.org');
  const membership = signal('join');
  const guest = signal(false);
  const maySendWidgets = signal(true);
  const events = initial.map(widgetEvent);
  const getStateEvents = vi.fn((type: string, stateKey?: string) => {
    if (type !== WIDGET_EVENT_TYPE) {
      return stateKey === undefined ? [] : null;
    }
    return stateKey === undefined
      ? events
      : (events.find((event) => event.getStateKey() === stateKey) ?? null);
  });
  const mayClientSendStateEvent = vi.fn(() => maySendWidgets());
  const room = {
    roomId: '!room:example.org',
    getMember: () => null,
    getMyMembership: () => membership(),
    getLiveTimeline: () => ({
      getState: () => ({ getStateEvents, mayClientSendStateEvent }),
    }),
  };
  const getRoom = vi.fn((roomId: string) =>
    roomId === '!room:example.org' ? room : null,
  );
  const client = {
    baseUrl: 'https://matrix.example.org',
    getRoom,
    getUserId: () => '@alice:example.org',
    getUser: () => null,
    getDeviceId: () => 'DEVICE',
    getHomeserverUrl: () => 'https://matrix.example.org',
    isGuest: () => guest(),
    mxcUrlToHttp: () => null,
    on: vi.fn(),
    off: vi.fn(),
  };
  const secondClient = {
    ...client,
    getUserId: () => '@bob:other.example',
    getDeviceId: () => 'OTHER-DEVICE',
    getHomeserverUrl: () => 'https://matrix.other.example',
  };
  const matrix = {
    isInitialized: true,
    get instance() {
      return activeUserId() === '@bob:other.example' ? secondClient : client;
    },
    activeUserId: activeUserId.asReadonly(),
  };
  TestBed.configureTestingModule({
    providers: [
      WidgetsService,
      { provide: MatrixClientService, useValue: matrix },
      MockProvider(ThemeService, { resolved: signal<'dark'>('dark') }),
    ],
  });
  return {
    service: TestBed.inject(WidgetsService),
    events,
    getStateEvents,
    getRoom,
    client,
    activeUserId,
    membership,
    guest,
    maySendWidgets,
  };
}

describe('WidgetsService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('seeds a watched room synchronously and normalizes widget metadata', () => {
    const { service } = setup([
      {
        id: 'board',
        sender: '@alice:example.org',
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
    ]);

    expect(service.widgetsFor('!room:example.org')()).toEqual([
      {
        id: 'board',
        name: 'Planning',
        type: 'm.custom',
        rawUrl: 'https://widgets.example/$matrix_room_id',
        data: { title: 'Fallback title', board: 'roadmap' },
        creatorUserId: '@alice:example.org',
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
    ]);
  });

  it('prefers a declared creator and validates iframe-load behavior', () => {
    const { service } = setup([
      {
        id: 'board',
        sender: '@sender:example.org',
        content: {
          creatorUserId: ' @creator:example.org ',
          type: 'm.custom',
          url: 'https://widgets.example',
          waitForIframeLoad: 'false',
        },
      },
    ]);

    expect(service.widgetsFor('!room:example.org')()[0]).toEqual(
      expect.objectContaining({
        creatorUserId: '@creator:example.org',
        waitForIframeLoad: true,
      }),
    );
  });

  it('publishes creator and iframe-load changes from room state', async () => {
    const { service, client, events } = setup([
      {
        id: 'board',
        sender: '@sender:example.org',
        content: {
          type: 'm.custom',
          url: 'https://widgets.example',
          waitForIframeLoad: true,
        },
      },
    ]);
    const widgets = service.widgetsFor('!room:example.org');
    service.connect('!room:example.org');
    events[0] = widgetEvent({
      id: 'board',
      sender: '@new-sender:example.org',
      content: {
        type: 'm.custom',
        url: 'https://widgets.example',
        waitForIframeLoad: false,
      },
    });

    handlerFor(
      client,
      'RoomState.events',
    )?.(liveEvent(WIDGET_EVENT_TYPE, '!room:example.org'));
    await Promise.resolve();

    expect(widgets()[0]).toEqual(
      expect.objectContaining({
        creatorUserId: '@new-sender:example.org',
        waitForIframeLoad: false,
      }),
    );
  });

  it('drops tombstones and malformed declarations but keeps unsafe URLs visible', () => {
    const { service } = setup([
      { id: 'gone', content: {} },
      { id: 'no-type', content: { url: 'https://widgets.example' } },
      { id: 'blank', content: { type: ' ', url: ' ' } },
      { id: '', content: { type: 'm.custom', url: 'https://example.org' } },
      {
        id: 'unsafe',
        content: { type: 'm.custom', url: 'javascript:alert(1)' },
      },
    ]);

    expect(service.widgetsFor('!room:example.org')()).toEqual([
      expect.objectContaining({ id: 'unsafe', rawUrl: 'javascript:alert(1)' }),
    ]);
  });

  it('memoizes the readonly signal for each watched room', () => {
    const { service } = setup();

    expect(service.widgetsFor('!room:example.org')).toBe(
      service.widgetsFor('!room:example.org'),
    );
  });

  it('projects joined, non-guest power authorization and updates it live', async () => {
    const { service, client, membership, guest, maySendWidgets } = setup();
    const canManage = service.canManageFor('!room:example.org');
    service.connect('!room:example.org');

    expect(canManage()).toBe(true);

    maySendWidgets.set(false);
    handlerFor(
      client,
      'RoomState.events',
    )?.(liveEvent('m.room.power_levels', '!room:example.org'));
    await Promise.resolve();
    expect(canManage()).toBe(false);

    maySendWidgets.set(true);
    membership.set('leave');
    const membershipHandler = client.on.mock.calls.find(
      ([name]) => name === 'Room.myMembership',
    )?.[1] as ((room: { roomId: string }) => void) | undefined;
    membershipHandler?.({ roomId: '!room:example.org' });
    await Promise.resolve();
    expect(canManage()).toBe(false);

    membership.set('join');
    guest.set(true);
    membershipHandler?.({ roomId: '!room:example.org' });
    await Promise.resolve();
    expect(canManage()).toBe(false);

    guest.set(false);
    membershipHandler?.({ roomId: '!room:example.org' });
    await Promise.resolve();
    expect(canManage()).toBe(true);
  });

  it('follows relevant live state and coalesces a sync burst', async () => {
    const { service, client, events, getStateEvents } = setup();
    const widgets = service.widgetsFor('!room:example.org');
    service.connect('!room:example.org');
    const readsBefore = getStateEvents.mock.calls.length;
    events.push(
      widgetEvent({
        id: 'board',
        content: { type: 'm.custom', url: 'https://widgets.example' },
      }),
    );

    const onState = handlerFor(client, 'RoomState.events');
    onState?.(liveEvent(WIDGET_EVENT_TYPE, '!room:example.org'));
    onState?.(liveEvent(WIDGET_EVENT_TYPE, '!room:example.org'));
    await Promise.resolve();

    expect(widgets().map((item) => item.id)).toEqual(['board']);
    expect(getStateEvents).toHaveBeenCalledTimes(readsBefore + 1);
  });

  it('ignores other event types and unwatched rooms', async () => {
    const { service, client, getStateEvents } = setup();
    service.widgetsFor('!room:example.org');
    service.connect('!room:example.org');
    const readsBefore = getStateEvents.mock.calls.length;
    const onState = handlerFor(client, 'RoomState.events');

    onState?.(liveEvent('m.room.name', '!room:example.org'));
    onState?.(liveEvent(WIDGET_EVENT_TYPE, '!unwatched:example.org'));
    await Promise.resolve();

    expect(getStateEvents).toHaveBeenCalledTimes(readsBefore);
  });

  it('detaches, clears watched values, and cancels a queued rebuild', async () => {
    const { service, client, getStateEvents } = setup([
      {
        id: 'board',
        content: { type: 'm.custom', url: 'https://widgets.example' },
      },
    ]);
    const widgets = service.widgetsFor('!room:example.org');
    service.connect('!room:example.org');
    const readsBefore = getStateEvents.mock.calls.length;
    handlerFor(
      client,
      'RoomState.events',
    )?.(liveEvent(WIDGET_EVENT_TYPE, '!room:example.org'));

    service.disconnect('!room:example.org');
    await Promise.resolve();

    expect(client.off).toHaveBeenCalledWith(
      'RoomState.events',
      expect.any(Function),
    );
    expect(widgets()).toEqual([]);
    expect(getStateEvents).toHaveBeenCalledTimes(readsBefore);
  });

  it('labels a display-name fallback as the Matrix user ID it actually sends', () => {
    const { service } = setup();

    const launch = service.launchFor('!room:example.org', {
      id: 'board',
      name: 'Board',
      type: 'm.custom',
      rawUrl: 'https://widgets.example/?name=$matrix_display_name',
      data: {},
      creatorUserId: '@alice:example.org',
      waitForIframeLoad: true,
      sourceEventId: '$board',
    });

    expect(new URL(launch.url as string).searchParams.get('name')).toBe(
      '@alice:example.org',
    );
    expect(launch.disclosures).toEqual([
      { kind: 'user-id', label: 'your Matrix user ID' },
    ]);
  });

  it('recomputes launch identity when the active account changes', () => {
    const { service, activeUserId } = setup();
    service.connect('!room:example.org');
    const launch = computed(() =>
      service.launchFor('!room:example.org', {
        id: 'board',
        name: 'Board',
        type: 'm.custom',
        rawUrl:
          'https://widgets.example/?user=$matrix_user_id' +
          '&device=$org.matrix.msc3819.matrix_device_id' +
          '&base=$org.matrix.msc4039.matrix_base_url',
        data: {},
        creatorUserId: '@alice:example.org',
        waitForIframeLoad: true,
        sourceEventId: '$board',
      }),
    );

    expect(new URL(launch().url as string).searchParams.get('user')).toBe(
      '@alice:example.org',
    );

    activeUserId.set('@bob:other.example');

    expect(
      Object.fromEntries(new URL(launch().url as string).searchParams),
    ).toEqual({
      user: '@bob:other.example',
      device: 'OTHER-DEVICE',
      base: 'https://matrix.other.example',
    });
  });

  it('keeps the shared listener alive until overlapping rooms both release it', () => {
    const { service, client } = setup([
      {
        id: 'board',
        content: { type: 'm.custom', url: 'https://widgets.example' },
      },
    ]);
    const first = service.widgetsFor('!room:example.org');
    const second = service.widgetsFor('!second:example.org');
    service.connect('!room:example.org');
    service.connect('!second:example.org');

    service.disconnect('!room:example.org');

    expect(first()).toEqual([]);
    expect(client.off).not.toHaveBeenCalled();

    service.disconnect('!second:example.org');

    expect(second()).toEqual([]);
    expect(client.off).toHaveBeenCalledTimes(2);
    expect(client.off).toHaveBeenCalledWith(
      'RoomState.events',
      expect.any(Function),
    );
    expect(client.off).toHaveBeenCalledWith(
      'Room.myMembership',
      expect.any(Function),
    );
  });

  it('prunes a released room before a later room reconnects', () => {
    const { service, getRoom } = setup();
    service.widgetsFor('!room:example.org');
    service.connect('!room:example.org');
    service.disconnect('!room:example.org');
    getRoom.mockClear();

    service.widgetsFor('!second:example.org');
    service.connect('!second:example.org');

    expect(getRoom).not.toHaveBeenCalledWith('!room:example.org');
    expect(getRoom).toHaveBeenCalledWith('!second:example.org');
  });
});
