import { TestBed } from '@angular/core/testing';
import { SwPush } from '@angular/service-worker';
import { Subject, firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapacitorNotificationPresentationAdapter,
  WebNotificationPresentationAdapter,
} from './host-notification-presentation.adapters';

const cap = vi.hoisted(() => ({
  native: true,
  platform: 'android',
  notificationsAvailable: true,
}));

const localNotifications = vi.hoisted(() => ({
  addListener: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  createChannel: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => cap.native,
    getPlatform: () => cap.platform,
    isPluginAvailable: () => cap.notificationsAvailable,
  },
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: localNotifications,
}));

const destination = {
  accountId: '@me:example.org',
  roomId: '!room:example.org',
  eventId: '$event',
} as const;

const request = {
  title: 'Alice · General',
  body: 'Hello',
  tag: '@me:example.org !room:example.org',
  silent: false,
  destination,
} as const;

describe('CapacitorNotificationPresentationAdapter', () => {
  beforeEach(() => {
    cap.native = true;
    cap.platform = 'android';
    cap.notificationsAvailable = true;
    localNotifications.addListener.mockReset().mockResolvedValue({
      remove: vi.fn(() => Promise.resolve()),
    });
    localNotifications.checkPermissions
      .mockReset()
      .mockResolvedValue({ display: 'granted' });
    localNotifications.requestPermissions
      .mockReset()
      .mockResolvedValue({ display: 'granted' });
    localNotifications.createChannel.mockReset().mockResolvedValue(undefined);
    localNotifications.schedule
      .mockReset()
      .mockResolvedValue({ notifications: [] });
  });

  it('reports presentation unavailable when the plugin is absent', async () => {
    cap.notificationsAvailable = false;

    await expect(
      firstValueFrom(
        new CapacitorNotificationPresentationAdapter().presentationSupport(),
      ),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-supported' });
    expect(localNotifications.checkPermissions).not.toHaveBeenCalled();
  });

  it('requests native permission only when it is not already granted', async () => {
    localNotifications.checkPermissions.mockResolvedValueOnce({
      display: 'prompt',
    });

    await expect(
      firstValueFrom(
        new CapacitorNotificationPresentationAdapter().requestPermission(),
      ),
    ).resolves.toEqual({ kind: 'completed' });
    expect(localNotifications.requestPermissions).toHaveBeenCalledOnce();

    localNotifications.checkPermissions.mockResolvedValueOnce({
      display: 'denied',
    });
    localNotifications.requestPermissions.mockResolvedValueOnce({
      display: 'denied',
    });
    await expect(
      firstValueFrom(
        new CapacitorNotificationPresentationAdapter().requestPermission(),
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'notification-permission-denied' },
    });
  });

  it('maps rejected native permission APIs to a secret-safe typed outcome', async () => {
    localNotifications.checkPermissions.mockRejectedValueOnce(
      new Error('native permission details'),
    );
    const checkFailure = await firstValueFrom(
      new CapacitorNotificationPresentationAdapter().requestPermission(),
    );
    expect(checkFailure).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'notification-permission-failed' },
    });
    expect(JSON.stringify(checkFailure)).not.toContain(
      'native permission details',
    );

    localNotifications.checkPermissions.mockResolvedValueOnce({
      display: 'prompt',
    });
    localNotifications.requestPermissions.mockRejectedValueOnce(
      new Error('native prompt details'),
    );
    const promptFailure = await firstValueFrom(
      new CapacitorNotificationPresentationAdapter().requestPermission(),
    );
    expect(promptFailure).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'notification-permission-failed' },
    });
    expect(JSON.stringify(promptFailure)).not.toContain(
      'native prompt details',
    );
  });

  it('maps one typed intent into an audible local notification', async () => {
    await expect(
      firstValueFrom(
        new CapacitorNotificationPresentationAdapter().present(request),
      ),
    ).resolves.toEqual({ kind: 'completed' });

    expect(localNotifications.schedule).toHaveBeenCalledWith({
      notifications: [
        expect.objectContaining({
          id: expect.any(Number),
          title: request.title,
          body: request.body,
          extra: destination,
          group: request.tag,
          threadIdentifier: request.tag,
          sound: 'default',
          foreground: true,
          isExactNotification: false,
        }),
      ],
    });
  });

  it('uses a no-sound Android channel for a silent intent', async () => {
    await firstValueFrom(
      new CapacitorNotificationPresentationAdapter().present({
        ...request,
        silent: true,
      }),
    );

    expect(localNotifications.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'trinity-notifications-silent',
        vibration: false,
      }),
    );
    expect(localNotifications.schedule).toHaveBeenCalledWith({
      notifications: [
        expect.objectContaining({
          channelId: 'trinity-notifications-silent',
        }),
      ],
    });
  });

  it('keeps a silent iOS notification visible without adding a sound', async () => {
    cap.platform = 'ios';
    await firstValueFrom(
      new CapacitorNotificationPresentationAdapter().present({
        ...request,
        silent: true,
      }),
    );

    expect(localNotifications.createChannel).not.toHaveBeenCalled();
    const notification =
      localNotifications.schedule.mock.calls[0][0].notifications[0];
    expect(notification).toMatchObject({ foreground: true });
    expect(notification).not.toHaveProperty('sound');
    expect(notification).not.toHaveProperty('channelId');
  });

  it('maps native channel and scheduling failures to secret-safe typed outcomes', async () => {
    localNotifications.schedule.mockRejectedValueOnce(
      new Error('native scheduling details'),
    );
    const scheduleFailure = await firstValueFrom(
      new CapacitorNotificationPresentationAdapter().present(request),
    );
    expect(scheduleFailure).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'notification-presentation-failed' },
    });
    expect(JSON.stringify(scheduleFailure)).not.toContain(
      'native scheduling details',
    );

    localNotifications.createChannel.mockRejectedValueOnce(
      new Error('native channel details'),
    );
    const channelFailure = await firstValueFrom(
      new CapacitorNotificationPresentationAdapter().present({
        ...request,
        silent: true,
      }),
    );
    expect(channelFailure).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'notification-presentation-failed' },
    });
    expect(JSON.stringify(channelFailure)).not.toContain(
      'native channel details',
    );
  });

  it('validates activation data and removes its listener on teardown', async () => {
    let activate!: (event: { notification: { extra?: unknown } }) => void;
    const remove = vi.fn(() => Promise.resolve());
    localNotifications.addListener.mockImplementationOnce(
      (_event: string, listener: typeof activate) => {
        activate = listener;
        return Promise.resolve({ remove });
      },
    );
    const values: unknown[] = [];
    const subscription =
      new CapacitorNotificationPresentationAdapter().activated.subscribe(
        (value) => values.push(value),
      );
    await Promise.resolve();
    activate({ notification: { extra: { roomId: 42 } } });
    activate({ notification: { extra: destination } });

    expect(values).toEqual([destination]);
    subscription.unsubscribe();
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe('WebNotificationPresentationAdapter', () => {
  const requestPermission = vi.fn();
  const clicks = new Subject<{
    readonly action: string;
    readonly notification: { readonly data?: unknown };
  }>();

  beforeEach(() => {
    requestPermission.mockReset();
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted';
        static requestPermission = requestPermission;
      },
    );
    TestBed.configureTestingModule({
      providers: [
        WebNotificationPresentationAdapter,
        { provide: SwPush, useValue: { notificationClicks: clicks } },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    vi.unstubAllGlobals();
  });

  it('delivers through the controlling service worker with a typed destination', async () => {
    const showNotification = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: {},
        ready: Promise.resolve({ showNotification }),
      },
    });
    const adapter = TestBed.inject(WebNotificationPresentationAdapter);

    await firstValueFrom(adapter.present(request));

    expect(showNotification).toHaveBeenCalledWith(request.title, {
      body: request.body,
      tag: request.tag,
      silent: false,
      data: destination,
    });
  });

  it('returns a typed rejection when the permission prompt is denied', async () => {
    Object.defineProperty(Notification, 'permission', { value: 'default' });
    requestPermission.mockResolvedValueOnce('denied');

    await expect(
      firstValueFrom(
        TestBed.inject(WebNotificationPresentationAdapter).requestPermission(),
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'notification-permission-denied' },
    });
  });

  it('returns a typed rejection when the permission prompt fails', async () => {
    Object.defineProperty(Notification, 'permission', { value: 'default' });
    requestPermission.mockRejectedValueOnce(new Error('prompt failed'));

    await expect(
      firstValueFrom(
        TestBed.inject(WebNotificationPresentationAdapter).requestPermission(),
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'notification-permission-failed' },
    });
  });

  it('validates and emits service-worker notification clicks', async () => {
    const adapter = TestBed.inject(WebNotificationPresentationAdapter);
    const activation = firstValueFrom(adapter.activated);
    clicks.next({ action: '', notification: { data: { roomId: 42 } } });
    clicks.next({ action: '', notification: { data: destination } });

    await expect(activation).resolves.toEqual(destination);
  });
});
