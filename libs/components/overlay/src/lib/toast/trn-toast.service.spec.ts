import { TestBed } from '@angular/core/testing';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { toast } from '@spartan-ng/brain/sonner';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnToastService } from './trn-toast.service';

// TrnToastService is a thin adapter over brain sonner's imperative toast(). Mock the
// same module the service imports from (@spartan-ng/brain/sonner, NOT ngx-sonner — see
// the service header); trn-toast-render.spec.ts covers the real producer→toaster wiring.
vi.mock('@spartan-ng/brain/sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('TrnToastService', () => {
  let svc: TrnToastService;
  const announce = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [MockProvider(LiveAnnouncer, { announce })],
    });
    svc = TestBed.inject(TrnToastService);
  });

  it('shows a plain toast with the given message and duration', () => {
    svc.show('Hi', { duration: 1000 });
    expect(toast).toHaveBeenCalledWith('Hi', { duration: 1000 });
  });

  it('defaults to a 3000ms plain toast', () => {
    svc.show('plain');
    expect(toast).toHaveBeenCalledWith('plain', { duration: 3000 });
  });

  it('routes a success variant to toast.success', () => {
    svc.show('Saved', { variant: 'success' });
    expect(toast.success).toHaveBeenCalledWith('Saved', { duration: 3000 });
    expect(toast).not.toHaveBeenCalled();
  });

  it('routes canonical danger and warning variants', () => {
    svc.show('Failed', { variant: 'danger', duration: 5000 });
    expect(toast.error).toHaveBeenCalledWith('Failed', { duration: 5000 });

    svc.show('Check this', { variant: 'warning' });
    expect(toast.warning).toHaveBeenCalledWith('Check this', {
      duration: 3000,
    });
  });

  it('maps duration 0 (keep until dismissed) to Infinity', () => {
    svc.show('Persistent', { duration: 0 });
    expect(toast).toHaveBeenCalledWith('Persistent', {
      duration: Number.POSITIVE_INFINITY,
    });
  });

  it('omits the action key entirely when none was passed', () => {
    svc.show('Plain', { duration: 1000 });
    // Asserted as an exact literal on purpose: sonner treats the presence of the key
    // as "render a button", so an `action: undefined` would be a different toast.
    expect(toast).toHaveBeenCalledWith('Plain', { duration: 1000 });
  });

  it('forwards an action on every variant, not just the default one', () => {
    // The variants take separate sonner entry points, so a spread that only reached
    // `toast()` would leave a success or error toast quietly button-less.
    const onClick = vi.fn();
    const withAction = { label: 'Undo', onClick };

    svc.show('Plain', { action: withAction });
    svc.show('Saved', { variant: 'success', action: withAction });
    svc.show('Check this', { variant: 'warning', action: withAction });
    svc.show('Failed', { variant: 'danger', action: withAction });

    for (const spy of [toast, toast.success, toast.warning, toast.error]) {
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Undo' }),
        }),
      );
    }
  });

  it('runs the caller handler when sonner invokes the button', () => {
    // sonner hands its own MouseEvent to onClick; ours takes none. The wrapper has to
    // absorb that, and calling through is the only thing that proves it does.
    const onClick = vi.fn();
    svc.show('Plain', { action: { label: 'Undo', onClick } });

    const forwarded = vi.mocked(toast).mock.calls[0][1] as {
      action: { onClick: (event: MouseEvent) => void };
    };
    forwarded.action.onClick(new MouseEvent('click'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('announces a dialog-time error outside the aria-hidden app root', () => {
    const root = document.createElement('trn-root');
    root.setAttribute('aria-hidden', 'true');
    document.body.append(root);

    try {
      svc.show('Could not open Encryption. Please try again.', {
        variant: 'danger',
      });

      expect(announce).toHaveBeenCalledWith(
        'Could not open Encryption. Please try again.',
        'assertive',
      );
    } finally {
      root.remove();
    }
  });

  it('lets Sonner announce normally when the app root is not hidden', () => {
    svc.show('Saved', { variant: 'success' });

    expect(announce).not.toHaveBeenCalled();
  });
});
