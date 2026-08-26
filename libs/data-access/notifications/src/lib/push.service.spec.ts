import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_ID, PUSH_CONFIG, type PushConfig } from './push-config';
import { PushGatewayService } from './push-gateway.service';
import { PushService } from './push.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import { encodeRoomSegment } from '@trinity/util/matrix';

// Shared, mutable mock state — hoisted so the vi.mock factories can close over it.
const h = vi.hoisted(() => {
  const listeners: Record<string, (arg: unknown) => void> = {};
  const state = { platform: 'ios', permission: 'granted' as string };
  const prefs = new Map<string, string>();
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
  return { listeners, state, push, prefs };
});

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({})),
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
// PushService now resolves its config through the real PushGatewayService, which
// persists to Preferences. Back it with an in-memory store so these tests stay
// hermetic and can drive an override without touching device storage.
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: h.prefs.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      h.prefs.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      h.prefs.delete(key);
    }),
  },
}));

const CONFIG: PushConfig = {
  gatewayUrl: 'https://push.example/_matrix/push/v1/notify',
  appId: 'eu.qwky.trinity',
};

/**
 * A stateful fake of one account's client: an in-memory pusher store keyed by
 * (app_id, pushkey), so setPusher/removePusher/getPushers behave like a homeserver
 * rather than returning fixed values. This makes the readback verification exercise real
 * state — a pusher only reads back if it was actually set — while each method stays a spy
 * the tests can assert on or override with `mockRejectedValueOnce`.
 */
function makeClient() {
  const pushers: { app_id: string; pushkey: string; data: { url: string } }[] =
    [];
  return {
    getDeviceId: vi.fn(() => 'DEV1'),
    setPusher: vi.fn(async (p: (typeof pushers)[number]) => {
      // The homeserver replaces this user's own pusher for the same (app_id, pushkey).
      const i = pushers.findIndex(
        (x) => x.app_id === p.app_id && x.pushkey === p.pushkey,
      );
      if (i >= 0) pushers[i] = p;
      else pushers.push(p);
      return {};
    }),
    removePusher: vi.fn(async (pushkey: string, appId: string) => {
      const i = pushers.findIndex(
        (x) => x.app_id === appId && x.pushkey === pushkey,
      );
      if (i >= 0) pushers.splice(i, 1);
      return {};
    }),
    getPushers: vi.fn(async () => ({ pushers: [...pushers] })),
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
      // The real gateway service, so PushService's config resolution
      // (override ?? PUSH_CONFIG) is exercised end to end. Provided explicitly — not
      // relying on the root singleton — so its signals start clean each test.
      PushGatewayService,
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
    h.prefs.clear();
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
        // Must be true: all accounts share one device token, so `false` would make
        // each account's registration delete the previous account's pusher when both
        // live on the same homeserver (verified against Synapse).
        append: true,
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

  describe('user-set gateway', () => {
    /** Store an override the way PushGatewayService.save() would, then load it. */
    async function withOverride(
      svc: PushService,
      value: { gatewayUrl: string; appId?: string; appliedAppId?: string },
    ): Promise<void> {
      h.prefs.set('trinity.push.gateway', JSON.stringify(value));
      await TestBed.inject(PushGatewayService).init();
    }

    it('registers push against the override when no build config exists', async () => {
      // The headline case: environment.push is null (a stock build), the user sets a
      // gateway, and push comes alive pointing at it.
      const { svc, client } = setup({ config: null });
      await withOverride(svc, {
        gatewayUrl: 'https://mine.example/_matrix/push/v1/notify',
      });

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(client.setPusher).toHaveBeenCalledWith(
        expect.objectContaining({
          app_id: `${DEFAULT_APP_ID}.ios`,
          data: expect.objectContaining({
            url: 'https://mine.example/_matrix/push/v1/notify',
          }),
        }),
      );
    });

    it('prefers the override URL over the build-time default', async () => {
      const { svc, client } = setup({ config: CONFIG });
      await withOverride(svc, {
        gatewayUrl: 'https://override.example/_matrix/push/v1/notify',
      });

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(client.setPusher).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            url: 'https://override.example/_matrix/push/v1/notify',
          }),
        }),
      );
    });

    it('removes the stale pusher before setting the new one when the app id changes', async () => {
      // A previous round registered under `old.app.id`; the user has now changed it.
      // The pusher tuple is (user_id, app_id, pushkey), so the old row must be deleted
      // explicitly or it keeps delivering to the previous gateway.
      const { svc, client } = setup({ config: null });
      await withOverride(svc, {
        gatewayUrl: 'https://mine.example/_matrix/push/v1/notify',
        appId: 'new.app.id',
        appliedAppId: 'old.app.id',
      });

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(client.removePusher).toHaveBeenCalledWith(
        'TOKEN123',
        'old.app.id.ios',
      );
      expect(client.setPusher).toHaveBeenCalledWith(
        expect.objectContaining({ app_id: 'new.app.id.ios' }),
      );
      // Order matters: the delete must precede the set, else a crash between them
      // leaves the old gateway live.
      const removeOrder = client.removePusher.mock.invocationCallOrder[0];
      const setOrder = client.setPusher.mock.invocationCallOrder[0];
      expect(removeOrder).toBeLessThan(setOrder);
    });

    it('does not remove anything when the app id is unchanged', async () => {
      const { svc, client } = setup({ config: null });
      await withOverride(svc, {
        gatewayUrl: 'https://mine.example/_matrix/push/v1/notify',
        appId: 'same.app.id',
        appliedAppId: 'same.app.id',
      });

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(client.removePusher).not.toHaveBeenCalled();
      expect(client.setPusher).toHaveBeenCalledWith(
        expect.objectContaining({ app_id: 'same.app.id.ios' }),
      );
    });

    it('records the applied app id after a successful round', async () => {
      const { svc } = setup({ config: null });
      await withOverride(svc, {
        gatewayUrl: 'https://mine.example/_matrix/push/v1/notify',
        appId: 'new.app.id',
      });

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(TestBed.inject(PushGatewayService).appliedAppId()).toBe(
        'new.app.id',
      );
    });

    it('does not advance the applied id when an account fails to register', async () => {
      // Partial failure must leave the ledger on the old id so the next round retries
      // the swap rather than orphaning a pusher.
      const { svc, clients } = setup({
        config: null,
        accounts: ['@me:hs', '@alt:hs'],
      });
      await withOverride(svc, {
        gatewayUrl: 'https://mine.example/_matrix/push/v1/notify',
        appId: 'new.app.id',
        appliedAppId: 'old.app.id',
      });
      clients
        .get('@alt:hs')!
        .setPusher.mockRejectedValueOnce(new Error('server down'));

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(TestBed.inject(PushGatewayService).appliedAppId()).toBe(
        'old.app.id',
      );
    });
  });

  describe('registration state', () => {
    it('starts idle', () => {
      const { svc } = setup();
      expect(svc.registration()).toEqual({ status: 'idle' });
    });

    it('reports applied with the account count after a successful round', async () => {
      const { svc } = setup({ accounts: ['@me:hs', '@alt:hs'] });

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      const state = svc.registration();
      expect(state.status).toBe('applied');
      expect(state).toMatchObject({ status: 'applied', accounts: 2 });
      expect(state.status === 'applied' && state.at).toBeGreaterThan(0);
    });

    it('records the homeserver error instead of swallowing it, and still completes', async () => {
      const { svc, client } = setup();
      // A MatrixError carries the human text in `data.error` — the notify-path
      // rejection a mistyped gateway produces.
      client.setPusher.mockRejectedValueOnce({
        message: 'MatrixError: [400]',
        data: { error: "Config Error: 'url' must have a path of ..." },
      });

      // register() must resolve normally — the observable does not error out.
      await expect(firstValueFrom(svc.register())).resolves.toBeUndefined();
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(svc.registration()).toEqual({
        status: 'error',
        message: "Config Error: 'url' must have a path of ...",
      });
    });

    it('falls back to a generic message when the rejection carries no text', async () => {
      const { svc, client } = setup();
      client.setPusher.mockRejectedValueOnce(undefined);

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(svc.registration()).toMatchObject({ status: 'error' });
    });

    it('reads the pushers back to confirm the homeserver kept them', async () => {
      const { svc, client } = setup();

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(client.getPushers).toHaveBeenCalled();
      expect(svc.registration().status).toBe('applied');
    });

    it('downgrades to an error if the homeserver accepted but did not keep the pusher', async () => {
      // setPusher resolves (200) but the pusher is absent on readback — the accept-and-
      // drop a non-Synapse homeserver can exhibit. This is the case setPusher's own
      // return value cannot catch.
      const { svc, client } = setup();
      client.getPushers.mockResolvedValue({ pushers: [] });

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(svc.registration().status).toBe('error');
    });

    it('leaves the applied state standing when the readback itself fails', async () => {
      // A failed GET is inconclusive — the pusher was accepted, so a transient network
      // error on the readback must not report the registration as broken.
      const { svc, client } = setup();
      client.getPushers.mockRejectedValue(new Error('network'));

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(svc.registration().status).toBe('applied');
    });

    it('returns to idle when all pushers are torn down', async () => {
      const { svc } = setup();
      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();
      expect(svc.registration().status).toBe('applied');

      await firstValueFrom(svc.unregister());

      expect(svc.registration()).toEqual({ status: 'idle' });
    });
  });

  it('does not register a pusher when permission is denied', async () => {
    h.state.permission = 'denied';
    const { svc, client } = setup();

    await firstValueFrom(svc.register());

    expect(h.push.register).not.toHaveBeenCalled();
    expect(client.setPusher).not.toHaveBeenCalled();
    // Push is the ONLY delivery path on mobile, so a denial has to be visible in
    // settings — "denied" and "never attempted" must not both read as idle.
    expect(svc.registration()).toMatchObject({ status: 'error' });
  });

  describe('a refused device token', () => {
    it('surfaces the registrationError and lets a later register() retry', async () => {
      // FCM/APNs refuses the token AFTER the one-time OS flow has been marked as run.
      // Without releasing that guard the refusal is silent AND permanent: no pusher,
      // no notifications, and no way back for the lifetime of the process.
      const { svc, client } = setup();
      await firstValueFrom(svc.register());

      h.listeners['registrationError']({ error: 'SENDER_ID_MISMATCH' });

      expect(svc.registration()).toEqual({
        status: 'error',
        message: 'SENDER_ID_MISMATCH',
      });

      // The retry gets as far as the OS again, and a token this time registers pushers.
      await firstValueFrom(svc.register());
      expect(h.push.register).toHaveBeenCalledTimes(2);

      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();
      expect(client.setPusher).toHaveBeenCalled();
    });

    it('releases the one-time guard when register() itself rejects', async () => {
      const { svc } = setup();
      h.push.register.mockRejectedValueOnce(
        new Error('no google play services'),
      );

      await firstValueFrom(svc.register());

      expect(svc.registration()).toEqual({
        status: 'error',
        message: 'no google play services',
      });

      await firstValueFrom(svc.register());
      expect(h.push.register).toHaveBeenCalledTimes(2);
    });
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

  it('falls back to the bundle id when the config omits appId', async () => {
    // `appId` is optional, so a config carrying only a gateway URL must still produce a
    // usable app id. Interpolating the missing field directly would send the literal
    // "undefined.ios" to the homeserver — a pusher no gateway could ever match.
    const { svc, clients } = setup({
      config: { gatewayUrl: 'https://push.example/_matrix/push/v1/notify' },
    });

    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    expect(clients.get('@me:hs')!.setPusher).toHaveBeenCalledWith(
      expect.objectContaining({ app_id: `${DEFAULT_APP_ID}.ios` }),
    );
    const [[sent]] = clients.get('@me:hs')!.setPusher.mock.calls;
    expect(sent.app_id).not.toContain('undefined');
  });

  it('registers every account with append:true so co-hosted accounts survive', async () => {
    // Regression guard. All accounts share one device token as the pushkey, and
    // `append` is what tells the homeserver to leave *other users'* pushers for that
    // key alone. With `append: false` two accounts on the same homeserver clobber
    // each other and only the last one registered still receives push — confirmed
    // against Synapse, where the earlier account's pusher count drops to 0.
    const { svc, clients } = setup({ accounts: ['@me:hs', '@alt:hs'] });

    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    for (const userId of ['@me:hs', '@alt:hs']) {
      expect(clients.get(userId)!.setPusher).toHaveBeenCalledWith(
        expect.objectContaining({ append: true, pushkey: 'TOKEN123' }),
      );
    }
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
    expect(router.navigate).toHaveBeenCalledWith([
      '/rooms',
      encodeRoomSegment('!r:hs'),
    ]);
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
    expect(router.navigate).toHaveBeenCalledWith([
      '/rooms',
      encodeRoomSegment('!a:hs'),
    ]);
    expect(router.navigate).toHaveBeenCalledWith([
      '/rooms',
      encodeRoomSegment('!b:hs'),
    ]);
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
