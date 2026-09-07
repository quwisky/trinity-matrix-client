import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativePushRegistrationService } from './native-push-registration.service';

const h = vi.hoisted(() => {
  const listeners: Record<string, (value: never) => void> = {};
  const handles: { remove: ReturnType<typeof vi.fn> }[] = [];
  return {
    platform: 'ios',
    available: true,
    androidRegistration: {
      register: vi.fn(async () => undefined),
    },
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
  Capacitor: {
    getPlatform: () => h.platform,
    isPluginAvailable: () => h.available,
  },
  registerPlugin: () => h.androidRegistration,
}));
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: h.push }));

describe('NativePushRegistrationService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    h.platform = 'ios';
    h.available = true;
    h.rejectRemoval = false;
    h.androidRegistration.register.mockReset();
    h.androidRegistration.register.mockResolvedValue(undefined);
    for (const key of Object.keys(h.listeners)) delete h.listeners[key];
    h.handles.length = 0;
    vi.clearAllMocks();
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

  it('uses the Android companion while preserving the iOS push plugin', async () => {
    const service = TestBed.inject(NativePushRegistrationService);
    await firstValueFrom(service.register());
    expect(h.push.register).toHaveBeenCalledOnce();
    expect(h.androidRegistration.register).not.toHaveBeenCalled();

    h.platform = 'android';
    TestBed.resetTestingModule();
    await firstValueFrom(
      TestBed.inject(NativePushRegistrationService).register(),
    );
    expect(h.androidRegistration.register).toHaveBeenCalledOnce();
  });

  it('surfaces a missing Android companion as a rejected registration', async () => {
    h.platform = 'android';
    h.androidRegistration.register.mockRejectedValue(
      new Error('Push notifications are not configured for this Android build'),
    );

    await expect(
      firstValueFrom(TestBed.inject(NativePushRegistrationService).register()),
    ).rejects.toThrow('not configured');
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
    h.listeners['pushNotificationReceived']({
      data: { event_id: '$event' },
    } as never);

    expect(events).toEqual([
      { kind: 'ready' },
      { kind: 'registered', token: 'TOKEN' },
      { kind: 'registration-failed', message: 'no token' },
      { kind: 'activated', data: { room_id: '!room:hs' } },
      { kind: 'activated', data: { legacy: true } },
      { kind: 'received', data: { event_id: '$event' } },
    ]);

    lifetime.unsubscribe();
    expect(h.handles).toHaveLength(4);
    expect(
      h.handles.every(({ remove }) => remove.mock.calls.length === 1),
    ).toBe(true);
  });

  it('contains rejected listener cleanup during session teardown', async () => {
    h.rejectRemoval = true;
    const service = TestBed.inject(NativePushRegistrationService);
    const lifetime = service.listen().subscribe();
    await vi.waitFor(() => expect(h.handles).toHaveLength(4));

    expect(() => lifetime.unsubscribe()).not.toThrow();
    await vi.waitFor(() =>
      expect(h.handles.map(({ remove }) => remove.mock.calls.length)).toEqual([
        1, 1, 1, 1,
      ]),
    );
  });

  it('removes resolved handles even while a later listener is pending', async () => {
    type TestHandle = (typeof h.handles)[number];
    let resolveLate!: (handle: TestHandle) => void;
    const late = new Promise<TestHandle>((resolve) => {
      resolveLate = resolve;
    });
    const immediate = Array.from({ length: 3 }, () => ({
      remove: vi.fn(async () => undefined),
    }));
    const rejected = Promise.reject(new Error('listener unavailable'));
    let index = 0;
    h.push.addListener.mockImplementation(((
      name: string,
      listener: (value: never) => void,
    ) => {
      h.listeners[name] = listener;
      if (name === 'pushNotificationReceived') return late;
      if (name === 'registrationError') {
        return rejected as unknown as Promise<TestHandle>;
      }
      return Promise.resolve(immediate[index++]);
    }) as never);

    const lifetime = TestBed.inject(NativePushRegistrationService)
      .listen()
      .subscribe();
    await vi.waitFor(() => expect(h.push.addListener).toHaveBeenCalledTimes(4));
    await Promise.resolve();
    await Promise.resolve();
    lifetime.unsubscribe();
    expect(
      immediate
        .slice(0, 2)
        .every(({ remove }) => remove.mock.calls.length === 1),
    ).toBe(true);

    const lateHandle: TestHandle = { remove: vi.fn(async () => undefined) };
    resolveLate(lateHandle);
    await vi.waitFor(() => expect(lateHandle.remove).toHaveBeenCalledOnce());
  });
});
