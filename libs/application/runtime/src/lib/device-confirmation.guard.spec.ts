import { TestBed } from '@angular/core/testing';
import {
  Router,
  UrlTree,
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { MockProvider } from 'ng-mocks';
import { NEVER, firstValueFrom, of, throwError, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TrustDeviceConfirmationService,
  type DeviceConfirmationGate,
} from '@trinity/data-access/trust';
import { deviceConfirmationGuard } from './device-confirmation.guard';

function run(
  url: string,
  settledGate: () => Observable<DeviceConfirmationGate>,
  confirmRequired: () => Observable<boolean> = () => of(true),
): Promise<boolean | UrlTree> {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      MockProvider(TrustDeviceConfirmationService, {
        settledGate,
        confirmRequired,
      }),
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

afterEach(() => TestBed.resetTestingModule());

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
});
