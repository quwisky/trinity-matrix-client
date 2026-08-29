import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { MatrixEventEvent, RoomEvent, type MatrixClient } from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from './notification.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { SessionStorageService } from '@trinity/platform-native';
import { encodeRoomSegment } from '@trinity/util/matrix';

const cap = vi.hoisted(() => ({ native: false }));
vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({})),
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

/** A client shaped like the bits NotificationService reads, keyed to one account. */
function fakeClient(userId: string, soundEnabled?: boolean) {
  return {
    getUserId: () => userId,
    // The sound preference is read from the account that OWNS the notification, so it
    // lives on the per-account client rather than on the active-client stand-in.
    getAccountData: () =>
      soundEnabled === undefined
        ? undefined
        : { getContent: () => ({ enabled: soundEnabled }) },
    getPushActionsForEvent: vi.fn(() => ({ notify: true, tweaks: {} })),
    getRoom: vi.fn(() => room),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function setup(
  opts: {
    accounts?: string[];
    active?: string;
    /** Stored "play a sound" preference; omitted means "not set" (defaults to on). */
    soundEnabled?: boolean;
    /** Pre-built per-account clients, for cases where two accounts must differ. */
    clients?: Map<string, ReturnType<typeof fakeClient>>;
  } = {},
) {
  const accounts = opts.accounts ?? ['@me:hs'];
  const active = opts.active ?? accounts[0];
  const clients =
    opts.clients ??
    new Map(accounts.map((id) => [id, fakeClient(id, opts.soundEnabled)]));
  const accountIds = signal<readonly string[]>(accounts);
  const activeUserId = signal<string | null>(active);
  const setActive = vi.fn((id: string) => activeUserId.set(id));
  const storageSetActive = vi.fn(() => of(void 0));
  const timeline = { openRoomId: null as string | null };
  TestBed.configureTestingModule({
    providers: [
      NotificationService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        // Read by NotificationSoundService when no owning account is supplied.
        instance: { getAccountData: () => undefined } as never,
        accountIds: accountIds.asReadonly(),
        activeUserId: activeUserId.asReadonly(),
        clientFor: (id: string) =>
          (clients.get(id) as unknown as MatrixClient) ?? null,
        setActive,
      }),
      MockProvider(Router, { navigate: vi.fn(() => Promise.resolve(true)) }),
      {
        provide: ConversationRuntime,
        useValue: {
          focused: () =>
            timeline.openRoomId
              ? {
                  key: {
                    accountId: activeUserId() ?? '',
                    roomId: timeline.openRoomId,
                  },
                }
              : null,
        },
      },
      MockProvider(SessionStorageService, { setActive: storageSetActive }),
    ],
  });
  return {
    svc: TestBed.inject(NotificationService),
    client: clients.get(active)!,
    clients,
    // The writable account-id signal, so tests can add/remove accounts after
    // connect() and flush the reconcile effect via ApplicationRef.tick().
    accountIds,
    setActive,
    storageSetActive,
    router: TestBed.inject(Router),
    timeline,
  };
}

/**
 * Fake of the Electron preload `trinityDesktop` bridge. `emitClick` invokes the
 * handler the service registered via `onNotificationClick`, simulating a click
 * forwarded by the main process.
 */
function desktopBridge() {
  let clickHandler: ((roomId: string, userId?: string) => void) | undefined;
  const unsubscribe = vi.fn();
  const bridge = {
    isElectron: true,
    platform: 'darwin',
    showNotification: vi.fn(),
    onNotificationClick: vi.fn(
      (cb: (roomId: string, userId?: string) => void) => {
        clickHandler = cb;
        return unsubscribe;
      },
    ),
  };
  return {
    bridge,
    unsubscribe,
    emitClick: (roomId: string, userId?: string): void =>
      clickHandler?.(roomId, userId),
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
      tag: '@me:hs !r:hs',
    });
  });

  it('is audible by default — sound is on unless the account says otherwise', () => {
    const { svc, client } = setup();
    svc.connect();

    timelineHandler(client)(event(), room, false, false, live);

    expect(MockNotification.instances[0].options).toMatchObject({
      silent: false,
    });
  });

  it('marks the notification silent once the preference is off', () => {
    const { svc, client } = setup({ soundEnabled: false });
    svc.connect();

    timelineHandler(client)(event(), room, false, false, live);

    expect(MockNotification.instances[0].options).toMatchObject({
      silent: true,
    });
  });

  it('uses the BACKGROUND account’s sound preference, not the active one', () => {
    // Trinity notifies for accounts that are not in the foreground. Reading the active
    // account's preference applied one account's choice to another's messages — chiming on
    // an account the user silenced. Two accounts with opposite settings is the only shape
    // that can catch it.
    const accounts = ['@me:hs', '@other:hs'];
    const clients = new Map([
      ['@me:hs', fakeClient('@me:hs', true)], // active: sound ON
      ['@other:hs', fakeClient('@other:hs', false)], // background: silenced
    ]);
    const { svc } = setup({ accounts, active: '@me:hs', clients });
    svc.connect();

    timelineHandler(clients.get('@other:hs')!)(
      event(),
      room,
      false,
      false,
      live,
    );

    expect(MockNotification.instances[0].options).toMatchObject({
      silent: true,
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
    ngMocks.stubMember(timeline, 'openRoomId', '!r:hs'); // the user is viewing this very room
    svc.connect();

    timelineHandler(client)(event(), room, false, false, live);

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('notifies for the open room when the window is unfocused (not actually looking)', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // window unfocused…
    const { svc, client, timeline } = setup();
    ngMocks.stubMember(timeline, 'openRoomId', '!r:hs'); // …even though this very room is "open"
    svc.connect();

    timelineHandler(client)(event(), room, false, false, live);

    expect(MockNotification.instances).toHaveLength(1);
  });

  it('notifies for a message to a different (not open) room even while focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { svc, client, timeline } = setup();
    ngMocks.stubMember(timeline, 'openRoomId', '!other:hs'); // user is looking at a different room
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
    expect(router.navigate).toHaveBeenCalledWith([
      '/rooms',
      encodeRoomSegment('!r:hs'),
    ]);
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

  describe('multiple accounts', () => {
    it('notifies for a live message on a background (non-active) account', () => {
      // Focused on the same room id on the ACTIVE account — a background account's
      // message to that room id must still notify (the user isn't looking at it there).
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const { svc, clients, timeline } = setup({
        accounts: ['@me:hs', '@bg:hs'],
        active: '@me:hs',
      });
      ngMocks.stubMember(timeline, 'openRoomId', '!r:hs');
      svc.connect();

      timelineHandler(clients.get('@bg:hs')!)(
        event(),
        room,
        false,
        false,
        live,
      );

      expect(MockNotification.instances).toHaveLength(1);
    });

    it('scores push rules against the account the event is on', () => {
      const { svc, clients } = setup({
        accounts: ['@me:hs', '@bg:hs'],
        active: '@me:hs',
      });
      const bg = clients.get('@bg:hs')!;
      bg.getPushActionsForEvent.mockReturnValue({ notify: false, tweaks: {} });
      svc.connect();

      timelineHandler(bg)(event(), room, false, false, live);

      expect(MockNotification.instances).toHaveLength(0);
      expect(bg.getPushActionsForEvent).toHaveBeenCalled();
    });

    it('switches to the owning account when its notification is clicked', () => {
      const { svc, clients, setActive, storageSetActive, router } = setup({
        accounts: ['@me:hs', '@bg:hs'],
        active: '@me:hs',
      });
      vi.spyOn(window, 'focus').mockImplementation(() => undefined);
      svc.connect();
      timelineHandler(clients.get('@bg:hs')!)(
        event(),
        room,
        false,
        false,
        live,
      );

      MockNotification.instances[0].onclick?.();

      expect(setActive).toHaveBeenCalledWith('@bg:hs');
      expect(storageSetActive).toHaveBeenCalledWith('@bg:hs');
      expect(router.navigate).toHaveBeenCalledWith([
        '/rooms',
        encodeRoomSegment('!r:hs'),
      ]);
    });

    it('attaches to and notifies for an account that goes live after connect()', () => {
      // The other multi-account tests pre-populate both accounts before connect();
      // here @bg warm-starts and only appears in accountIds() afterwards, so the
      // effect-driven attach is what must bind its listeners.
      const { svc, clients, accountIds } = setup({
        accounts: ['@me:hs'],
        active: '@me:hs',
      });
      svc.connect();

      const bg = fakeClient('@bg:hs');
      clients.set('@bg:hs', bg);
      accountIds.set(['@me:hs', '@bg:hs']);
      TestBed.inject(ApplicationRef).tick(); // flush the reconcile effect

      expect(bg.on).toHaveBeenCalledWith(
        RoomEvent.Timeline,
        expect.any(Function),
      );
      expect(bg.on).toHaveBeenCalledWith(
        MatrixEventEvent.Decrypted,
        expect.any(Function),
      );

      timelineHandler(bg)(event(), room, false, false, live);

      expect(MockNotification.instances).toHaveLength(1);
    });

    it('detaches listeners and clears the dedupe when an account signs out (reconcile)', () => {
      const { svc, clients, accountIds } = setup({
        accounts: ['@me:hs', '@bg:hs'],
        active: '@me:hs',
      });
      svc.connect();
      const bg = clients.get('@bg:hs')!;

      // @bg notifies event $x once — its dedupe key is now recorded.
      timelineHandler(bg)(event({ id: '$x' }), room, false, false, live);
      expect(MockNotification.instances).toHaveLength(1);

      // @bg signs out: it drops out of accountIds() and the reconcile effect runs.
      accountIds.set(['@me:hs']);
      TestBed.inject(ApplicationRef).tick();

      expect(bg.off).toHaveBeenCalledWith(
        RoomEvent.Timeline,
        expect.any(Function),
      );
      expect(bg.off).toHaveBeenCalledWith(
        MatrixEventEvent.Decrypted,
        expect.any(Function),
      );

      // @bg is re-added and the SAME live event fires again. A stale dedupe key
      // would silently suppress it; forgetAccount() dropped it, so it notifies anew.
      accountIds.set(['@me:hs', '@bg:hs']);
      TestBed.inject(ApplicationRef).tick();
      timelineHandler(bg)(event({ id: '$x' }), room, false, false, live);

      expect(MockNotification.instances).toHaveLength(2);
    });

    it('re-binds when an account is handed a NEW client object', () => {
      // Re-adding / re-authenticating an already signed-in account stops the old client
      // and creates a new one under the same user id. Keying the notifier by user id
      // alone strands it on the stopped client, and that account silently stops
      // producing notifications.
      const { svc, clients, accountIds } = setup({ accounts: ['@me:hs'] });
      svc.connect();
      const old = clients.get('@me:hs')!;

      const fresh = fakeClient('@me:hs');
      clients.set('@me:hs', fresh);
      accountIds.set(['@me:hs']); // same id, new client
      TestBed.inject(ApplicationRef).tick();

      expect(old.off).toHaveBeenCalledWith(
        RoomEvent.Timeline,
        expect.any(Function),
      );
      expect(fresh.on).toHaveBeenCalledTimes(2); // Timeline + Decrypted

      timelineHandler(fresh)(event(), room, false, false, live);

      expect(MockNotification.instances).toHaveLength(1);
    });

    it('disconnects itself — enabled included — when the last account signs out', () => {
      const { svc, clients, accountIds } = setup({ accounts: ['@me:hs'] });
      svc.connect();
      const me = clients.get('@me:hs')!;

      accountIds.set([]); // logout: the client is gone
      TestBed.inject(ApplicationRef).tick();

      expect(me.off).toHaveBeenCalledWith(
        RoomEvent.Timeline,
        expect.any(Function),
      );

      // The next account to warm up must NOT be bound behind the user's back: the
      // shell calling connect() is what turns OS notifications back on.
      const next = fakeClient('@next:hs');
      clients.set('@next:hs', next);
      accountIds.set(['@next:hs']);
      TestBed.inject(ApplicationRef).tick();

      expect(next.on).not.toHaveBeenCalled();
    });

    it('skips a warm-starting account with no client yet, attaching once it appears', () => {
      // @bg is signed in (present in accountIds) but its client is still warm-starting,
      // so clientFor('@bg:hs') returns null when connect() first reconciles.
      const { svc, clients, accountIds } = setup({
        accounts: ['@me:hs'],
        active: '@me:hs',
      });
      accountIds.set(['@me:hs', '@bg:hs']);

      // The null client must be skipped, not passed to buildNotifier — no throw.
      expect(() => svc.connect()).not.toThrow();

      // Warm start completes: @bg's client goes live and a later reconcile re-runs.
      const bg = fakeClient('@bg:hs');
      clients.set('@bg:hs', bg);
      accountIds.set(['@me:hs', '@bg:hs']); // new array ref → effect re-runs
      TestBed.inject(ApplicationRef).tick();

      // Attached exactly once: attach() binds Timeline + Decrypted, so two on() calls.
      expect(bg.on).toHaveBeenCalledTimes(2);
      expect(bg.on).toHaveBeenCalledWith(
        RoomEvent.Timeline,
        expect.any(Function),
      );
      expect(bg.on).toHaveBeenCalledWith(
        MatrixEventEvent.Decrypted,
        expect.any(Function),
      );
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
        tag: '@me:hs !r:hs',
        data: { roomId: '!r:hs', userId: '@me:hs' },
        // Sound is on unless the account says otherwise, so the default is audible.
        silent: false,
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
        tag: '@me:hs !r:hs',
        roomId: '!r:hs',
        userId: '@me:hs',
        // The desktop shell never sees NotificationOptions, so it is told separately.
        silent: false,
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
      expect(router.navigate).toHaveBeenCalledWith([
        '/rooms',
        encodeRoomSegment('!r:hs'),
      ]);
    });

    it('switches accounts when a forwarded click carries a userId', () => {
      const { svc, setActive, storageSetActive } = setup({
        accounts: ['@me:hs', '@bg:hs'],
        active: '@me:hs',
      });
      vi.spyOn(window, 'focus').mockImplementation(() => undefined);
      svc.connect();

      harness.emitClick('!r:hs', '@bg:hs');

      expect(setActive).toHaveBeenCalledWith('@bg:hs');
      expect(storageSetActive).toHaveBeenCalledWith('@bg:hs');
    });

    it('unsubscribes from main-process clicks on disconnect', () => {
      const { svc } = setup();
      svc.connect();

      svc.disconnect();

      expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
