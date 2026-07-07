import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_CONFIG, PushService, type PushConfig } from './push.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { SessionStorageService } from '@trinity/platform-native';

// Shared, mutable mock state — hoisted so the vi.mock factories can close over it.
const h = vi.hoisted(() => {
  const listeners: Record<string, (arg: unknown) => void> = {};
  const state = { platform: 'ios', permission: 'granted' as string };
  const push = {
    requestPermissions: vi.fn(async () => ({ receive: state.permission })),
    register: vi.fn(async () => undefined),
    createChannel: vi.fn(async () => undefined),
    addListener: vi.fn(async (event: string, cb: (arg: unknown) => void) => {
      listeners[event] = cb;
      return { remove: vi.fn() };
    }),
    removeAllListeners: vi.fn(async () => undefined),
  };
  return { listeners, state, push };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => h.state.platform,
    // Electron reports isNativePlatform() === true but has no push plugin — the
    // service must NOT rely on this (see the electron test below).
    isNativePlatform: () => h.state.platform !== 'web',
    isPluginAvailable: () =>
      h.state.platform === 'ios' || h.state.platform === 'android',
  },
}));
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: h.push }));

const CONFIG: PushConfig = {
  gatewayUrl: 'https://push.example/_matrix/push/v1/notify',
  appId: 'eu.qwky.trinity',
};

function makeClient() {
  return {
    getDeviceId: vi.fn(() => 'DEV1'),
    setPusher: vi.fn(async () => ({})),
    removePusher: vi.fn(async () => ({})),
  };
}

function setup(
  opts: {
    config?: PushConfig | null;
    accounts?: string[];
    active?: string;
  } = {},
) {
  const ids = opts.accounts ?? ['@me:hs'];
  const active = opts.active ?? ids[0];
  const clients = new Map(ids.map((id) => [id, makeClient()]));
  const accountIds = signal<readonly string[]>(ids);
  const activeUserId = signal<string | null>(active);
  const setActive = vi.fn();
  const storageSetActive = vi.fn(() => of(undefined));
  TestBed.configureTestingModule({
    providers: [
      PushService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        accountIds: accountIds.asReadonly(),
        activeUserId: activeUserId.asReadonly(),
        all: () =>
          [...clients.entries()].map(
            ([userId, client]) => ({ userId, client }) as never,
          ),
        clientFor: (id: string) => (clients.get(id) as never) ?? null,
        setActive,
      }),
      MockProvider(Router),
      MockProvider(SessionStorageService, { setActive: storageSetActive }),
      {
        provide: PUSH_CONFIG,
        useValue: 'config' in opts ? opts.config : CONFIG,
      },
    ],
  });
  const router = TestBed.inject(Router);
  // `router.navigate` is an auto-spy (returns undefined); the service chains
  // `.catch()` on it, so give it a resolved promise to await.
  vi.mocked(router.navigate).mockResolvedValue(true);
  return {
    svc: TestBed.inject(PushService),
    clients,
    client: clients.get(active)!,
    setActive,
    storageSetActive,
    router,
  };
}

/** Let the fire-and-forget `setPusher` microtasks settle. */
const flush = () => new Promise((r) => setTimeout(r));

describe('PushService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    h.state.platform = 'ios';
    h.state.permission = 'granted';
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    vi.clearAllMocks();
  });

  it('registers a Matrix pusher with the device token on iOS', async () => {
    const { svc, client } = setup();

    await firstValueFrom(svc.register());
    expect(h.push.requestPermissions).toHaveBeenCalled();
    expect(h.push.register).toHaveBeenCalled();

    // The plugin delivers the APNs/FCM token via the `registration` event.
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    expect(client.setPusher).toHaveBeenCalledWith(
      expect.objectContaining({
        app_id: 'eu.qwky.trinity.ios',
        pushkey: 'TOKEN123',
        kind: 'http',
        append: false,
        // Tagged with the owning account so the gateway can fan out per account.
        data: {
          url: CONFIG.gatewayUrl,
          format: 'event_id_only',
          trinity_user_id: '@me:hs',
        },
      }),
    );
  });

  it('registers a pusher on every account, each tagged by its user id', async () => {
    const { clients } = setup({ accounts: ['@me:hs', '@alt:hs'] });
    const svc = TestBed.inject(PushService);

    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    for (const [userId, client] of clients) {
      expect(client.setPusher).toHaveBeenCalledWith(
        expect.objectContaining({
          pushkey: 'TOKEN123',
          data: expect.objectContaining({ trinity_user_id: userId }),
        }),
      );
    }
  });

  it('creates the Android notification channel before registering', async () => {
    h.state.platform = 'android';
    const { svc } = setup();

    await firstValueFrom(svc.register());

    expect(h.push.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'messages' }),
    );
    expect(h.push.register).toHaveBeenCalled();
  });

  it('no-ops on web (plugin unavailable)', async () => {
    h.state.platform = 'web';
    const { svc, client } = setup();

    await firstValueFrom(svc.register());

    expect(h.push.requestPermissions).not.toHaveBeenCalled();
    expect(h.push.register).not.toHaveBeenCalled();
    expect(client.setPusher).not.toHaveBeenCalled();
  });

  it('no-ops on Electron even though isNativePlatform() is true', async () => {
    h.state.platform = 'electron';
    const { svc } = setup();

    await firstValueFrom(svc.register());

    expect(h.push.requestPermissions).not.toHaveBeenCalled();
    expect(h.push.register).not.toHaveBeenCalled();
  });

  it('no-ops when no push config is provided', async () => {
    const { svc } = setup({ config: null });

    await firstValueFrom(svc.register());

    expect(h.push.requestPermissions).not.toHaveBeenCalled();
  });

  it('does not register a pusher when permission is denied', async () => {
    h.state.permission = 'denied';
    const { svc, client } = setup();

    await firstValueFrom(svc.register());

    expect(h.push.register).not.toHaveBeenCalled();
    expect(client.setPusher).not.toHaveBeenCalled();
  });

  it('runs the OS-registration flow only once (idempotent)', async () => {
    const { svc } = setup();

    await firstValueFrom(svc.register());
    await firstValueFrom(svc.register());

    expect(h.push.register).toHaveBeenCalledTimes(1);
  });

  it('re-applies pushers for all accounts on a repeat register (new account)', async () => {
    const { svc, clients } = setup({ accounts: ['@me:hs'] });

    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();
    clients.get('@me:hs')!.setPusher.mockClear();

    // A second account joined; a repeat register() re-applies pushers for all.
    clients.set('@alt:hs', makeClient());
    await firstValueFrom(svc.register());
    await flush();

    expect(clients.get('@me:hs')!.setPusher).toHaveBeenCalled();
    expect(clients.get('@alt:hs')!.setPusher).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trinity_user_id: '@alt:hs' }),
      }),
    );
  });

  it('opens the app when a notification is tapped', async () => {
    const { svc, router } = setup();
    await firstValueFrom(svc.register());

    h.listeners['pushNotificationActionPerformed']({});

    expect(router.navigate).toHaveBeenCalledWith(['/rooms']);
  });

  it('switches to the tagged account and opens the room on tap', async () => {
    const { svc, router, setActive, storageSetActive } = setup({
      accounts: ['@me:hs', '@alt:hs'],
      active: '@me:hs',
    });
    await firstValueFrom(svc.register());

    h.listeners['pushNotificationActionPerformed']({
      notification: {
        data: { trinity_user_id: '@alt:hs', room_id: '!r:hs' },
      },
    });

    expect(setActive).toHaveBeenCalledWith('@alt:hs');
    expect(storageSetActive).toHaveBeenCalledWith('@alt:hs');
    expect(router.navigate).toHaveBeenCalledWith(['/rooms'], {
      queryParams: { room: '!r:hs' },
    });
  });

  it('opens the room but does not switch when the tagged account is gone or already active', async () => {
    const { svc, router, setActive, storageSetActive } = setup({
      accounts: ['@me:hs', '@alt:hs'],
      active: '@me:hs',
    });
    await firstValueFrom(svc.register());

    // Tagged with an account signed out since delivery — not in accountIds().
    h.listeners['pushNotificationActionPerformed']({
      notification: { data: { trinity_user_id: '@gone:hs', room_id: '!a:hs' } },
    });
    // Tagged with the account that is already active — no redundant switch.
    h.listeners['pushNotificationActionPerformed']({
      notification: { data: { trinity_user_id: '@me:hs', room_id: '!b:hs' } },
    });

    expect(setActive).not.toHaveBeenCalled();
    expect(storageSetActive).not.toHaveBeenCalled();
    // The room still opens in both cases (the switch guard is independent of nav).
    expect(router.navigate).toHaveBeenCalledWith(['/rooms'], {
      queryParams: { room: '!a:hs' },
    });
    expect(router.navigate).toHaveBeenCalledWith(['/rooms'], {
      queryParams: { room: '!b:hs' },
    });
  });

  it('deletes every account pusher and detaches listeners on full unregister', async () => {
    const { svc, clients } = setup({ accounts: ['@me:hs', '@alt:hs'] });
    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    await firstValueFrom(svc.unregister());

    for (const [, client] of clients) {
      expect(client.removePusher).toHaveBeenCalledWith(
        'TOKEN123',
        'eu.qwky.trinity.ios',
      );
    }
    expect(h.push.removeAllListeners).toHaveBeenCalled();
  });

  it('deletes only one account pusher on a per-account unregister', async () => {
    const { svc, clients } = setup({ accounts: ['@me:hs', '@alt:hs'] });
    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    await firstValueFrom(svc.unregister('@alt:hs'));

    expect(clients.get('@alt:hs')!.removePusher).toHaveBeenCalledWith(
      'TOKEN123',
      'eu.qwky.trinity.ios',
    );
    expect(clients.get('@me:hs')!.removePusher).not.toHaveBeenCalled();
    // A single-account teardown must NOT detach the shared listeners.
    expect(h.push.removeAllListeners).not.toHaveBeenCalled();
  });
});
