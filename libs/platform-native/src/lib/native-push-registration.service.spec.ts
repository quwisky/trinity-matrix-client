import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, throwError, type Observable } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativePushRegistrationService } from './native-push-registration.service';
import { PushHandoffBridge } from '@trinity/capacitor-push';

const registrationAvailable = vi.fn((): Observable<boolean> => of(true));

function service(): NativePushRegistrationService {
  TestBed.configureTestingModule({
    providers: [
      { provide: PushHandoffBridge, useValue: { registrationAvailable } },
    ],
  });
  return TestBed.inject(NativePushRegistrationService);
}

const h = vi.hoisted(() => {
  const listeners: Record<string, (value: never) => void> = {};
  const handles: { remove: ReturnType<typeof vi.fn> }[] = [];
  return {
    platform: 'ios',
    available: true,
    rejectRemoval: false,
    listeners,
    handles,
    push: {
      requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
      createChannel: vi.fn(async () => undefined),
      addListener: vi.fn(
        async (name: string, listener: (value: never) => void) => {
          listeners[name] = listener;
          const handle = {
            remove: vi.fn(async () => {
              if (h.rejectRemoval) throw new Error('remove failed');
            }),
          };
          handles.push(handle);
          return handle;
        },
      ),
      register: vi.fn(async () => undefined),
      removeAllListeners: vi.fn(async () => undefined),
    },
  };
});

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({})),
  Capacitor: {
    getPlatform: () => h.platform,
    isNativePlatform: () => h.platform !== 'web',
    isPluginAvailable: () => h.available,
  },
}));
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: h.push }));

describe('NativePushRegistrationService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    h.platform = 'ios';
    h.available = true;
    h.rejectRemoval = false;
    for (const key of Object.keys(h.listeners)) delete h.listeners[key];
    h.handles.length = 0;
    vi.clearAllMocks();
    registrationAvailable.mockReturnValue(of(true));
  });

  it('requests permission lazily and prepares a channel only on Android', async () => {
    const service = TestBed.inject(NativePushRegistrationService);
    const permission = service.requestPermission();
    expect(h.push.requestPermissions).not.toHaveBeenCalled();
    await expect(firstValueFrom(permission)).resolves.toBe(true);
    await firstValueFrom(service.prepareChannel());
    expect(h.push.createChannel).not.toHaveBeenCalled();

    h.platform = 'android';
    TestBed.resetTestingModule();
    await firstValueFrom(
      TestBed.inject(NativePushRegistrationService).prepareChannel(),
    );
    expect(h.push.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'messages' }),
    );
  });

  it('normalizes callbacks and owns listener teardown for one subscription', async () => {
    const service = TestBed.inject(NativePushRegistrationService);
    const events: unknown[] = [];
    const lifetime = service.listen().subscribe((event) => events.push(event));
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'ready' }));

    h.listeners['registration']({ value: 'TOKEN' } as never);
    h.listeners['registrationError']({ error: 'no token' } as never);
    h.listeners['pushNotificationActionPerformed']({
      notification: { data: { room_id: '!room:hs' } },
    } as never);
    h.listeners['pushNotificationActionPerformed']({
      data: { legacy: true },
    } as never);

    expect(events).toEqual([
      { kind: 'ready' },
      { kind: 'registered', token: 'TOKEN' },
      { kind: 'registration-failed', message: 'no token' },
      { kind: 'activated', data: { room_id: '!room:hs' } },
      { kind: 'activated', data: { legacy: true } },
    ]);

    lifetime.unsubscribe();
    expect(h.handles).toHaveLength(3);
    expect(
      h.handles.every(({ remove }) => remove.mock.calls.length === 1),
    ).toBe(true);
  });

  it('contains rejected listener cleanup during session teardown', async () => {
    h.rejectRemoval = true;
    const service = TestBed.inject(NativePushRegistrationService);
    const lifetime = service.listen().subscribe();
    await vi.waitFor(() => expect(h.handles).toHaveLength(3));

    expect(() => lifetime.unsubscribe()).not.toThrow();
    await Promise.resolve();
    expect(
      h.handles.every(({ remove }) => remove.mock.calls.length === 1),
    ).toBe(true);
  });

  describe('register', () => {
    it('asks Android for a token once the host says it can register', async () => {
      h.platform = 'android';

      await expect(firstValueFrom(service().register())).resolves.toBe(
        'requested',
      );

      expect(registrationAvailable).toHaveBeenCalledOnce();
      expect(h.push.register).toHaveBeenCalledOnce();
    });

    it('never asks Android for a token when the host cannot register', async () => {
      // Without Firebase the plugin's Android register() crashes the app.
      h.platform = 'android';
      registrationAvailable.mockReturnValue(of(false));

      await expect(firstValueFrom(service().register())).resolves.toBe(
        'unavailable',
      );

      expect(h.push.register).not.toHaveBeenCalled();
    });

    it('treats an Android host that cannot answer as unable to register', async () => {
      h.platform = 'android';
      registrationAvailable.mockReturnValue(
        throwError(() => new Error('plugin missing')),
      );

      await expect(firstValueFrom(service().register())).resolves.toBe(
        'unavailable',
      );

      expect(h.push.register).not.toHaveBeenCalled();
    });

    it('registers on iOS without asking the host first', async () => {
      await expect(firstValueFrom(service().register())).resolves.toBe(
        'requested',
      );

      expect(registrationAvailable).not.toHaveBeenCalled();
      expect(h.push.register).toHaveBeenCalledOnce();
    });

    it('still reports a failed iOS registration as an error', async () => {
      h.push.register.mockRejectedValueOnce(new Error('no aps entitlement'));

      await expect(firstValueFrom(service().register())).rejects.toThrow(
        'no aps entitlement',
      );
    });
  });
});
