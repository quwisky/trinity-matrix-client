import { Observable, defer, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { saveFields } from './save-fields';

/**
 * A write that records WHEN it is subscribed, not when it is constructed. Every op here is
 * an already-built Observable, so a plain `vi.fn()` call in the argument list would have
 * run before `saveFields` was ever reached and could not fail.
 */
function trackedWrite(onSubscribe: () => void): Observable<void> {
  return defer(() => {
    onSubscribe();
    return of(undefined as void);
  });
}

describe('saveFields', () => {
  it('reports every field as saved when all writes succeed', async () => {
    const result = await firstValueFrom(
      saveFields([
        { field: 'name', op: of(undefined) },
        { field: 'topic', op: of(undefined) },
      ]),
    );

    expect(result).toEqual({ saved: ['name', 'topic'], failed: [] });
  });

  it('names both halves of a partial failure', async () => {
    // Each field is its own state event, so a partial failure is a normal outcome the
    // caller has to be able to describe — not a single boolean it must translate.
    const result = await firstValueFrom(
      saveFields([
        { field: 'name', op: of(undefined) },
        { field: 'topic', op: throwError(() => new Error('forbidden')) },
      ]),
    );

    expect(result).toEqual({ saved: ['name'], failed: ['topic'] });
  });

  it('does not let one rejection cancel its siblings', async () => {
    // The whole reason each write carries its own catchError: a bare forkJoin would
    // unsubscribe the rest on the first error, so a later field would never be attempted.
    const laterSubscribed = vi.fn();
    const result = await firstValueFrom(
      saveFields([
        { field: 'name', op: throwError(() => new Error('nope')) },
        { field: 'topic', op: trackedWrite(laterSubscribed) },
      ]),
    );

    expect(laterSubscribed).toHaveBeenCalled();
    expect(result).toEqual({ saved: ['topic'], failed: ['name'] });
  });

  it('emits an empty result rather than never emitting at all', async () => {
    // forkJoin([]) completes without emitting, which would leave a caller's `saving` flag
    // stuck on and its dialog showing "Saving…" with no toast and no way out.
    const result = await firstValueFrom(saveFields([]));

    expect(result).toEqual({ saved: [], failed: [] });
  });

  it('is cold — no write runs until it is subscribed', async () => {
    const subscribed = vi.fn();
    const action = saveFields([
      { field: 'name', op: trackedWrite(subscribed) },
    ]);

    expect(subscribed).not.toHaveBeenCalled();

    await firstValueFrom(action);
    expect(subscribed).toHaveBeenCalled();
  });
});
