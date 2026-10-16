import { TestBed } from '@angular/core/testing';
import {
  Router,
  UrlTree,
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { MockProvider } from 'ng-mocks';
import {
  NEVER,
  Subject,
  firstValueFrom,
  of,
  throwError,
  type Observable,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_CONFIRMATION_SETTLE_MS,
  TrustDeviceConfirmationService,
  TrustSlotForecastService,
  type DeviceConfirmationGate,
} from '@trinity/data-access/trust';
import {
  FORECAST_HYDRATE_MS,
  deviceConfirmationGuard,
} from './device-confirmation.guard';

function run(
  url: string,
  settledGate: () => Observable<DeviceConfirmationGate>,
  confirmRequired: () => Observable<boolean> = () => of(true),
  hydrateActive: () => Observable<void> = () => of(undefined),
): Promise<boolean | UrlTree> {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      MockProvider(TrustDeviceConfirmationService, {
        settledGate,
        confirmRequired,
      }),
      MockProvider(TrustSlotForecastService, { hydrateActive }),
    ],
  });
  return firstValueFrom(
    TestBed.runInInjectionContext(() =>
      deviceConfirmationGuard(
        {} as ActivatedRouteSnapshot,
        { url } as RouterStateSnapshot,
      ),
    ),
  );
}

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('deviceConfirmationGuard', () => {
  it('sends a device that still needs verifying to the check', async () => {
    const result = await run('/rooms', () =>
      of({ kind: 'required', status: 'needs-recovery' }),
    );

    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe(
      '/encryption/confirm',
    );
  });

  it('holds every Settings section but Security', async () => {
    const result = await run('/settings/notifications', () =>
      of({ kind: 'required', status: 'needs-verification' }),
    );

    expect(result).toBeInstanceOf(UrlTree);
  });

  it('lets Settings › Security through without waiting for the check', async () => {
    const settledGate = vi.fn(() => NEVER);

    await expect(run('/settings/security#export', settledGate)).resolves.toBe(
      true,
    );
    expect(settledGate).not.toHaveBeenCalled();
  });

  it('lets every other device through', async () => {
    await expect(
      run('/rooms', () => of({ kind: 'not-required' })),
    ).resolves.toBe(true);
  });

  it('lets the route through when the check cannot be read', async () => {
    await expect(
      run('/rooms', () => throwError(() => new Error('unavailable'))),
    ).resolves.toBe(true);
  });

  it('lets the route through when a fresh read of the account needs nothing, as just after a switch', async () => {
    const confirmRequired = vi.fn(() => of(false));

    await expect(
      run(
        '/rooms',
        () => of({ kind: 'required', status: 'needs-recovery' }),
        confirmRequired,
      ),
    ).resolves.toBe(true);
    expect(confirmRequired).toHaveBeenCalledOnce();
  });

  it('lets the route through when the fresh read never answers', async () => {
    // RxJS timers run on `setInterval`, so fake it along with `setTimeout`.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    let settled: boolean | UrlTree | undefined;
    void run(
      '/rooms',
      () => of({ kind: 'required', status: 'needs-recovery' }),
      () => NEVER,
    ).then((result) => {
      settled = result;
    });

    await vi.advanceTimersByTimeAsync(DEVICE_CONFIRMATION_SETTLE_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('loads the active Account’s banner forecast before letting Rooms through', async () => {
    const read = new Subject<void>();
    const hydrateActive = vi.fn(() => read.asObservable());
    let settled: boolean | UrlTree | undefined;
    void run(
      '/rooms',
      () => of({ kind: 'not-required' }),
      undefined,
      hydrateActive,
    ).then((result) => {
      settled = result;
    });

    await Promise.resolve();
    expect(hydrateActive).toHaveBeenCalledOnce();
    expect(settled).toBeUndefined();

    read.next();
    read.complete();
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('does not wait more than 300 ms for the forecast', async () => {
    // RxJS timers run on `setInterval`, so fake it along with `setTimeout`.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    expect(FORECAST_HYDRATE_MS).toBe(300);
    let settled: boolean | UrlTree | undefined;
    void run(
      '/rooms',
      () => of({ kind: 'not-required' }),
      undefined,
      () => NEVER,
    ).then((result) => {
      settled = result;
    });

    await vi.advanceTimersByTimeAsync(FORECAST_HYDRATE_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });
});
