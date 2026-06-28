import { Router } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { RoomEvent } from 'matrix-js-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from './notification.service';
import { MatrixClientService } from './matrix-client.service';

const cap = vi.hoisted(() => ({ native: false }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => cap.native },
}));

class MockNotification {
  static permission = 'granted';
  static requestPermission = vi.fn(async () => 'granted');
  static instances: MockNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options?: { body?: string; tag?: string },
  ) {
    MockNotification.instances.push(this);
  }
}

function setup() {
  const client = {
    getUserId: () => '@me:hs',
    getPushActionsForEvent: vi.fn(() => ({ notify: true, tweaks: {} })),
    on: vi.fn(),
    off: vi.fn(),
  };
  const matrix = {
    isInitialized: true,
    instance: client,
  } as unknown as MatrixClientService;
  const router = { navigate: vi.fn(() => Promise.resolve(true)) };
  TestBed.configureTestingModule({
    providers: [
      NotificationService,
      { provide: MatrixClientService, useValue: matrix },
      { provide: Router, useValue: router },
    ],
  });
  return { svc: TestBed.inject(NotificationService), client, router };
}

function event(opts: { sender?: string; body?: string } = {}) {
  return {
    getSender: () => opts.sender ?? '@alice:hs',
    sender: { name: 'Alice' },
    getContent: () => ({ body: opts.body ?? 'hello there' }),
  };
}
const room = { roomId: '!r:hs', name: 'General' };
const live = { liveEvent: true };

/** Grab the RoomEvent.Timeline handler registered via client.on. */
function timelineHandler(client: { on: { mock: { calls: unknown[][] } } }) {
  const call = client.on.mock.calls.find((c) => c[0] === RoomEvent.Timeline);
  return call?.[1] as (...args: unknown[]) => void;
}

describe('NotificationService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    cap.native = false;
    MockNotification.permission = 'granted';
    MockNotification.instances = [];
    MockNotification.requestPermission.mockClear();
    vi.stubGlobal('Notification', MockNotification);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // window unfocused
  });
  afterEach(() => vi.unstubAllGlobals());

  it('attaches a timeline listener and requests permission when undecided', () => {
    MockNotification.permission = 'default';
    const { svc, client } = setup();

    svc.connect();

    expect(client.on).toHaveBeenCalledWith(
      RoomEvent.Timeline,
      expect.any(Function),
    );
    expect(MockNotification.requestPermission).toHaveBeenCalled();
  });

  it('notifies on a live message from someone else while unfocused', () => {
    const { svc, client } = setup();
    svc.connect();

    timelineHandler(client)(event(), room, false, false, live);

    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0].title).toBe('Alice · General');
    expect(MockNotification.instances[0].options).toMatchObject({
      body: 'hello there',
      tag: '!r:hs',
    });
  });

  it('ignores the user’s own messages', () => {
    const { svc, client } = setup();
    svc.connect();

    timelineHandler(client)(
      event({ sender: '@me:hs' }),
      room,
      false,
      false,
      live,
    );

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('stays quiet when the window is focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { svc, client } = setup();
    svc.connect();

    timelineHandler(client)(event(), room, false, false, live);

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('respects push rules (no notify when the event should not notify)', () => {
    const { svc, client } = setup();
    client.getPushActionsForEvent.mockReturnValue({
      notify: false,
      tweaks: {},
    });
    svc.connect();

    timelineHandler(client)(event(), room, false, false, live);

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('ignores backfilled (non-live) events', () => {
    const { svc, client } = setup();
    svc.connect();

    timelineHandler(client)(event(), room, false, false, { liveEvent: false });

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('does not notify without granted permission', () => {
    MockNotification.permission = 'denied';
    const { svc, client } = setup();
    svc.connect();

    timelineHandler(client)(event(), room, false, false, live);

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('is a no-op on native mobile (push owns delivery there)', () => {
    cap.native = true;
    const { svc, client } = setup();

    svc.connect();

    expect(client.on).not.toHaveBeenCalled();
  });

  it('focuses + routes to /rooms when a notification is clicked', () => {
    const { svc, client, router } = setup();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    svc.connect();
    timelineHandler(client)(event(), room, false, false, live);

    MockNotification.instances[0].onclick?.();

    expect(focus).toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/rooms']);
  });

  it('swallows errors so a notification failure cannot disrupt sync', () => {
    const { svc, client } = setup();
    client.getPushActionsForEvent.mockImplementation(() => {
      throw new Error('boom');
    });
    svc.connect();
    const handler = timelineHandler(client);

    expect(() => handler(event(), room, false, false, live)).not.toThrow();
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('disconnect detaches the listener', () => {
    const { svc, client } = setup();
    svc.connect();

    svc.disconnect();

    expect(client.off).toHaveBeenCalledWith(
      RoomEvent.Timeline,
      expect.any(Function),
    );
  });
});
