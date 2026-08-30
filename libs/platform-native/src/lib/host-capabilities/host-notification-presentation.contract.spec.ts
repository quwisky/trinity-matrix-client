import { TestBed } from '@angular/core/testing';
import { SwPush } from '@angular/service-worker';
import {
  HostCapabilitiesService,
  type HostCapabilityManifest,
  type HostNotificationPresentationOperation,
} from '@trinity/runtime/host';
import { desktopBridgeFixture } from '@trinity/testing';
import { EMPTY, firstValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapacitorNotificationPresentationAdapter,
  ElectronNotificationPresentationAdapter,
  WebNotificationPresentationAdapter,
} from './host-notification-presentation.adapters';

const cap = vi.hoisted(() => ({ available: true, platform: 'android' }));
const native = vi.hoisted(() => ({
  addListener: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  createChannel: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('@capacitor/app', () => ({ App: {} }));
vi.mock('@capacitor/browser', () => ({ Browser: {} }));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => cap.platform,
    isPluginAvailable: () => cap.available,
  },
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: native,
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

interface Fixture {
  readonly adapter: HostNotificationPresentationOperation;
  readonly present: ReturnType<typeof vi.fn>;
}

function manifest(
  presentation: HostCapabilityManifest['operations']['notification-presentation'] = {
    kind: 'supported',
  },
): HostCapabilityManifest {
  return {
    protocolVersion: 1,
    operations: {
      'authentication-handoff': {
        kind: 'unavailable',
        reason: 'not-supported',
      },
      'deep-links': { kind: 'unavailable', reason: 'not-supported' },
      back: { kind: 'unavailable', reason: 'not-supported' },
      'file-export': { kind: 'unavailable', reason: 'not-supported' },
      'notification-presentation': presentation,
      location: { kind: 'unavailable', reason: 'not-supported' },
      badge: { kind: 'unavailable', reason: 'not-supported' },
      'secure-store': { kind: 'unavailable', reason: 'not-supported' },
      lifecycle: { kind: 'unavailable', reason: 'not-supported' },
      updates: { kind: 'unavailable', reason: 'not-supported' },
    },
  };
}

function webFixture(): Fixture {
  const present = vi.fn();
  vi.stubGlobal(
    'Notification',
    class {
      static permission = 'granted';
      static requestPermission = vi.fn(async () => 'granted');
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(title: string, options: NotificationOptions) {
        present(title, options);
      }
    },
  );
  TestBed.configureTestingModule({
    providers: [
      WebNotificationPresentationAdapter,
      { provide: SwPush, useValue: { notificationClicks: EMPTY } },
    ],
  });
  return {
    adapter: TestBed.inject(WebNotificationPresentationAdapter),
    present,
  };
}

function capacitorFixture(): Fixture {
  return {
    adapter: new CapacitorNotificationPresentationAdapter(),
    present: native.schedule,
  };
}

function electronFixture(): Fixture {
  const present = vi.fn(async () => ({ kind: 'completed' as const }));
  (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
    desktopBridgeFixture({
      capabilities: { notificationPresentation: { present } },
    });
  TestBed.configureTestingModule({
    providers: [
      ElectronNotificationPresentationAdapter,
      {
        provide: HostCapabilitiesService,
        useValue: { manifest: () => of(manifest()) },
      },
    ],
  });
  return {
    adapter: TestBed.inject(ElectronNotificationPresentationAdapter),
    present,
  };
}

describe.each([
  ['Web', webFixture],
  ['Android/iOS Capacitor', capacitorFixture],
  ['Electron', electronFixture],
] as const)('%s notification presenter contract', (_host, createFixture) => {
  beforeEach(() => {
    cap.available = true;
    cap.platform = 'android';
    native.schedule.mockReset().mockResolvedValue({ notifications: [] });
    native.createChannel.mockReset().mockResolvedValue(undefined);
    native.checkPermissions
      .mockReset()
      .mockResolvedValue({ display: 'granted' });
    native.requestPermissions
      .mockReset()
      .mockResolvedValue({ display: 'granted' });
    native.addListener.mockReset().mockResolvedValue({
      remove: vi.fn(async () => undefined),
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });

  it('exposes support and a cold, finite typed presentation command', async () => {
    const { adapter, present } = createFixture();
    const command = adapter.present(request);

    expect(present).not.toHaveBeenCalled();
    await expect(
      firstValueFrom(adapter.presentationSupport()),
    ).resolves.toEqual({ kind: 'supported' });
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'completed',
    });
    expect(present).toHaveBeenCalledOnce();
  });
});

describe('unavailable native notification presenter', () => {
  afterEach(() => {
    cap.available = true;
    TestBed.resetTestingModule();
  });

  it('does not touch the plugin when explicit availability is false', async () => {
    cap.available = false;
    const adapter = new CapacitorNotificationPresentationAdapter();

    await expect(
      firstValueFrom(adapter.presentationSupport()),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-supported' });
    await expect(firstValueFrom(adapter.present(request))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(native.schedule).not.toHaveBeenCalled();
  });
});

describe('unavailable Electron notification presenter', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });

  it('reflects the negotiated host support instead of attempting presentation', async () => {
    const present = vi.fn();
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture({
        capabilities: { notificationPresentation: { present } },
      });
    TestBed.configureTestingModule({
      providers: [
        ElectronNotificationPresentationAdapter,
        {
          provide: HostCapabilitiesService,
          useValue: {
            manifest: () =>
              of(
                manifest({
                  kind: 'unavailable',
                  reason: 'not-implemented',
                }),
              ),
          },
        },
      ],
    });

    await expect(
      firstValueFrom(
        TestBed.inject(
          ElectronNotificationPresentationAdapter,
        ).presentationSupport(),
      ),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-implemented' });
    expect(present).not.toHaveBeenCalled();
  });
});
