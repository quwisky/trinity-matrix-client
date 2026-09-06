import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WIDGET_APPEARANCE_PROJECTION } from './widget-appearance-projection';
import { WIDGET_EVENT_TYPE, WidgetsService } from './widgets.service';

const TARGET = {
  accountId: '@alice:example.org',
  roomId: '!room:example.org',
} as const;
const SECOND_TARGET = { ...TARGET, roomId: '!second:example.org' } as const;

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
  const resolvedAppearance = signal<{ readonly mode: 'light' | 'dark' }>({
    mode: 'dark',
  });
  const activeUserId = signal<string | null>('@alice:example.org');
  const accountIds = signal<readonly string[]>([
    '@alice:example.org',
    '@bob:other.example',
  ]);
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
    accountIds: accountIds.asReadonly(),
    clientFor: (accountId: string) =>
      !accountIds().includes(accountId)
        ? null
        : accountId === '@alice:example.org'
          ? client
          : accountId === '@bob:other.example'
            ? secondClient
            : null,
  };
  TestBed.configureTestingModule({
    providers: [
      WidgetsService,
      { provide: MatrixClientService, useValue: matrix },
      {
        provide: WIDGET_APPEARANCE_PROJECTION,
        useValue: { resolved: resolvedAppearance.asReadonly() },
      },
    ],
  });
  return {
    service: TestBed.inject(WidgetsService),
    events,
    getStateEvents,
    getRoom,
    client,
    activeUserId,
    accountIds,
    membership,
    guest,
    maySendWidgets,
    resolvedAppearance,
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

    expect(service.widgetsFor(TARGET)()).toEqual([
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

    expect(service.widgetsFor(TARGET)()[0]).toEqual(
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
    const widgets = service.widgetsFor(TARGET);
    service.connect(TARGET);
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

    expect(service.widgetsFor(TARGET)()).toEqual([
      expect.objectContaining({ id: 'unsafe', rawUrl: 'javascript:alert(1)' }),
    ]);
  });

  it('memoizes the readonly signal for each watched room', () => {
    const { service } = setup();

    expect(service.widgetsFor(TARGET)).toBe(service.widgetsFor({ ...TARGET }));
  });

  it('projects joined, non-guest power authorization and updates it live', async () => {
    const { service, client, membership, guest, maySendWidgets } = setup();
    const canManage = service.canManageFor(TARGET);
    service.connect(TARGET);

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
    const widgets = service.widgetsFor(TARGET);
    service.connect(TARGET);
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
    service.widgetsFor(TARGET);
    service.connect(TARGET);
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
    const widgets = service.widgetsFor(TARGET);
    service.connect(TARGET);
    const readsBefore = getStateEvents.mock.calls.length;
    handlerFor(
      client,
      'RoomState.events',
    )?.(liveEvent(WIDGET_EVENT_TYPE, '!room:example.org'));

    service.disconnect(TARGET);
    await Promise.resolve();

    expect(client.off).toHaveBeenCalledWith(
      'RoomState.events',
      expect.any(Function),
    );
    expect(widgets()).toEqual([]);
    expect(getStateEvents).toHaveBeenCalledTimes(readsBefore);
  });

  it('releases and restores the exact Account without following the active client', async () => {
    const { service, client, accountIds } = setup([
      {
        id: 'board',
        content: { type: 'm.custom', url: 'https://widgets.example' },
      },
    ]);
    const widgets = service.widgetsFor(TARGET);
    service.connect(TARGET);
    expect(widgets()).toHaveLength(1);

    accountIds.set(['@bob:other.example']);
    await vi.waitFor(() => expect(widgets()).toEqual([]));
    expect(client.off).toHaveBeenCalledWith(
      'RoomState.events',
      expect.any(Function),
    );

    accountIds.set(['@alice:example.org', '@bob:other.example']);
    await vi.waitFor(() => expect(widgets()).toHaveLength(1));
  });

  it('labels a display-name fallback as the Matrix user ID it actually sends', () => {
    const { service } = setup();

    const launch = service.launchFor(TARGET, {
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

  it('reads widget theme disclosure from the application Appearance projection', () => {
    const { service, resolvedAppearance } = setup();
    const widget = {
      id: 'board',
      name: 'Board',
      type: 'm.custom',
      rawUrl: 'https://widgets.example/?theme=$org.matrix.msc2873.client_theme',
      data: {},
      creatorUserId: '@alice:example.org',
      waitForIframeLoad: true,
      sourceEventId: '$board',
    } as const;

    expect(
      new URL(service.launchFor(TARGET, widget).url as string).searchParams.get(
        'theme',
      ),
    ).toBe('dark');

    resolvedAppearance.set({ mode: 'light' });

    expect(
      new URL(service.launchFor(TARGET, widget).url as string).searchParams.get(
        'theme',
      ),
    ).toBe('light');
  });

  it('keeps launch identity on the opening Account when the active Account changes', () => {
    const { service, activeUserId } = setup();
    service.connect(TARGET);
    const launch = computed(() =>
      service.launchFor(TARGET, {
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
      user: '@alice:example.org',
      device: 'DEVICE',
      base: 'https://matrix.example.org',
    });
  });

  it('keeps an exact-target listener alive until overlapping consumers release it', () => {
    const { service, client } = setup([
      {
        id: 'board',
        content: { type: 'm.custom', url: 'https://widgets.example' },
      },
    ]);
    const first = service.widgetsFor(TARGET);
    const second = service.widgetsFor({ ...TARGET });
    service.connect(TARGET);
    service.connect({ ...TARGET });

    service.disconnect(TARGET);

    expect(first()).not.toEqual([]);
    expect(second()).toBe(first());
    expect(client.off).not.toHaveBeenCalled();

    service.disconnect({ ...TARGET });

    expect(first()).toEqual([]);
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
    service.widgetsFor(TARGET);
    service.connect(TARGET);
    service.disconnect(TARGET);
    getRoom.mockClear();

    service.widgetsFor(SECOND_TARGET);
    service.connect(SECOND_TARGET);

    expect(getRoom).not.toHaveBeenCalledWith('!room:example.org');
    expect(getRoom).toHaveBeenCalledWith('!second:example.org');
  });
});
