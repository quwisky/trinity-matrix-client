import { TestBed } from '@angular/core/testing';
import { toast } from '@spartan-ng/brain/sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnToastService } from './trn-toast.service';

// TrnToastService is a thin adapter over brain sonner's imperative toast(). Mock the
// same module the service imports from (@spartan-ng/brain/sonner, NOT ngx-sonner — see
// the service header); trn-toast-render.spec.ts covers the real producer→toaster wiring.
vi.mock('@spartan-ng/brain/sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

describe('TrnToastService', () => {
  let svc: TrnToastService;

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('routes a destructive variant to toast.error', () => {
    svc.show('Failed', { variant: 'destructive', duration: 5000 });
    expect(toast.error).toHaveBeenCalledWith('Failed', { duration: 5000 });
  });

  it('maps duration 0 (keep until dismissed) to Infinity', () => {
    svc.show('Persistent', { duration: 0 });
    expect(toast).toHaveBeenCalledWith('Persistent', {
      duration: Number.POSITIVE_INFINITY,
    });
  });
});
