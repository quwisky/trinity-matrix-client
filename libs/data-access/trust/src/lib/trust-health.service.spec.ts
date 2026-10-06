import { TestBed } from '@angular/core/testing';
import {
  TrustCryptoPort,
  type TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import type { ProjectionReconcileContext } from '@trinity/runtime/projection';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, type Observable } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustHealthService } from './trust-health.service';

type ProjectionConfig = Parameters<TrustCryptoPort['project']>[0];

describe('TrustHealthService', () => {
  const isCrossSigningReady = vi.fn<() => Promise<boolean>>();
  const crypto = {
    isCrossSigningReady,
    isSecretStorageReady: vi.fn(async () => true),
    getActiveSessionBackupVersion: vi.fn(async () => null),
    getDeviceVerificationStatus: vi.fn(async () => null),
  };
  const client = {
    getCrypto: () => crypto,
    getDeviceId: () => 'DEVICE',
    getUserId: () => '@me:hs',
    secretStorage: { getDefaultKeyId: vi.fn(async () => null) },
  } as unknown as TrustMatrixClient;
  let config: ProjectionConfig;
  let service: TrustHealthService;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  const rebuild = (ctx: ProjectionReconcileContext) =>
    config.rebuild?.(client, ctx) as Observable<void>;

  function context(): ProjectionReconcileContext {
    return {
      generation: 1,
      publish: vi.fn((commit: () => void) => {
        commit();
        return true;
      }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        TrustHealthService,
        MockProvider(TrustCryptoPort, {
          isAvailable: () => true,
          active: () => ({ client, crypto }) as never,
          project: vi.fn((projectionConfig: ProjectionConfig) => {
            config = projectionConfig;
            return {} as never;
          }),
        }),
      ],
    });
    service = TestBed.inject(TrustHealthService);
  });

  it('keeps the reset state when a refresh finishes after reset', async () => {
    const read = deferred<boolean>();
    isCrossSigningReady.mockReturnValueOnce(read.promise);
    const refreshed = firstValueFrom(service.refresh(), {
      defaultValue: undefined,
    });

    config.reset?.();
    read.resolve(true);
    await refreshed;

    expect(service.health().availability).toBe('unavailable');
    expect(service.status()).toBe('unknown');
  });

  it('drops a projection reconcile superseded by a newer one', async () => {
    const stale = deferred<boolean>();
    isCrossSigningReady
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(false);
    const staleContext = context();
    const newerContext = context();
    const first = firstValueFrom(rebuild(staleContext), {
      defaultValue: undefined,
    });
    await firstValueFrom(rebuild(newerContext), {
      defaultValue: undefined,
    });
    expect(service.status()).toBe('needs-setup');

    stale.resolve(true);
    await first;

    expect(staleContext.publish).not.toHaveBeenCalled();
    expect(newerContext.publish).toHaveBeenCalledOnce();
    expect(service.status()).toBe('needs-setup');
  });
});
