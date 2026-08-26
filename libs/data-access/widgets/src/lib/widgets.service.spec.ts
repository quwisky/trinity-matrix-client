import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ThemeService } from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WIDGET_EVENT_TYPE, WidgetsService } from './widgets.service';

interface WidgetFixture {
  id: string;
  content: Record<string, unknown>;
}

function widgetEvent(fixture: WidgetFixture) {
  return {
    getStateKey: () => fixture.id,
    getContent: () => fixture.content,
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
  const events = initial.map(widgetEvent);
  const getStateEvents = vi.fn((type: string) =>
    type === WIDGET_EVENT_TYPE ? events : [],
  );
  const room = {
    getMember: () => null,
    getLiveTimeline: () => ({
      getState: () => ({ getStateEvents }),
    }),
  };
  const client = {
    baseUrl: 'https://matrix.example.org',
    getRoom: (roomId: string) => (roomId === '!room:example.org' ? room : null),
    getUserId: () => '@alice:example.org',
    getUser: () => null,
    getDeviceId: () => 'DEVICE',
    getHomeserverUrl: () => 'https://matrix.example.org',
    mxcUrlToHttp: () => null,
    on: vi.fn(),
    off: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      WidgetsService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client as never,
        activeUserId: signal<string | null>('@alice:example.org').asReadonly(),
      }),
      MockProvider(ThemeService, { resolved: signal<'dark'>('dark') }),
    ],
  });
  return {
    service: TestBed.inject(WidgetsService),
    events,
    getStateEvents,
    client,
  };
}

describe('WidgetsService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('seeds a watched room synchronously and normalizes widget metadata', () => {
    const { service } = setup([
      {
        id: 'board',
        content: {
          name: 'Planning',
          type: 'm.custom',
          url: 'https://widgets.example/$matrix_room_id',
          data: { title: 'Fallback title', board: 'roadmap' },
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
      },
      {
        id: 'titled',
        name: 'Title from data',
        type: 'm.custom',
        rawUrl: 'https://widgets.example/titled',
        data: { title: 'Title from data' },
      },
    ]);
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

  it('follows relevant live state and coalesces a sync burst', async () => {
    const { service, client, events, getStateEvents } = setup();
    const widgets = service.widgetsFor('!room:example.org');
    service.connect();
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
    service.connect();
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
    service.connect();
    const readsBefore = getStateEvents.mock.calls.length;
    handlerFor(
      client,
      'RoomState.events',
    )?.(liveEvent(WIDGET_EVENT_TYPE, '!room:example.org'));

    service.disconnect();
    await Promise.resolve();

    expect(client.off).toHaveBeenCalledWith(
      'RoomState.events',
      expect.any(Function),
    );
    expect(widgets()).toEqual([]);
    expect(getStateEvents).toHaveBeenCalledTimes(readsBefore);
  });
});
