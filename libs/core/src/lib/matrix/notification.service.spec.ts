import { Router } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { MatrixEventEvent, RoomEvent } from 'matrix-js-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from './notification.service';
import { MatrixClientService } from './matrix-client.service';
import { TimelineService } from './timeline.service';

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
    getRoom: vi.fn(() => room),
    on: vi.fn(),
    off: vi.fn(),
  };
  const matrix = {
    isInitialized: true,
    instance: client,
  } as unknown as MatrixClientService;
  const router = { navigate: vi.fn(() => Promise.resolve(true)) };
  const timeline = { openRoomId: null as string | null };
  TestBed.configureTestingModule({
    providers: [
      NotificationService,
      { provide: MatrixClientService, useValue: matrix },
      { provide: Router, useValue: router },
      { provide: TimelineService, useValue: timeline },
    ],
  });
  return {
    svc: TestBed.inject(NotificationService),
    client,
    router,
    timeline,
  };
}

/**
 * Fake of the Electron preload `trinityDesktop` bridge. `emitClick` invokes the
 * handler the service registered via `onNotificationClick`, simulating a click
 * forwarded by the main process.
 */
function desktopBridge() {
  let clickHandler: ((roomId: string) => void) | undefined;
  const unsubscribe = vi.fn();
  const bridge = {
    isElectron: true,
    platform: 'darwin',
    showNotification: vi.fn(),
    onNotificationClick: vi.fn((cb: (roomId: string) => void) => {
      clickHandler = cb;
      return unsubscribe;
    }),
  };
  return {
    bridge,
    unsubscribe,
    emitClick: (roomId: string): void => clickHandler?.(roomId),
  };
}

function event(
  opts: {
    sender?: string;
    body?: string;
    id?: string;
    /** Encrypted, with cleartext not yet available (ciphertext timeline emit). */
    encrypted?: boolean;
    /** Encrypted but already decrypted (clear content present). */
    decrypted?: boolean;
    /** Encrypted and decryption permanently failed. */
    failure?: boolean;
  } = {},
) {
  const isEncrypted = !!(opts.encrypted || opts.decrypted || opts.failure);
  const hasClear = !!opts.decrypted;
  return {
    getId: () => opts.id,
    getRoomId: () => '!r:hs',
    getSender: () => opts.sender ?? '@alice:hs',
    sender: { name: 'Alice' },
    getContent: () => ({ body: opts.body ?? 'hello there' }),
    isEncrypted: () => isEncrypted,
    getClearContent: () =>
      hasClear ? { body: opts.body ?? 'hello there' } : null,
    isDecryptionFailure: () => !!opts.failure,
  };
}
const room = { roomId: '!r:hs', name: 'General' };
const live = { liveEvent: true };

/** Grab the RoomEvent.Timeline handler registered via client.on. */
function timelineHandler(client: { on: { mock: { calls: unknown[][] } } }) {
  const call = client.on.mock.calls.find((c) => c[0] === RoomEvent.Timeline);
  return call?.[1] as (...args: unknown[]) => void;
}

/** Grab the MatrixEventEvent.Decrypted handler registered via client.on. */
function decryptedHandler(client: { on: { mock: { calls: unknown[][] } } }) {
  const call = client.on.mock.calls.find(
    (c) => c[0] === MatrixEventEvent.Decrypted,
  );
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

  it('stays quiet when focused on the room the message is in', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { svc, client, timeline } = setup();
    timeline.openRoomId = '!r:hs'; // the user is viewing this very room
    svc.connect();

    timelineHandler(client)(event(), room, false, false, live);

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('notifies for the open room when the window is unfocused (not actually looking)', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // window unfocused…
    const { svc, client, timeline } = setup();
    timeline.openRoomId = '!r:hs'; // …even though this very room is "open"
    svc.connect();

    timelineHandler(client)(event(), room, false, false, live);

    expect(MockNotification.instances).toHaveLength(1);
  });

  it('notifies for a message to a different (not open) room even while focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { svc, client, timeline } = setup();
    timeline.openRoomId = '!other:hs'; // user is looking at a different room
    svc.connect();

    timelineHandler(client)(event(), room, false, false, live);

    expect(MockNotification.instances).toHaveLength(1);
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

  it('disconnect detaches both listeners', () => {
    const { svc, client } = setup();
    svc.connect();

    svc.disconnect();

    expect(client.off).toHaveBeenCalledWith(
      RoomEvent.Timeline,
      expect.any(Function),
    );
    expect(client.off).toHaveBeenCalledWith(
      MatrixEventEvent.Decrypted,
      expect.any(Function),
    );
  });

  describe('E2EE (decryption-aware)', () => {
    it('attaches a decrypted listener too', () => {
      const { svc, client } = setup();
      svc.connect();

      expect(client.on).toHaveBeenCalledWith(
        MatrixEventEvent.Decrypted,
        expect.any(Function),
      );
    });

    it('does not notify on the ciphertext timeline emit, only on decrypt', () => {
      const { svc, client } = setup();
      svc.connect();
      const enc = event({ id: '$e1', encrypted: true });

      // Ciphertext arrives live — must NOT notify yet.
      timelineHandler(client)(enc, room, false, false, live);
      expect(MockNotification.instances).toHaveLength(0);

      // Now it decrypts — notify, recalculating push rules on the cleartext.
      decryptedHandler(client)(event({ id: '$e1', decrypted: true }));
      expect(MockNotification.instances).toHaveLength(1);
      expect(client.getPushActionsForEvent).toHaveBeenCalledWith(
        expect.anything(),
        true,
      );
    });

    it('ignores decryption of events it never saw live (backfill)', () => {
      const { svc, client } = setup();
      svc.connect();

      // No prior live timeline emit for $b1 → not pending → no notification.
      decryptedHandler(client)(event({ id: '$b1', decrypted: true }));

      expect(MockNotification.instances).toHaveLength(0);
    });

    it('does not notify when decryption fails', () => {
      const { svc, client } = setup();
      svc.connect();
      const enc = event({ id: '$e2', encrypted: true });

      timelineHandler(client)(enc, room, false, false, live);
      decryptedHandler(client)(event({ id: '$e2', failure: true }));

      expect(MockNotification.instances).toHaveLength(0);
    });

    it('notifies a decrypted event at most once', () => {
      const { svc, client } = setup();
      svc.connect();
      const enc = event({ id: '$e3', encrypted: true });

      timelineHandler(client)(enc, room, false, false, live);
      decryptedHandler(client)(event({ id: '$e3', decrypted: true }));
      // A re-decrypt (e.g. retry) must not double-notify.
      decryptedHandler(client)(event({ id: '$e3', decrypted: true }));

      expect(MockNotification.instances).toHaveLength(1);
    });
  });

  describe('web service worker', () => {
    afterEach(() => {
      // Drop the stubbed serviceWorker so other tests fall back to the ctor.
      Reflect.deleteProperty(navigator, 'serviceWorker');
    });

    function stubServiceWorker(showNotification = vi.fn()) {
      const registration = { showNotification };
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          controller: {},
          ready: Promise.resolve(registration),
        },
      });
      return { showNotification };
    }

    it('shows via the SW registration when one controls the page', async () => {
      const { showNotification } = stubServiceWorker();
      const { svc, client } = setup();
      svc.connect();

      timelineHandler(client)(event(), room, false, false, live);
      await Promise.resolve(); // let navigator.serviceWorker.ready resolve

      expect(showNotification).toHaveBeenCalledWith('Alice · General', {
        body: 'hello there',
        tag: '!r:hs',
        data: { roomId: '!r:hs' },
      });
      // Did NOT fall back to the renderer Notification constructor.
      expect(MockNotification.instances).toHaveLength(0);
    });

    it('falls back to the constructor when no SW controls the page', () => {
      const { svc, client } = setup();
      svc.connect();

      timelineHandler(client)(event(), room, false, false, live);

      expect(MockNotification.instances).toHaveLength(1);
    });

    it('treats a constructor throw as unsupported (no crash)', () => {
      vi.stubGlobal(
        'Notification',
        class {
          static permission = 'granted';
          constructor() {
            throw new Error('not supported on this platform');
          }
        },
      );
      const { svc, client } = setup();
      svc.connect();

      expect(() =>
        timelineHandler(client)(event(), room, false, false, live),
      ).not.toThrow();
    });
  });

  describe('desktop (Electron main-process bridge)', () => {
    let harness: ReturnType<typeof desktopBridge>;

    beforeEach(() => {
      harness = desktopBridge();
      vi.stubGlobal('trinityDesktop', harness.bridge);
    });

    it('routes notifications through the main process, not the Web API', () => {
      // Electron auto-grants Web permission and never prompts; the bridge path
      // must work regardless of the renderer Web permission state.
      MockNotification.permission = 'default';
      const { svc, client } = setup();
      svc.connect();

      expect(MockNotification.requestPermission).not.toHaveBeenCalled();
      expect(harness.bridge.onNotificationClick).toHaveBeenCalledTimes(1);

      timelineHandler(client)(event(), room, false, false, live);

      expect(harness.bridge.showNotification).toHaveBeenCalledTimes(1);
      expect(harness.bridge.showNotification).toHaveBeenCalledWith({
        title: 'Alice · General',
        body: 'hello there',
        tag: '!r:hs',
        roomId: '!r:hs',
      });
      // Did NOT fall back to the renderer Web Notification.
      expect(MockNotification.instances).toHaveLength(0);
    });

    it('notifies even when the Web Notification permission is not granted', () => {
      MockNotification.permission = 'denied';
      const { svc, client } = setup();
      svc.connect();

      timelineHandler(client)(event(), room, false, false, live);

      expect(harness.bridge.showNotification).toHaveBeenCalledTimes(1);
      expect(MockNotification.instances).toHaveLength(0);
    });

    it('still honors gating (own messages / focus / push rules)', () => {
      const { svc, client } = setup();
      svc.connect();

      timelineHandler(client)(
        event({ sender: '@me:hs' }),
        room,
        false,
        false,
        live,
      );

      expect(harness.bridge.showNotification).not.toHaveBeenCalled();
    });

    it('routes to the room when a forwarded click arrives', () => {
      const { svc, router } = setup();
      const focus = vi
        .spyOn(window, 'focus')
        .mockImplementation(() => undefined);
      svc.connect();

      harness.emitClick('!r:hs');

      expect(focus).toHaveBeenCalled();
      expect(router.navigate).toHaveBeenCalledWith(['/rooms'], {
        queryParams: { room: '!r:hs' },
      });
    });

    it('unsubscribes from main-process clicks on disconnect', () => {
      const { svc } = setup();
      svc.connect();

      svc.disconnect();

      expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
