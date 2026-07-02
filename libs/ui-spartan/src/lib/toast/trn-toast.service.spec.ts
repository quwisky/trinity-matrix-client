import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnToastService } from './trn-toast.service';

describe('TrnToastService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows a toast, mounts the overlay, and auto-dismisses after the duration', () => {
    const svc = TestBed.inject(TrnToastService);
    svc.show('Saved', { duration: 1000, variant: 'success' });

    expect(svc.toasts().length).toBe(1);
    expect(svc.toasts()[0]).toMatchObject({
      message: 'Saved',
      variant: 'success',
    });
    // The CDK overlay container is mounted into the DOM.
    expect(document.querySelector('.cdk-overlay-container')).not.toBeNull();

    vi.advanceTimersByTime(1000);
    expect(svc.toasts().length).toBe(0);
  });

  it('keeps a duration:0 toast until dismissed', () => {
    const svc = TestBed.inject(TrnToastService);
    svc.show('Persistent', { duration: 0 });
    vi.advanceTimersByTime(10_000);
    expect(svc.toasts().length).toBe(1);

    svc.dismiss(svc.toasts()[0].id);
    expect(svc.toasts().length).toBe(0);
  });

  it('stacks multiple toasts in order', () => {
    const svc = TestBed.inject(TrnToastService);
    svc.show('one', { duration: 0 });
    svc.show('two', { duration: 0 });
    expect(svc.toasts().map((t) => t.message)).toEqual(['one', 'two']);
  });
});
