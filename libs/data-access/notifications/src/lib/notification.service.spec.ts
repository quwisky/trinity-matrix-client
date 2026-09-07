import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  MatrixEventEvent,
  RoomEvent,
  SyncState,
  type MatrixClient,
} from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { NEVER, Subject, Subscription, defer, lastValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from './notification.service';
import { NotificationPresenterService } from './notification-presenter.service';
import type {
  NotificationDestination,
  NotificationRuntimeEvent,
} from './notification-intent';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { NOTIFICATION_VISIBILITY } from './notification-visibility.port';
import { provideHostCapabilities } from '@trinity/platform-native';
import {
  SessionStorageService,
  NativePushRegistrationService,
} from '@trinity/platform-native';
import { PushGatewayService } from './push-gateway.service';
import {
  HOST_OPERATIONS,
  HostNotificationPresentationService,
  type HostCapabilitySupport,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { desktopBridgeFixture } from '@trinity/testing';
import type { NotificationPresentationHealth } from './notification-health.models';

const cap = vi.hoisted(() => ({ native: false }));
vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({})),
  Capacitor: {
    isNativePlatform: () => cap.native,
    getPlatform: () => (cap.native ? 'ios' : 'web'),
    isPluginAvailable: () => cap.native,
  },
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
    getSyncState: vi.fn((): SyncState | null => SyncState.Prepared),
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
    androidGateway?: boolean;
    /** Pre-built per-account clients, for cases where two accounts must differ. */
    clients?: Map<string, ReturnType<typeof fakeClient>>;
    hostNotifications?: Pick<
      HostNotificationPresentationService,
      'support' | 'activated' | 'requestPermission' | 'present'
    >;
  } = {},
) {
  const accounts = opts.accounts ?? ['@me:hs'];
  const active = opts.active ?? accounts[0];
  const clients =
    opts.clients ??
    new Map(accounts.map((id) => [id, fakeClient(id, opts.soundEnabled)]));
  const accountIds = signal<readonly string[]>(accounts);
  const activeUserId = signal<string | null>(active);
  const timeline = { openRoomId: null as string | null };
  TestBed.configureTestingModule({
    providers: [
      provideHostCapabilities(),
      NotificationService,
      MockProvider(SessionStorageService, {
        getPushAccountRoutes: () =>
          of(
            accounts.map((accountId) => ({
              accountId,
              route: `route-${accountId.slice(1, 3)}`,
            })),
          ),
      }),
      MockProvider(NativePushRegistrationService, {
        platform: opts.androidGateway ? 'android' : cap.native ? 'ios' : null,
        supported: () => false,
      }),
      MockProvider(PushGatewayService, {
        configured: signal(opts.androidGateway ?? false),
      }),
      MockProvider(MatrixClientService, {
        // A session can start signed out. Notification Runtime must remain dormant
        // instead of completing, then attach when the first Account appears.
        isInitialized: active !== '',
        // Read by NotificationSoundService when no owning account is supplied.
        instance: { getAccountData: () => undefined } as never,
        accountIds: accountIds.asReadonly(),
        activeUserId: activeUserId.asReadonly(),
        clientFor: (id: string) =>
          (clients.get(id) as unknown as MatrixClient) ?? null,
      }),
      {
        provide: NOTIFICATION_VISIBILITY,
        useValue: {
          snapshot: () => ({
            foreground: typeof document !== 'undefined' && document.hasFocus(),
            conversation: timeline.openRoomId
              ? {
                  accountId: activeUserId() ?? '',
                  roomId: timeline.openRoomId,
                }
              : null,
          }),
        },
      },
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
  return {
    svc,
    client: clients.get(active)!,
    clients,
    // The writable account-id signal, so tests can add/remove accounts after
    // connect() and flush the reconcile effect via ApplicationRef.tick().
    accountIds,
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

function gatewayEvent(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    schema: '1',
    kind: 'event',
    trinity_account_id: 'route-me',
    room_id: '!r:hs',
    event_id: '$push',
    unread: '1',
    missed_calls: '0',
    sound: 'true',
    ...overrides,
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
    getId: () => opts.id ?? '$event',
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

/** Grab the ClientEvent.Sync handler registered via client.on. */
function syncHandler(client: { on: { mock: { calls: unknown[][] } } }) {
  const call = client.on.mock.calls.find((c) => c[0] === ClientEvent.Sync);
  return call?.[1] as (state: SyncState) => void;
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

  it('attaches a timeline listener after permission is granted', async () => {
    MockNotification.permission = 'default';
    const { svc, client } = setup();

    svc.connect();

    expect(MockNotification.requestPermission).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(client.on).toHaveBeenCalledWith(
        RoomEvent.Timeline,
        expect.any(Function),
      ),
    );
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

  it.each(['push', 'sync'] as const)(
    'keeps %s-first Android delivery generic, silent and deduplicated',
    async (first) => {
      const { svc, client } = setup({
        androidGateway: true,
        soundEnabled: false,
      });
      svc.connect();
      const push = () => lastValueFrom(svc.receivePush(gatewayEvent()));
      const sync = () =>
        timelineHandler(client)(
          event({ id: '$push' }),
          room,
          false,
          false,
          live,
        );
      if (first === 'push') {
        await push();
        sync();
      } else {
        sync();
        await push();
      }
      await push();
      expect(MockNotification.instances).toHaveLength(1);
      expect(MockNotification.instances[0].title).toBe('Trinity');
      expect(MockNotification.instances[0].options).toMatchObject({
        body: 'New message',
        silent: true,
        tag: '@me:hs !r:hs',
      });
    },
  );

  it('keeps the same Room and event separate for two Accounts', async () => {
    const { svc, clients } = setup({
      accounts: ['@me:hs', '@other:hs'],
      clients: new Map([
        ['@me:hs', fakeClient('@me:hs', true)],
        ['@other:hs', fakeClient('@other:hs', false)],
      ]),
      androidGateway: true,
    });
    svc.connect();
    await lastValueFrom(svc.receivePush(gatewayEvent()));
    await lastValueFrom(
      svc.receivePush(gatewayEvent({ trinity_account_id: 'route-ot' })),
    );
    for (const client of clients.values())
      timelineHandler(client)(event({ id: '$push' }), room, false, false, live);
    expect(MockNotification.instances).toHaveLength(2);
    expect(MockNotification.instances[0].options).toMatchObject({
      silent: false,
    });
    expect(MockNotification.instances[1].options).toMatchObject({
      silent: true,
    });
    expect(
      MockNotification.instances.map(
        (notification) => notification.options?.tag,
      ),
    ).toEqual(['@me:hs !r:hs', '@other:hs !r:hs']);
  });

  it('suppresses a gateway event for the focused Conversation', async () => {
    const { svc, timeline } = setup();
    timeline.openRoomId = '!r:hs';
    vi.mocked(document.hasFocus).mockReturnValue(true);
    svc.connect();
    await lastValueFrom(svc.receivePush(gatewayEvent()));
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('cancels route loading when its session stops and cannot deliver into the next session', async () => {
    const routes = new Subject<
      readonly { accountId: string; route: string }[]
    >();
    const { svc } = setup();
    vi.spyOn(
      TestBed.inject(SessionStorageService),
      'getPushAccountRoutes',
    ).mockReturnValue(routes);
    svc.connect();
    const pending = svc.receivePush(gatewayEvent()).subscribe();
    expect(routes.observed).toBe(true);
    svc.disconnect();
    expect(pending.closed).toBe(true);
    expect(routes.observed).toBe(false);
    svc.connect();
    routes.next([{ accountId: '@me:hs', route: 'route-me' }]);
    expect(MockNotification.instances).toHaveLength(0);
    vi.mocked(
      TestBed.inject(SessionStorageService).getPushAccountRoutes,
    ).mockReturnValue(of([{ accountId: '@me:hs', route: 'route-me' }]));
    await lastValueFrom(svc.receivePush(gatewayEvent()));
    expect(MockNotification.instances).toHaveLength(1);
  });

  it.each(['caller', 'session'] as const)(
    'cancels pending push presentation when the %s ends',
    (owner) => {
      const { svc } = setup();
      svc.connect();
      const presentation = new Subject<HostOperationOutcome>();
      vi.spyOn(
        TestBed.inject(NotificationPresenterService),
        'present',
      ).mockReturnValue(presentation);
      const completed = vi.fn();
      const pending = svc
        .receivePush(gatewayEvent())
        .subscribe({ complete: completed });
      expect(presentation.observed).toBe(true);
      expect(completed).not.toHaveBeenCalled();
      if (owner === 'caller') pending.unsubscribe();
      else svc.disconnect();
      expect(pending.closed).toBe(true);
      expect(presentation.observed).toBe(false);
    },
  );

  it('waits for a push presentation outcome and reports its failure', async () => {
    const { svc, incidents } = setup();
    svc.connect();
    const presentation = new Subject<HostOperationOutcome>();
    vi.spyOn(
      TestBed.inject(NotificationPresenterService),
      'present',
    ).mockReturnValue(presentation);
    const completed = vi.fn();
    svc.receivePush(gatewayEvent()).subscribe({ complete: completed });
    expect(completed).not.toHaveBeenCalled();
    presentation.error(new Error('host presentation failed'));
    expect(completed).toHaveBeenCalledOnce();
    expect(incidents).toContain('notification-presentation-failed');
  });

  it('ignores malformed, count-only, unknown, and removed-account gateway events', async () => {
    const { svc, accountIds, client } = setup();
    svc.connect();
    await vi.waitFor(() =>
      expect(client.on).toHaveBeenCalledWith(
        RoomEvent.Timeline,
        expect.any(Function),
      ),
    );
    const base = {
      schema: '1',
      kind: 'event',
      trinity_account_id: 'route-me',
      room_id: '!r:hs',
      event_id: '$push',
      unread: '1',
      missed_calls: '0',
      sound: 'true',
    };
    svc.receivePush({ ...base, schema: '2' }).subscribe();
    svc.receivePush({ ...base, kind: 'counts' }).subscribe();
    svc
      .receivePush({ ...base, trinity_account_id: 'missing-route' })
      .subscribe();
    accountIds.set([]);
    svc.receivePush(base).subscribe();
    await Promise.resolve();
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('ignores initial-sync history before notifying on the first ready event', () => {
    const { svc, client } = setup();
    client.getSyncState.mockReturnValue(null);
    svc.connect();

    timelineHandler(client)(
      event({ id: '$history' }),
      room,
      false,
      false,
      live,
    );
    expect(MockNotification.instances).toHaveLength(0);

    client.getSyncState.mockReturnValue(SyncState.Error);
    timelineHandler(client)(
      event({ id: '$history-after-error' }),
      room,
      false,
      false,
      live,
    );
    expect(MockNotification.instances).toHaveLength(0);

    client.getSyncState.mockReturnValue(SyncState.Reconnecting);
    timelineHandler(client)(
      event({ id: '$history-while-reconnecting' }),
      room,
      false,
      false,
      live,
    );
    expect(MockNotification.instances).toHaveLength(0);

    syncHandler(client)(SyncState.Prepared);
    timelineHandler(client)(
      event({ id: '$after-ready' }),
      room,
      false,
      false,
      live,
    );

    expect(MockNotification.instances).toHaveLength(1);
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

  it('does not attach delivery listeners without granted permission', () => {
    MockNotification.permission = 'denied';
    const { svc, client, health } = setup();
    svc.connect();

    expect(client.on).not.toHaveBeenCalled();
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
    const { svc, client } = setup({
      hostNotifications: {
        support: () => of({ kind: 'supported' as const }),
        activated: NEVER,
        requestPermission: () => of({ kind: 'completed' as const }),
        present,
      },
    });

    svc.connect();
    timelineHandler(client)(event(), room, false, false, live);

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
    const { svc, client, activations } = setup();
    svc.connect();
    timelineHandler(client)(event(), room, false, false, live);

    MockNotification.instances[0].onclick?.();

    expect(activations).toEqual([
      {
        accountId: '@me:hs',
        roomId: '!r:hs',
        eventId: '$event',
      },
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

  it('disconnect detaches every listener', () => {
    const { svc, client } = setup();
    svc.connect();

    svc.disconnect();

    expect(client.off).toHaveBeenCalledWith(
      ClientEvent.Sync,
      expect.any(Function),
    );
    expect(client.off).toHaveBeenCalledWith(
      RoomEvent.Timeline,
      expect.any(Function),
    );
    expect(client.off).toHaveBeenCalledWith(
      MatrixEventEvent.Decrypted,
      expect.any(Function),
    );
  });

  it('cancels pending support negotiation so a late result cannot reconnect', () => {
    const support = new Subject<HostCapabilitySupport>();
    const requestPermission = vi.fn(() => of({ kind: 'completed' } as const));
    const { svc, client } = setup({
      hostNotifications: {
        support: () => support,
        activated: NEVER,
        requestPermission,
        present: () => of({ kind: 'completed' } as const),
      },
    });

    svc.connect();
    expect(client.on).not.toHaveBeenCalled();
    svc.disconnect();
    support.next({ kind: 'supported' });

    expect(support.observed).toBe(false);
    expect(client.on).not.toHaveBeenCalled();
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
    const { svc, client, health, healthFacts } = setup({
      hostNotifications,
    });

    svc.connect();
    firstOwner.complete();

    expect(health.at(-1)).toBe('notification-activation-ownership-released');
    expect(client.off).toHaveBeenCalledWith(
      RoomEvent.Timeline,
      expect.any(Function),
    );
    const released = healthFacts.at(-1)!;

    await expect(
      lastValueFrom(
        svc.recoverPresentation(released.context, released.generation),
      ),
    ).resolves.toEqual({ kind: 'success' });
    expect(support).toHaveBeenCalledTimes(2);
    expect(health.at(-1)).toBe('notification-presentation-ready');
    expect(client.on).toHaveBeenCalledTimes(6);
  });

  it('reports disabled permission without attaching or ending the session', () => {
    const { svc, client, health } = setup({
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
    expect(client.on).not.toHaveBeenCalled();
  });

  it('reports a presenter rejection as an incident while keeping activation delivery alive', () => {
    const activated = new Subject<NotificationDestination>();
    const { svc, client, incidents, activations } = setup({
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
    timelineHandler(client)(event(), room, false, false, live);
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

    it('keeps the owning account in the emitted activation', () => {
      const { svc, clients, activations } = setup({
        accounts: ['@me:hs', '@bg:hs'],
        active: '@me:hs',
      });
      svc.connect();
      timelineHandler(clients.get('@bg:hs')!)(
        event(),
        room,
        false,
        false,
        live,
      );

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
      expect(fresh.on).toHaveBeenCalledTimes(3); // Sync + Timeline + Decrypted

      timelineHandler(fresh)(event(), room, false, false, live);

      expect(MockNotification.instances).toHaveLength(1);
    });

    it('stays dormant across sign-out and attaches a later login in the same app session', () => {
      const { svc, clients, accountIds } = setup({ accounts: ['@me:hs'] });
      svc.connect();
      const me = clients.get('@me:hs')!;

      accountIds.set([]); // logout: the client is gone
      TestBed.inject(ApplicationRef).tick();

      expect(me.off).toHaveBeenCalledWith(
        RoomEvent.Timeline,
        expect.any(Function),
      );

      const next = fakeClient('@next:hs');
      clients.set('@next:hs', next);
      accountIds.set(['@next:hs']);
      TestBed.inject(ApplicationRef).tick();

      expect(next.on).toHaveBeenCalledTimes(3);
    });

    it('does not negotiate Web permission until the session has an account', () => {
      MockNotification.permission = 'default';
      const { svc, clients, accountIds } = setup({ accounts: [], active: '' });

      svc.connect();
      expect(MockNotification.requestPermission).not.toHaveBeenCalled();

      clients.set('@next:hs', fakeClient('@next:hs'));
      accountIds.set(['@next:hs']);
      TestBed.inject(ApplicationRef).tick();

      expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
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

      // Attached exactly once: attach() binds Sync + Timeline + Decrypted.
      expect(bg.on).toHaveBeenCalledTimes(3);
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

    it('routes notifications through the main process, not the Web API', async () => {
      // Electron auto-grants Web permission and never prompts; the bridge path
      // must work regardless of the renderer Web permission state.
      MockNotification.permission = 'default';
      const { svc, client } = setup();
      svc.connect();
      await settleDesktopNegotiation();

      expect(MockNotification.requestPermission).not.toHaveBeenCalled();
      expect(
        harness.bridge.capabilities.notificationPresentation.subscribeClicks,
      ).toHaveBeenCalledTimes(1);

      timelineHandler(client)(event(), room, false, false, live);

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
      const { svc, client } = setup();
      svc.connect();
      await settleDesktopNegotiation();

      timelineHandler(client)(event(), room, false, false, live);

      expect(
        harness.bridge.capabilities.notificationPresentation.present,
      ).toHaveBeenCalledTimes(1);
      expect(MockNotification.instances).toHaveLength(0);
    });

    it('still honors gating (own messages / focus / push rules)', async () => {
      const { svc, client } = setup();
      svc.connect();
      await settleDesktopNegotiation();

      timelineHandler(client)(
        event({ sender: '@me:hs' }),
        room,
        false,
        false,
        live,
      );

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
