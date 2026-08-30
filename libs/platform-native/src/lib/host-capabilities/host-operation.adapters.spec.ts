import { TestBed } from '@angular/core/testing';
import { SwPush } from '@angular/service-worker';
import { Subject, firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapacitorHostOperationAdapter,
  WebHostOperationAdapter,
} from './host-operation.adapters';

const app = vi.hoisted(() => ({
  addListener: vi.fn(),
  getLaunchUrl: vi.fn(),
  minimizeApp: vi.fn(),
}));

vi.mock('@capacitor/app', () => ({ App: app }));

describe('CapacitorHostOperationAdapter event streams', () => {
  beforeEach(() => {
    app.addListener.mockReset();
    app.getLaunchUrl.mockReset();
    app.minimizeApp.mockReset();
    app.getLaunchUrl.mockResolvedValue(null);
  });

  it('routes rejected deep-link listener setup through the Observable error channel', async () => {
    const failure = new Error('listener setup failed');
    app.addListener.mockRejectedValue(failure);

    await expect(
      firstValueFrom(new CapacitorHostOperationAdapter().received),
    ).rejects.toBe(failure);
  });

  it('routes rejected launch URL reads through the Observable error channel', async () => {
    const failure = new Error('launch URL failed');
    app.addListener.mockImplementation(() => new Promise(() => undefined));
    app.getLaunchUrl.mockRejectedValue(failure);

    await expect(
      firstValueFrom(new CapacitorHostOperationAdapter().received),
    ).rejects.toBe(failure);
  });

  it('removes a Back listener that resolves after teardown', async () => {
    let resolveListener!: (value: { remove: () => Promise<void> }) => void;
    const remove = vi.fn(() => Promise.resolve());
    app.addListener.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListener = resolve;
        }),
    );
    const subscription =
      new CapacitorHostOperationAdapter().intents.subscribe();

    subscription.unsubscribe();
    resolveListener({ remove });
    await Promise.resolve();
    await Promise.resolve();

    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('WebHostOperationAdapter notifications', () => {
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
        WebHostOperationAdapter,
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
    const adapter = TestBed.inject(WebHostOperationAdapter);
    const destination = {
      accountId: '@me:example.org',
      roomId: '!room:example.org',
      eventId: '$event',
    } as const;

    await firstValueFrom(
      adapter.present({
        title: 'Alice · General',
        body: 'Hello',
        destination,
      }),
    );

    expect(showNotification).toHaveBeenCalledWith('Alice · General', {
      body: 'Hello',
      data: destination,
    });
  });

  it('returns a typed rejection when the permission prompt is denied', async () => {
    Object.defineProperty(Notification, 'permission', { value: 'default' });
    requestPermission.mockResolvedValueOnce('denied');

    await expect(
      firstValueFrom(
        TestBed.inject(WebHostOperationAdapter).requestPermission(),
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
        TestBed.inject(WebHostOperationAdapter).requestPermission(),
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'notification-permission-failed' },
    });
  });

  it('validates and emits service-worker notification clicks', async () => {
    const adapter = TestBed.inject(WebHostOperationAdapter);
    const activation = firstValueFrom(adapter.activated);
    clicks.next({ action: '', notification: { data: { roomId: 42 } } });
    clicks.next({
      action: '',
      notification: {
        data: {
          accountId: '@me:example.org',
          roomId: '!room:example.org',
          eventId: '$event',
        },
      },
    });

    await expect(activation).resolves.toEqual({
      accountId: '@me:example.org',
      roomId: '!room:example.org',
      eventId: '$event',
    });
  });
});
