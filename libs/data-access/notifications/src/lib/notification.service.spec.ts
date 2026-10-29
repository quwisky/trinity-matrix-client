import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider, ngMocks } from 'ng-mocks';
import { NEVER, Subject, Subscription, defer, lastValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from './notification.service';
import { PushService } from './push.service';
import { NotificationSoundService } from './notification-sound.service';
import { ReactionNotificationSettingsService } from './reaction-notification-settings.service';
import { RoomNotificationsService } from './room-notifications.service';
import type {
  NotificationDestination,
  NotificationRuntimeEvent,
} from './notification-intent';
import {
  EMPTY_SESSION,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { FakeNotificationEngine } from '../contract/fake-notification-engine';
import type { IncomingNotification } from './notification-engine';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import { NotificationSettingsStore } from './notification-settings.store';
import { NOTIFICATION_VISIBILITY } from './notification-visibility.port';
import {
  NOTIFICATION_TEXT,
  type NotificationTextMode,
} from './notification-text.port';
import { provideHostCapabilities } from '@trinity/platform-native';
import {
  HOST_OPERATIONS,
  HostAuthenticationHandoffService,
  HostNotificationPresentationService,
  type HostCapabilitySupport,
} from '@trinity/runtime/host';
import { desktopBridgeFixture } from '@trinity/testing';
import type { NotificationPresentationHealth } from './notification-health.models';

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

function status(accountId: string, generation = 1): SessionAccountStatus {
  return {
    accountId,
    deviceId: 'DEVICE',
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

function setup(
  opts: {
    accounts?: string[];
    active?: string;
    backgroundDelivery?: 'app' | 'push';
    /** Page visibility reported to the policy; defaults to visible. */
    hidden?: boolean;
    /** Stored "play a sound" preference; omitted means "not set" (defaults to on). */
    soundEnabled?: boolean;
    /** Per-account sound preferences, for cases where two accounts must differ. */
    sound?: Record<string, boolean>;
    hostNotifications?: Pick<
      HostNotificationPresentationService,
      'support' | 'activated' | 'requestPermission' | 'present'
    >;
    /** App lock's effective Notification text, read for each notification. */
    textMode?: () => NotificationTextMode;
    /** The running app's name, as the host reports it. */
    appName?: string;
  } = {},
) {
  const accounts = opts.accounts ?? ['@me:hs'];
  const active = opts.active ?? accounts[0];
  const engine = new FakeNotificationEngine();
  const snapshot = signal<SessionSnapshot>({
    ...EMPTY_SESSION,
    activeAccountId: active || null,
    accounts: accounts.map((id) => status(id)),
  });
  /** The live accounts, as a sign-in, sign-out or re-auth (a new generation) leaves them. */
  const setAccounts = (
    ids: readonly string[],
    generations: Record<string, number> = {},
  ): void => {
    for (const id of ids) engine.live.add(id);
    snapshot.update((current) => ({
      ...current,
      accounts: ids.map((id) => status(id, generations[id])),
    }));
  };
  setAccounts(accounts);
  const timeline = { openRoomId: null as string | null };
  TestBed.configureTestingModule({
    providers: [
      provideHostCapabilities(),
      NotificationService,
      { provide: NOTIFICATION_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: snapshot },
      MockProvider(NotificationSettingsStore, {
        settings: () => ({
          loaded: true,
          defaultRules: [],
          keywords: [],
          roomModes: {},
          sound: true,
          reactionNotifications: false,
        }),
      }),
      {
        provide: NotificationSoundService,
        // The owning account's stored preference, as the settings store holds it.
        useValue: {
          isOn: (id: string) => opts.sound?.[id] ?? opts.soundEnabled ?? true,
        },
      },
      MockProvider(ReactionNotificationSettingsService, { isOn: () => false }),
      MockProvider(RoomNotificationsService, { modeFor: () => 'all' }),
      MockProvider(PushService, {
        backgroundDelivery: signal<'app' | 'push'>(
          opts.backgroundDelivery ?? 'app',
        ).asReadonly(),
      }),
      {
        provide: NOTIFICATION_VISIBILITY,
        useValue: {
          snapshot: () => ({
            foreground: typeof document !== 'undefined' && document.hasFocus(),
            hidden: opts.hidden ?? false,
            conversation: timeline.openRoomId
              ? {
                  accountId: snapshot().activeAccountId ?? '',
                  roomId: timeline.openRoomId,
                }
              : null,
          }),
        },
      },
      ...(opts.textMode
        ? [{ provide: NOTIFICATION_TEXT, useValue: { mode: opts.textMode } }]
        : []),
      ...(opts.appName
        ? [
            MockProvider(HostAuthenticationHandoffService, {
              deviceDisplayName: () => opts.appName as string,
            }),
          ]
        : []),
      ...(opts.hostNotifications
        ? [
            {
              provide: HostNotificationPresentationService,
              useValue: opts.hostNotifications,
            },
          ]
        : []),
    ],
  });
  const service = TestBed.inject(NotificationService);
  const activations: NotificationDestination[] = [];
  const health: string[] = [];
  const healthFacts: NotificationPresentationHealth[] = [];
  const incidents: string[] = [];
  let lifetime: Subscription | null = null;
  const svc = Object.assign(service, {
    connect: (): void => {
      lifetime = service.run().subscribe((event: NotificationRuntimeEvent) => {
        if (event.kind === 'activated') {
          activations.push(event.destination);
        } else if (event.kind === 'health') {
          health.push(event.fact.code);
          healthFacts.push(event.fact);
        } else incidents.push(event.incident.code);
      });
    },
    disconnect: (): void => {
      lifetime?.unsubscribe();
      lifetime = null;
    },
  });
  /** A live message from Alice in General, notified by the push rules. */
  const deliver = (
    overrides: Partial<
      Exclude<IncomingNotification, { kind: 'reaction-annotation' }>
    > = {},
  ): void =>
    engine.deliver({
      kind: 'message',
      accountId: '@me:hs',
      roomId: '!r:hs',
      eventId: '$event',
      senderId: '@alice:hs',
      senderName: 'Alice',
      roomName: 'General',
      body: 'hello there',
      ...overrides,
    });
  return {
    svc,
    engine,
    deliver,
    // Tests add/remove accounts after connect() and flush the reconcile effect via
    // ApplicationRef.tick().
    setAccounts,
    timeline,
    activations,
    health,
    healthFacts,
    incidents,
  };
}

/**
 * Fake of the Electron preload `trinityDesktop` bridge. `emitClick` invokes the
 * handler the service registered via `onNotificationClick`, simulating a click
 * forwarded by the main process.
 */
function desktopBridge() {
  let clickHandler:
    | ((destination: {
        accountId: string;
        roomId: string;
        eventId: string;
      }) => void)
    | undefined;
  const unsubscribe = vi.fn();
  const present = vi.fn(async () => ({ kind: 'completed' as const }));
  const subscribeClicks = vi.fn(
    (
      cb: (destination: {
        accountId: string;
        roomId: string;
        eventId: string;
      }) => void,
    ) => {
      clickHandler = cb;
      return unsubscribe;
    },
  );
  const bridge = desktopBridgeFixture({
    platform: 'darwin',
    negotiate: vi.fn(async () => ({
      kind: 'accepted',
      protocolVersion: 1,
      operations: Object.fromEntries(
        HOST_OPERATIONS.map((operation) => [operation, { kind: 'supported' }]),
      ),
    })),
    capabilities: {
      notificationPresentation: { present, subscribeClicks },
    },
  });
  return {
    bridge,
    unsubscribe,
    emitClick: (roomId: string, accountId = '@me:hs'): void =>
      clickHandler?.({ accountId, roomId, eventId: '$event' }),
  };
}

async function settleDesktopNegotiation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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

  it('subscribes to the account’s notifications after permission is granted', async () => {
    MockNotification.permission = 'default';
    const { svc, engine } = setup();

    svc.connect();

    expect(MockNotification.requestPermission).toHaveBeenCalled();
    await vi.waitFor(() => expect(engine.feeds('@me:hs')).toBe(1));
  });

  it('notifies on a live message from someone else while unfocused', () => {
    const { svc, deliver } = setup();
    svc.connect();

    deliver();

    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0].title).toBe('Alice · General');
    expect(MockNotification.instances[0].options).toMatchObject({
      body: 'hello there',
      tag: '@me:hs !r:hs',
    });
  });

  describe('notification text (App lock)', () => {
    it('shows only “New message” while App lock hides notification text', () => {
      const { svc, deliver } = setup({ textMode: () => 'always-hide' });
      svc.connect();

      deliver();

      expect(MockNotification.instances).toHaveLength(1);
      expect(MockNotification.instances[0].title).toBe('Trinity');
      expect(MockNotification.instances[0].options).toMatchObject({
        body: 'New message',
        tag: '@me:hs !r:hs',
      });
      const shown = JSON.stringify(MockNotification.instances[0]);
      expect(shown.includes('hello there')).toBe(false);
      expect(shown.includes('Alice')).toBe(false);
      expect(shown.includes('General')).toBe(false);
    });

    it('names the running app in a hidden notification', () => {
      const { svc, deliver } = setup({
        textMode: () => 'always-hide',
        appName: 'Trinity Next',
      });
      svc.connect();

      deliver();

      expect(MockNotification.instances[0].title).toBe('Trinity Next');
    });

    it('reads the choice for each notification', () => {
      let mode: NotificationTextMode = 'always-hide';
      const { svc, deliver } = setup({ textMode: () => mode });
      svc.connect();

      deliver();
      mode = 'show';
      deliver({ eventId: '$second' });

      expect(MockNotification.instances.map((n) => n.title)).toEqual([
        'Trinity',
        'Alice · General',
      ]);
    });
  });

  describe('once Android push owns the background', () => {
    it('leaves a hidden-page message to the native push renderer', () => {
      const { svc, deliver } = setup({
        backgroundDelivery: 'push',
        hidden: true,
      });
      svc.connect();

      deliver();

      expect(MockNotification.instances).toHaveLength(0);
    });

    it('still notifies while the page is visible but unfocused', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      const { svc, deliver } = setup({
        backgroundDelivery: 'push',
        hidden: false,
      });
      svc.connect();

      deliver();

      expect(MockNotification.instances).toHaveLength(1);
    });

    it('keeps notifying while hidden when push is not registered', () => {
      const { svc, deliver } = setup({
        backgroundDelivery: 'app',
        hidden: true,
      });
      svc.connect();

      deliver();

      expect(MockNotification.instances).toHaveLength(1);
    });
  });

  it('is audible by default — sound is on unless the account says otherwise', () => {
    const { svc, deliver } = setup();
    svc.connect();

    deliver();

    expect(MockNotification.instances[0].options).toMatchObject({
      silent: false,
    });
  });

  it('marks the notification silent once the preference is off', () => {
    const { svc, deliver } = setup({ soundEnabled: false });
    svc.connect();

    deliver();

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
    const { svc, deliver } = setup({
      accounts,
      active: '@me:hs',
      sound: { '@me:hs': true, '@other:hs': false }, // active ON, background silenced
    });
    svc.connect();

    deliver({ accountId: '@other:hs' });

    expect(MockNotification.instances[0].options).toMatchObject({
      silent: true,
    });
  });

  it('ignores the user’s own messages', () => {
    const { svc, deliver } = setup();
    svc.connect();

    deliver({ senderId: '@me:hs' });

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('stays quiet when focused on the room the message is in', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { svc, deliver, timeline } = setup();
    ngMocks.stubMember(timeline, 'openRoomId', '!r:hs'); // the user is viewing this very room
    svc.connect();

    deliver();

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('notifies for the open room when the window is unfocused (not actually looking)', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // window unfocused…
    const { svc, deliver, timeline } = setup();
    ngMocks.stubMember(timeline, 'openRoomId', '!r:hs'); // …even though this very room is "open"
    svc.connect();

    deliver();

    expect(MockNotification.instances).toHaveLength(1);
  });

  it('notifies for a message to a different (not open) room even while focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { svc, deliver, timeline } = setup();
    ngMocks.stubMember(timeline, 'openRoomId', '!other:hs'); // user is looking at a different room
    svc.connect();

    deliver();

    expect(MockNotification.instances).toHaveLength(1);
  });

  it('does not subscribe to notifications without granted permission', () => {
    MockNotification.permission = 'denied';
    const { svc, engine, health } = setup();
    svc.connect();

    expect(engine.feeds('@me:hs')).toBe(0);
    expect(MockNotification.instances).toHaveLength(0);
    expect(health.at(-1)).toBe('notification-presentation-disabled');
  });

  it('does not track a synchronous warning consumer as an account dependency', () => {
    MockNotification.permission = 'denied';
    const { svc } = setup();
    const runtimeHealth = signal<readonly string[]>([]);
    const lifetime = svc.run().subscribe((event) => {
      if (event.kind !== 'health') return;
      const current = runtimeHealth();
      runtimeHealth.set([...current, event.fact.code]);
    });

    const appRef = TestBed.inject(ApplicationRef);
    expect(() => appRef.tick()).not.toThrow();
    const afterInitialReconciliation = runtimeHealth();
    expect(afterInitialReconciliation).toContain(
      'notification-presentation-disabled',
    );

    runtimeHealth.set([...afterInitialReconciliation, 'unrelated-health']);
    expect(() => appRef.tick()).not.toThrow();
    expect(runtimeHealth()).toEqual([
      ...afterInitialReconciliation,
      'unrelated-health',
    ]);
    lifetime.unsubscribe();
  });

  it('delivers through the same presenter contract on native mobile', () => {
    cap.native = true;
    const present = vi.fn(() => of({ kind: 'completed' as const }));
    const { svc, deliver } = setup({
      hostNotifications: {
        support: () => of({ kind: 'supported' as const }),
        activated: NEVER,
        requestPermission: () => of({ kind: 'completed' as const }),
        present,
      },
    });

    svc.connect();
    deliver();

    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: {
          accountId: '@me:hs',
          roomId: '!r:hs',
          eventId: '$event',
        },
      }),
    );
  });

  it('emits the exact typed destination when a notification is clicked', () => {
    const { svc, deliver, activations } = setup();
    svc.connect();
    deliver();

    MockNotification.instances[0].onclick?.();

    expect(activations).toEqual([
      {
        accountId: '@me:hs',
        roomId: '!r:hs',
        eventId: '$event',
      },
    ]);
  });

  it('swallows errors so a notification failure cannot disrupt the feed', () => {
    const { svc, deliver } = setup();
    vi.spyOn(
      TestBed.inject(NotificationSoundService),
      'isOn',
    ).mockImplementation(() => {
      throw new Error('boom');
    });
    svc.connect();

    expect(() => deliver()).not.toThrow();
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('disconnect closes every feed', () => {
    const { svc, engine } = setup({ accounts: ['@me:hs', '@bg:hs'] });
    svc.connect();
    expect(engine.feeds('@bg:hs')).toBe(1);

    svc.disconnect();

    expect(engine.feeds('@me:hs')).toBe(0);
    expect(engine.feeds('@bg:hs')).toBe(0);
  });

  it('cancels pending support negotiation so a late result cannot reconnect', () => {
    const support = new Subject<HostCapabilitySupport>();
    const requestPermission = vi.fn(() => of({ kind: 'completed' } as const));
    const { svc, engine } = setup({
      hostNotifications: {
        support: () => support,
        activated: NEVER,
        requestPermission,
        present: () => of({ kind: 'completed' } as const),
      },
    });

    svc.connect();
    expect(engine.feeds('@me:hs')).toBe(0);
    svc.disconnect();
    support.next({ kind: 'supported' });

    expect(support.observed).toBe(false);
    expect(engine.feeds('@me:hs')).toBe(0);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('reports released activation ownership and reattaches it through exact recovery', async () => {
    const firstOwner = new Subject<NotificationDestination>();
    const retainedOwner = new Subject<NotificationDestination>();
    let ownerAttempt = 0;
    const support = vi.fn(() => of({ kind: 'supported' as const }));
    const hostNotifications = {
      support,
      activated: defer(() => {
        ownerAttempt += 1;
        return ownerAttempt === 1 ? firstOwner : retainedOwner;
      }),
      requestPermission: () => of({ kind: 'completed' as const }),
      present: () => of({ kind: 'completed' as const }),
    };
    const { svc, engine, health, healthFacts } = setup({
      hostNotifications,
    });
    const notifications = vi.spyOn(engine, 'notifications');

    svc.connect();
    firstOwner.complete();

    expect(health.at(-1)).toBe('notification-activation-ownership-released');
    expect(engine.feeds('@me:hs')).toBe(0);
    const released = healthFacts.at(-1)!;

    await expect(
      lastValueFrom(
        svc.recoverPresentation(released.context, released.generation),
      ),
    ).resolves.toEqual({ kind: 'success' });
    expect(support).toHaveBeenCalledTimes(2);
    expect(health.at(-1)).toBe('notification-presentation-ready');
    // One feed per attach.
    expect(notifications).toHaveBeenCalledTimes(2);
    expect(engine.feeds('@me:hs')).toBe(1);
  });

  it('reports disabled permission without attaching or ending the session', () => {
    const { svc, engine, health } = setup({
      hostNotifications: {
        support: () => of({ kind: 'supported' as const }),
        activated: NEVER,
        requestPermission: () =>
          of({
            kind: 'rejected' as const,
            diagnostic: { code: 'notification-permission-denied' },
          }),
        present: () => of({ kind: 'completed' as const }),
      },
    });

    svc.connect();

    expect(health.at(-1)).toBe('notification-presentation-disabled');
    expect(engine.feeds('@me:hs')).toBe(0);
  });

  it('reports a presenter rejection as an incident while keeping activation delivery alive', () => {
    const activated = new Subject<NotificationDestination>();
    const { svc, deliver, incidents, activations } = setup({
      hostNotifications: {
        support: () => of({ kind: 'supported' as const }),
        activated,
        requestPermission: () => of({ kind: 'completed' as const }),
        present: () =>
          of({
            kind: 'rejected' as const,
            diagnostic: { code: 'native-failure' },
          }),
      },
    });
    svc.connect();
    deliver();
    activated.next({
      accountId: '@me:hs',
      roomId: '!r:hs',
      eventId: '$event',
    });

    expect(incidents).toEqual(['notification-presentation-failed']);
    expect(activations).toEqual([
      {
        accountId: '@me:hs',
        roomId: '!r:hs',
        eventId: '$event',
      },
    ]);
  });

  describe('multiple accounts', () => {
    it('notifies for a live message on a background (non-active) account', () => {
      // Focused on the same room id on the ACTIVE account — a background account's
      // message to that room id must still notify (the user isn't looking at it there).
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const { svc, deliver, timeline } = setup({
        accounts: ['@me:hs', '@bg:hs'],
        active: '@me:hs',
      });
      ngMocks.stubMember(timeline, 'openRoomId', '!r:hs');
      svc.connect();

      deliver({ accountId: '@bg:hs' });

      expect(MockNotification.instances).toHaveLength(1);
    });

    it('keeps the owning account in the emitted activation', () => {
      const { svc, deliver, activations } = setup({
        accounts: ['@me:hs', '@bg:hs'],
        active: '@me:hs',
      });
      svc.connect();
      deliver({ accountId: '@bg:hs' });

      MockNotification.instances[0].onclick?.();

      expect(activations).toEqual([
        {
          accountId: '@bg:hs',
          roomId: '!r:hs',
          eventId: '$event',
        },
      ]);
    });

    it('attaches to and notifies for an account that goes live after connect()', () => {
      // The other multi-account tests pre-populate both accounts before connect();
      // here @bg warm-starts and only goes live afterwards, so the effect-driven attach is
      // what must subscribe to its feed.
      const { svc, deliver, engine, setAccounts } = setup({
        accounts: ['@me:hs'],
        active: '@me:hs',
      });
      svc.connect();

      setAccounts(['@me:hs', '@bg:hs']);
      TestBed.inject(ApplicationRef).tick(); // flush the reconcile effect

      expect(engine.feeds('@bg:hs')).toBe(1);

      deliver({ accountId: '@bg:hs' });

      expect(MockNotification.instances).toHaveLength(1);
    });

    it('closes the feed and clears the dedupe when an account signs out (reconcile)', () => {
      const { svc, deliver, engine, setAccounts } = setup({
        accounts: ['@me:hs', '@bg:hs'],
        active: '@me:hs',
      });
      svc.connect();

      // @bg notifies event $x once — its dedupe key is now recorded.
      deliver({ accountId: '@bg:hs', eventId: '$x' });
      expect(MockNotification.instances).toHaveLength(1);

      // @bg signs out: it leaves the session and the reconcile effect runs.
      setAccounts(['@me:hs']);
      TestBed.inject(ApplicationRef).tick();

      expect(engine.feeds('@bg:hs')).toBe(0);

      // @bg is re-added and the SAME live event fires again. A stale dedupe key
      // would silently suppress it; forgetAccount() dropped it, so it notifies anew.
      setAccounts(['@me:hs', '@bg:hs']);
      TestBed.inject(ApplicationRef).tick();
      deliver({ accountId: '@bg:hs', eventId: '$x' });

      expect(MockNotification.instances).toHaveLength(2);
    });

    it('re-subscribes when an account’s session generation changes', () => {
      // Re-adding / re-authenticating an already signed-in account stops the old client
      // and creates a new one under the same user id. Keying the feed by user id
      // alone strands it on the stopped client, and that account silently stops
      // producing notifications.
      const { svc, deliver, engine, setAccounts } = setup({
        accounts: ['@me:hs'],
      });
      const notifications = vi.spyOn(engine, 'notifications');
      svc.connect();

      setAccounts(['@me:hs'], { '@me:hs': 2 }); // same id, new session
      TestBed.inject(ApplicationRef).tick();

      expect(notifications).toHaveBeenCalledTimes(2);
      expect(engine.feeds('@me:hs')).toBe(1);

      deliver({ accountId: '@me:hs' });

      expect(MockNotification.instances).toHaveLength(1);
    });

    it('keeps the feed while only the sync state changes', () => {
      const { svc, engine } = setup({ accounts: ['@me:hs'] });
      const notifications = vi.spyOn(engine, 'notifications');
      svc.connect();

      const session = TestBed.inject(SESSION_SNAPSHOT) as unknown as {
        update(fn: (s: SessionSnapshot) => SessionSnapshot): void;
      };
      session.update((current) => ({
        ...current,
        accounts: [{ ...status('@me:hs'), syncState: 'reconnecting' }],
      }));
      TestBed.inject(ApplicationRef).tick();

      expect(notifications).toHaveBeenCalledTimes(1);
    });

    it('stays dormant across sign-out and attaches a later login in the same app session', () => {
      const { svc, engine, setAccounts } = setup({ accounts: ['@me:hs'] });
      svc.connect();

      setAccounts([]); // logout: the client is gone
      TestBed.inject(ApplicationRef).tick();

      expect(engine.feeds('@me:hs')).toBe(0);

      setAccounts(['@next:hs']);
      TestBed.inject(ApplicationRef).tick();

      expect(engine.feeds('@next:hs')).toBe(1);
    });

    it('does not negotiate Web permission until the session has an account', () => {
      MockNotification.permission = 'default';
      const { svc, setAccounts } = setup({ accounts: [], active: '' });

      svc.connect();
      expect(MockNotification.requestPermission).not.toHaveBeenCalled();

      setAccounts(['@next:hs']);
      TestBed.inject(ApplicationRef).tick();

      expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
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
      const { svc, deliver } = setup();
      svc.connect();

      deliver();
      await Promise.resolve(); // let navigator.serviceWorker.ready resolve
      await Promise.resolve(); // let the adapter's finite presentation command emit

      expect(showNotification).toHaveBeenCalledWith('Alice · General', {
        body: 'hello there',
        tag: '@me:hs !r:hs',
        data: {
          accountId: '@me:hs',
          roomId: '!r:hs',
          eventId: '$event',
        },
        // Sound is on unless the account says otherwise, so the default is audible.
        silent: false,
      });
      // Did NOT fall back to the renderer Notification constructor.
      expect(MockNotification.instances).toHaveLength(0);
    });

    it('falls back to the constructor when no SW controls the page', () => {
      const { svc, deliver } = setup();
      svc.connect();

      deliver();

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
      const { svc, deliver } = setup();
      svc.connect();

      expect(() => deliver()).not.toThrow();
    });
  });

  describe('desktop (Electron main-process bridge)', () => {
    let harness: ReturnType<typeof desktopBridge>;

    beforeEach(() => {
      harness = desktopBridge();
      vi.stubGlobal('trinityDesktop', harness.bridge);
    });

    it('routes notifications through the main process, not the Web API', async () => {
      // Electron auto-grants Web permission and never prompts; the bridge path
      // must work regardless of the renderer Web permission state.
      MockNotification.permission = 'default';
      const { svc, deliver } = setup();
      svc.connect();
      await settleDesktopNegotiation();

      expect(MockNotification.requestPermission).not.toHaveBeenCalled();
      expect(
        harness.bridge.capabilities.notificationPresentation.subscribeClicks,
      ).toHaveBeenCalledTimes(1);

      deliver();

      expect(
        harness.bridge.capabilities.notificationPresentation.present,
      ).toHaveBeenCalledTimes(1);
      expect(
        harness.bridge.capabilities.notificationPresentation.present,
      ).toHaveBeenCalledWith({
        title: 'Alice · General',
        body: 'hello there',
        tag: '@me:hs !r:hs',
        destination: {
          accountId: '@me:hs',
          roomId: '!r:hs',
          eventId: '$event',
        },
        // The desktop shell never sees NotificationOptions, so it is told separately.
        silent: false,
      });
      // Did NOT fall back to the renderer Web Notification.
      expect(MockNotification.instances).toHaveLength(0);
    });

    it('notifies even when the Web Notification permission is not granted', async () => {
      MockNotification.permission = 'denied';
      const { svc, deliver } = setup();
      svc.connect();
      await settleDesktopNegotiation();

      deliver();

      expect(
        harness.bridge.capabilities.notificationPresentation.present,
      ).toHaveBeenCalledTimes(1);
      expect(MockNotification.instances).toHaveLength(0);
    });

    it('still honors gating (own messages / focus / push rules)', async () => {
      const { svc, deliver } = setup();
      svc.connect();
      await settleDesktopNegotiation();

      deliver({ senderId: '@me:hs' });

      expect(
        harness.bridge.capabilities.notificationPresentation.present,
      ).not.toHaveBeenCalled();
    });

    it('emits the destination when a forwarded click arrives', async () => {
      const { svc, activations } = setup();
      svc.connect();
      await settleDesktopNegotiation();

      harness.emitClick('!r:hs');

      expect(activations).toEqual([
        {
          accountId: '@me:hs',
          roomId: '!r:hs',
          eventId: '$event',
        },
      ]);
    });

    it('preserves the account when a forwarded click carries it', async () => {
      const { svc, activations } = setup({
        accounts: ['@me:hs', '@bg:hs'],
        active: '@me:hs',
      });
      svc.connect();
      await settleDesktopNegotiation();

      harness.emitClick('!r:hs', '@bg:hs');

      expect(activations[0]?.accountId).toBe('@bg:hs');
    });

    it('unsubscribes from main-process clicks on disconnect', async () => {
      const { svc } = setup();
      svc.connect();
      await settleDesktopNegotiation();

      svc.disconnect();

      expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
