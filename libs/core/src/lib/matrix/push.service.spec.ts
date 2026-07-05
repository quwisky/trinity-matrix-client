import { Router } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_CONFIG, PushService, type PushConfig } from './push.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

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

function setup(opts: { config?: PushConfig | null } = {}) {
  const client = {
    getDeviceId: vi.fn(() => 'DEV1'),
    setPusher: vi.fn(async () => ({})),
    removePusher: vi.fn(async () => ({})),
  };
  TestBed.configureTestingModule({
    providers: [
      PushService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client as never,
      }),
      MockProvider(Router),
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
  return { svc: TestBed.inject(PushService), client, router };
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
        data: { url: CONFIG.gatewayUrl, format: 'event_id_only' },
      }),
    );
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

  it('opens the app when a notification is tapped', async () => {
    const { svc, router } = setup();
    await firstValueFrom(svc.register());

    h.listeners['pushNotificationActionPerformed']({});

    expect(router.navigate).toHaveBeenCalledWith(['/rooms']);
  });

  it('deletes the pusher and detaches listeners on unregister', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    await firstValueFrom(svc.unregister());

    expect(client.removePusher).toHaveBeenCalledWith(
      'TOKEN123',
      'eu.qwky.trinity.ios',
    );
    expect(h.push.removeAllListeners).toHaveBeenCalled();
  });
});
