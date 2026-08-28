import { DestroyRef, signal } from '@angular/core';
import { EMPTY, NEVER, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { runWithBusy } from './with-busy';

function state() {
  const destroyCallbacks: Array<() => void> = [];
  return {
    busy: signal(false),
    error: signal<string | null>('old error'),
    destroyRef: {
      onDestroy: vi.fn((callback: () => void) => {
        destroyCallbacks.push(callback);
        return () => {
          const index = destroyCallbacks.indexOf(callback);
          if (index !== -1) destroyCallbacks.splice(index, 1);
        };
      }),
    } as unknown as DestroyRef,
    destroy: () => destroyCallbacks.splice(0).forEach((callback) => callback()),
  };
}

describe('runWithBusy', () => {
  it('does not change state until subscribed and clears busy on empty completion', () => {
    const current = state();
    const request = runWithBusy(EMPTY, current);

    expect(current.busy()).toBe(false);
    expect(current.error()).toBe('old error');

    request.subscribe();

    expect(current.busy()).toBe(false);
    expect(current.error()).toBeNull();
  });

  it('clears busy when the subscriber cancels', () => {
    const current = state();
    const subscription = runWithBusy(NEVER, current).subscribe();

    expect(current.busy()).toBe(true);

    subscription.unsubscribe();

    expect(current.busy()).toBe(false);
  });

  it('unsubscribes and clears busy when its owner is destroyed', () => {
    const current = state();
    const subscription = runWithBusy(NEVER, current).subscribe();

    expect(current.busy()).toBe(true);

    current.destroy();

    expect(subscription.closed).toBe(true);
    expect(current.busy()).toBe(false);
  });

  it('supports operation-specific messages and sanitized reporting hooks', () => {
    const presentError = vi.fn();
    const current = { ...state(), presentError };
    const failure = new Error('raw server detail');
    const reportError = vi.fn();

    runWithBusy(
      throwError(() => failure),
      current,
      {
        formatError: () => 'Check your connection and try again.',
        reportError,
      },
    ).subscribe();

    expect(current.error()).toBe('Check your connection and try again.');
    expect(presentError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(current.busy()).toBe(false);
  });

  it('still finalizes when an error presenter itself fails', () => {
    const current = {
      ...state(),
      presentError: () => {
        throw new Error('presenter unavailable');
      },
    };

    expect(() =>
      runWithBusy(
        throwError(() => new Error('request failed')),
        current,
      ).subscribe(),
    ).not.toThrow();
    expect(current.error()).toBe('request failed');
    expect(current.busy()).toBe(false);
  });
});
