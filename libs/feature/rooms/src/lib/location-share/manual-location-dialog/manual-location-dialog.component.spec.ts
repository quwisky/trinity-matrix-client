import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { GeolocationService } from '@trinity/platform-native';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import { ManualLocationDialogComponent } from './manual-location-dialog.component';

async function setup(
  over: {
    supportsApproximate?: boolean;
    approximate?: Mock;
  } = {},
) {
  const close = vi.fn();
  const toastShow = vi.fn();
  const approximate =
    over.approximate ?? vi.fn(() => of({ lat: 1.5, lng: 2.5 }));
  const { fixture } = await render(ManualLocationDialogComponent, {
    providers: [
      { provide: DialogRef, useValue: { close } },
      MockProvider(GeolocationService, {
        supportsApproximate: () => over.supportsApproximate ?? false,
        approximateFromDesktop: approximate,
      }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return { cmp: fixture.componentInstance, close, toastShow, approximate };
}

describe('ManualLocationDialogComponent', () => {
  it('parses coordinates from the typed value', async () => {
    const { cmp } = await setup();
    expect(cmp.coords()).toBeNull();

    cmp.value.set('48.8584, 2.2945');
    expect(cmp.coords()).toEqual({ lat: 48.8584, lng: 2.2945 });
  });

  it('closes with the parsed point on share', async () => {
    const { cmp, close } = await setup();
    cmp.value.set('https://www.google.com/maps/@40.7128,-74.006,15z');

    cmp.share();

    expect(close).toHaveBeenCalledWith({ lat: 40.7128, lng: -74.006 });
  });

  it('does not close when the value is not a location', async () => {
    const { cmp, close } = await setup();
    cmp.value.set('nowhere');

    cmp.share();

    expect(close).not.toHaveBeenCalled();
  });

  it('cancels with null', async () => {
    const { cmp, close } = await setup();
    cmp.cancel();
    expect(close).toHaveBeenCalledWith(null);
  });

  it('hides the approximate-location affordance without shell support', async () => {
    const { cmp } = await setup({ supportsApproximate: false });
    expect(cmp.canLocate).toBe(false);
  });

  it('offers the approximate-location affordance when the shell supports it', async () => {
    const { cmp } = await setup({ supportsApproximate: true });
    expect(cmp.canLocate).toBe(true);
  });

  it('ignores a second approximate request while one is in flight', async () => {
    const approx$ = new Subject<{ lat: number; lng: number }>();
    const approximate = vi.fn(() => approx$);
    const { cmp } = await setup({ supportsApproximate: true, approximate });

    cmp.useApproximate();
    expect(cmp.locating()).toBe(true);

    cmp.useApproximate(); // re-entrancy guard — no second lookup
    expect(approximate).toHaveBeenCalledTimes(1);

    approx$.next({ lat: 1, lng: 2 });
    approx$.complete();
    expect(cmp.locating()).toBe(false);
  });

  it('fills the field from an approximate estimate', async () => {
    const { cmp } = await setup({
      supportsApproximate: true,
      approximate: vi.fn(() => of({ lat: 51.5, lng: -0.12 })),
    });

    cmp.useApproximate();

    expect(cmp.value()).toBe('51.5, -0.12');
    expect(cmp.coords()).toEqual({ lat: 51.5, lng: -0.12 });
    expect(cmp.locating()).toBe(false);
  });

  it('toasts and clears the busy state when the estimate fails', async () => {
    const { cmp, toastShow } = await setup({
      supportsApproximate: true,
      approximate: vi.fn(() => throwError(() => new Error('offline'))),
    });

    cmp.useApproximate();

    expect(cmp.locating()).toBe(false);
    expect(toastShow).toHaveBeenCalledWith(
      'offline',
      expect.objectContaining({ variant: 'destructive' }),
    );
  });
});
