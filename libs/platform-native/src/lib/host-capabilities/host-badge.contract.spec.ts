import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import {
  HOST_OPERATIONS,
  type HostBadgeOperation,
  type HostCapabilityManifest,
  type HostCapabilityNegotiator,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { Observable, defer, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopBridgeFixture } from '@trinity/testing';
import { MobileBadgeService } from '../mobile-badge.service';
import {
  CapacitorHostCapabilityAdapter,
  ElectronHostCapabilityAdapter,
  WebHostCapabilityAdapter,
} from './host-capability.adapters';
import { CapacitorNotificationPresentationAdapter } from './host-notification-presentation.adapters';

type Adapter = HostBadgeOperation & HostCapabilityNegotiator;
type AdapterFixture = {
  readonly adapter: Adapter;
  readonly badgeWrite: ReturnType<typeof vi.fn>;
  readonly negotiation?: ReturnType<typeof vi.fn>;
};

function supportedManifest(): HostCapabilityManifest {
  return {
    protocolVersion: 1,
    operations: Object.fromEntries(
      HOST_OPERATIONS.map((operation) => [operation, { kind: 'supported' }]),
    ) as HostCapabilityManifest['operations'],
  };
}

function webFixture(): AdapterFixture {
  const badgeWrite = vi.fn(() => Promise.resolve());
  Object.defineProperties(navigator, {
    setAppBadge: { value: badgeWrite, configurable: true },
    clearAppBadge: { value: badgeWrite, configurable: true },
  });
  return { adapter: new WebHostCapabilityAdapter(), badgeWrite };
}

function capacitorFixture(
  presentationSupported = false,
  platform: 'android' | 'ios' = 'android',
): AdapterFixture {
  vi.spyOn(Capacitor, 'getPlatform').mockReturnValue(platform);
  const badgeWrite = vi.fn((_count: number): Observable<HostOperationOutcome> =>
    defer(() => of({ kind: 'completed' } as const)),
  );
  TestBed.configureTestingModule({
    providers: [
      CapacitorHostCapabilityAdapter,
      {
        provide: MobileBadgeService,
        useValue: {
          support: () => defer(() => of({ kind: 'supported' } as const)),
          set: badgeWrite,
        },
      },
      {
        provide: CapacitorNotificationPresentationAdapter,
        useValue: {
          presentationSupport: () =>
            defer(() =>
              of(
                presentationSupported
                  ? ({ kind: 'supported' } as const)
                  : ({
                      kind: 'unavailable',
                      reason: 'not-supported',
                    } as const),
              ),
            ),
        },
      },
    ],
  });
  return {
    adapter: TestBed.inject(CapacitorHostCapabilityAdapter),
    badgeWrite,
  };
}

function electronFixture(): AdapterFixture {
  const badgeWrite = vi.fn(() => Promise.resolve({ kind: 'completed' }));
  const negotiation = vi.fn(() =>
    Promise.resolve({ kind: 'accepted', ...supportedManifest() }),
  );
  (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
    desktopBridgeFixture({
      negotiate: negotiation,
      capabilities: {
        badge: {
          set: badgeWrite as unknown as (
            count: number,
          ) => Promise<{ kind: 'completed' }>,
        },
      },
    });
  return {
    adapter: new ElectronHostCapabilityAdapter(),
    badgeWrite,
    negotiation,
  };
}

describe.each([
  ['Web', webFixture],
  ['Capacitor', capacitorFixture],
  ['Electron', electronFixture],
] as const)('%s badge host adapter contract', (_host, createFixture) => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    delete (navigator as { setAppBadge?: unknown }).setAppBadge;
    delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('exposes explicit support and a cold, finite badge command', async () => {
    const { adapter, badgeWrite, negotiation } = createFixture();
    const support = adapter.support();
    const command = adapter.set(4);

    expect(badgeWrite).not.toHaveBeenCalled();
    if (negotiation) expect(negotiation).not.toHaveBeenCalled();
    await expect(firstValueFrom(support)).resolves.toEqual({
      kind: 'supported',
    });
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'completed',
    });
    expect(badgeWrite).toHaveBeenCalledExactlyOnceWith(4);
  });
});

describe('host adapter rejection semantics', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    delete (navigator as { setAppBadge?: unknown }).setAppBadge;
    delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
  });

  it('reports an unavailable Web badge explicitly', async () => {
    const adapter = new WebHostCapabilityAdapter();
    await expect(firstValueFrom(adapter.support())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
  });

  it('reports a partial Web badge API as unavailable', async () => {
    Object.defineProperty(navigator, 'setAppBadge', {
      value: vi.fn(() => Promise.resolve()),
      configurable: true,
    });
    const adapter = new WebHostCapabilityAdapter();

    await expect(firstValueFrom(adapter.support())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    await expect(firstValueFrom(adapter.set(0))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
  });

  it('keeps the Web manifest aligned with unavailable operation adapters', async () => {
    const manifest = await firstValueFrom(
      new WebHostCapabilityAdapter().manifest(),
    );

    expect(manifest.operations['deep-links']).toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(manifest.operations.back).toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
  });

  it('keeps the Capacitor manifest aligned with unavailable presentation', async () => {
    const { adapter } = capacitorFixture();
    const manifest = await firstValueFrom(adapter.manifest());

    expect(manifest.operations['notification-presentation']).toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
  });

  it('advertises Capacitor presentation only when the operation is available', async () => {
    const { adapter } = capacitorFixture(true);
    const manifest = await firstValueFrom(adapter.manifest());

    expect(manifest.operations['notification-presentation']).toEqual({
      kind: 'supported',
    });
  });

  it('advertises Android Back while keeping updates explicitly unavailable', async () => {
    const { adapter } = capacitorFixture(true, 'android');
    const value = await firstValueFrom(adapter.manifest());

    expect(value.operations.back).toEqual({ kind: 'supported' });
    expect(value.operations.updates).toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
  });

  it('keeps iOS Back and updates explicitly unavailable', async () => {
    const { adapter } = capacitorFixture(true, 'ios');
    const value = await firstValueFrom(adapter.manifest());

    expect(value.operations.back).toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(value.operations.updates).toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
  });

  it('turns malformed Electron negotiation into secret-safe diagnostics', async () => {
    const secret = 'https://example.test/?access_token=secret';
    const negotiate = vi.fn(() =>
      Promise.resolve({
        kind: 'rejected',
        reason: 'malformed-request',
        secret,
      }),
    );
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture({ negotiate });

    const manifest = await firstValueFrom(
      new ElectronHostCapabilityAdapter().manifest(),
    );
    expect(manifest.operations.badge).toEqual({
      kind: 'unavailable',
      reason: 'host-rejected',
      diagnostic: { code: 'electron-malformed-negotiation' },
    });
    expect(JSON.stringify(manifest)).not.toContain(secret);
  });

  it('rejects a malformed accepted Electron manifest before using an operation', async () => {
    const secret = 'host response with access_token=secret';
    const negotiate = vi.fn(() =>
      Promise.resolve({
        kind: 'accepted',
        protocolVersion: 1,
        operations: { badge: { kind: 'supported' } },
        secret,
      }),
    );
    const badgeWrite = vi.fn();
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture({
        negotiate,
        capabilities: { badge: { set: badgeWrite } },
      });

    const result = await firstValueFrom(
      new ElectronHostCapabilityAdapter().set(4),
    );

    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'host-rejected',
      diagnostic: { code: 'electron-malformed-response' },
    });
    expect(badgeWrite).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('normalizes a hostile resolved operation response without leaking it', async () => {
    const secret = 'access_token=electron-secret';
    const negotiate = vi.fn(() =>
      Promise.resolve({ kind: 'accepted', ...supportedManifest() }),
    );
    const badgeWrite = vi.fn(() =>
      Promise.resolve({
        kind: 'rejected',
        diagnostic: { code: secret },
        secret,
      }),
    );
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture({
        negotiate,
        capabilities: {
          badge: {
            set: badgeWrite as unknown as (
              count: number,
            ) => Promise<{ kind: 'completed' }>,
          },
        },
      });

    const result = await firstValueFrom(
      new ElectronHostCapabilityAdapter().set(4),
    );

    expect(result).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'electron-badge-rejected' },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
