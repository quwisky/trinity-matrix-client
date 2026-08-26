import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomWidget, WidgetLaunch } from './widget.model';
import {
  WidgetManagementError,
  WidgetManagementService,
} from './widget-management.service';
import { WidgetsService, WIDGET_EVENT_TYPE } from './widgets.service';

const ROOM_ID = '!room:example.org';
const USER_ID = '@alice:example.org';
const WIDGET: RoomWidget = {
  id: 'board',
  name: 'Planning board',
  type: 'm.custom',
  rawUrl: 'https://widgets.example/board',
  data: {},
  creatorUserId: USER_ID,
  waitForIframeLoad: true,
  sourceEventId: '$board-v1',
};

function stateEvent(
  id: string,
  eventId = `$${id}-v1`,
  content: Record<string, unknown> = {
    type: 'm.custom',
    url: `https://widgets.example/${id}`,
  },
) {
  return {
    getId: () => eventId,
    getContent: () => content,
  };
}

function setup() {
  let membership = 'join';
  let guest = false;
  let maySend = true;
  const events = new Map<string, ReturnType<typeof stateEvent>>();
  events.set(WIDGET.id, stateEvent(WIDGET.id, WIDGET.sourceEventId as string));
  const getStateEvents = vi.fn((_type: string, id?: string) =>
    id === undefined ? [...events.values()] : (events.get(id) ?? null),
  );
  const state = {
    getStateEvents,
    mayClientSendStateEvent: vi.fn(() => maySend),
  };
  const room = {
    getMyMembership: () => membership,
    getLiveTimeline: () => ({ getState: () => state }),
  };
  const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$written' });
  const client = {
    getRoom: vi.fn((roomId: string) => (roomId === ROOM_ID ? room : null)),
    getUserId: () => USER_ID,
    isGuest: () => guest,
    sendStateEvent,
  };
  const matrix = { isInitialized: true, instance: client };
  const launchFor = vi.fn(
    (_roomId: string, widget: RoomWidget): WidgetLaunch => ({
      url: widget.rawUrl,
      origin: new URL(widget.rawUrl).origin,
      disclosures: [],
      insecure: false,
      failure: null,
    }),
  );
  TestBed.configureTestingModule({
    providers: [
      WidgetManagementService,
      { provide: MatrixClientService, useValue: matrix },
      { provide: WidgetsService, useValue: { launchFor } },
    ],
  });
  return {
    service: TestBed.inject(WidgetManagementService),
    events,
    getStateEvents,
    launchFor,
    sendStateEvent,
    setMembership: (value: string) => (membership = value),
    setGuest: (value: boolean) => (guest = value),
    setMaySend: (value: boolean) => (maySend = value),
  };
}

describe('WidgetManagementService', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.unstubAllGlobals());

  it('is cold and sends the exact generic-widget payload after subscription', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'generated-id') });
    const { service, launchFor, sendStateEvent } = setup();
    const request = service.create(ROOM_ID, {
      name: '  Planning board  ',
      rawUrl: ' https://widgets.example/$matrix_room_id ',
    });

    expect(sendStateEvent).not.toHaveBeenCalled();
    await expect(firstValueFrom(request)).resolves.toBe('generated-id');

    expect(launchFor).toHaveBeenCalledWith(
      ROOM_ID,
      expect.objectContaining({ id: 'generated-id', type: 'm.custom' }),
    );
    expect(sendStateEvent).toHaveBeenCalledWith(
      ROOM_ID,
      WIDGET_EVENT_TYPE,
      {
        id: 'generated-id',
        name: 'Planning board',
        type: 'm.custom',
        url: 'https://widgets.example/$matrix_room_id',
        creatorUserId: USER_ID,
        data: {},
        waitForIframeLoad: true,
      },
      'generated-id',
    );
  });

  it('retries UUID collisions and never falls back to a predictable ID', async () => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce('taken')
      .mockReturnValueOnce('available');
    vi.stubGlobal('crypto', { randomUUID });
    const { service, events, sendStateEvent } = setup();
    events.set('taken', stateEvent('taken'));

    await firstValueFrom(
      service.create(ROOM_ID, {
        name: 'Board',
        rawUrl: 'https://widgets.example',
      }),
    );

    expect(randomUUID).toHaveBeenCalledTimes(2);
    expect(sendStateEvent).toHaveBeenCalledWith(
      ROOM_ID,
      WIDGET_EVENT_TYPE,
      expect.objectContaining({ id: 'available' }),
      'available',
    );
  });

  it.each([
    [
      'left member',
      (fixture: ReturnType<typeof setup>) => fixture.setMembership('leave'),
    ],
    ['guest', (fixture: ReturnType<typeof setup>) => fixture.setGuest(true)],
    [
      'insufficient power',
      (fixture: ReturnType<typeof setup>) => fixture.setMaySend(false),
    ],
  ])('denies a %s at subscription time', async (_label, deny) => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'generated-id') });
    const fixture = setup();
    const request = fixture.service.create(ROOM_ID, {
      name: 'Board',
      rawUrl: 'https://widgets.example',
    });
    deny(fixture);

    await expect(firstValueFrom(request)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(fixture.sendStateEvent).not.toHaveBeenCalled();
  });

  it('returns a typed validation failure without writing', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'generated-id') });
    const { service, sendStateEvent } = setup();

    await expect(
      firstValueFrom(
        service.create(ROOM_ID, {
          name: 'Board',
          rawUrl: 'https://user:secret@widgets.example',
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WidgetManagementError>>({
        code: 'invalid-draft',
        draftFailure: 'credentials',
      }),
    );
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('tombstones only the exact active revision that was confirmed', async () => {
    const { service, sendStateEvent } = setup();

    await expect(firstValueFrom(service.remove(ROOM_ID, WIDGET))).resolves.toBe(
      undefined,
    );
    expect(sendStateEvent).toHaveBeenCalledWith(
      ROOM_ID,
      WIDGET_EVENT_TYPE,
      {},
      WIDGET.id,
    );
  });

  it.each([
    ['missing event', null],
    ['replaced event', stateEvent(WIDGET.id, '$board-v2')],
    ['tombstone', stateEvent(WIDGET.id, '$board-v1', {})],
  ])('rejects a %s as a conflict', async (_label, replacement) => {
    const { service, events, sendStateEvent } = setup();
    if (replacement) {
      events.set(WIDGET.id, replacement);
    } else {
      events.delete(WIDGET.id);
    }

    await expect(
      firstValueFrom(service.remove(ROOM_ID, WIDGET)),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('refuses to remove call widgets', async () => {
    const { service, sendStateEvent } = setup();

    await expect(
      firstValueFrom(service.remove(ROOM_ID, { ...WIDGET, type: 'm.jitsi' })),
    ).rejects.toMatchObject({ code: 'unsupported-type' });
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('preserves homeserver write failures', async () => {
    const { service, sendStateEvent } = setup();
    sendStateEvent.mockRejectedValueOnce(new Error('M_FORBIDDEN'));

    await expect(
      firstValueFrom(service.remove(ROOM_ID, WIDGET)),
    ).rejects.toThrow('M_FORBIDDEN');
  });
});
