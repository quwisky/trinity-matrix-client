import { Observable, defer, firstValueFrom, of, throwError } from 'rxjs';
import { signal, type DestroyRef } from '@angular/core';
import { type TrnToastService } from '@trinity/components/overlay';
import { describe, expect, it, vi } from 'vitest';
import { saveFields, sectionSaver, type SettingsFeedback } from './save-fields';

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

describe('sectionSaver', () => {
  function setup() {
    const saving = signal<'general' | 'access' | null>(null);
    const feedback = {
      general: signal<SettingsFeedback | null>(null),
      access: signal<SettingsFeedback | null>(null),
    };
    const toast = { show: vi.fn() };
    const save = sectionSaver({
      emptyLabel: 'Space details',
      destroyRef: { onDestroy: () => () => undefined } as unknown as DestroyRef,
      toast: toast as unknown as TrnToastService,
      saving,
      feedback,
    });
    return { save, saving, feedback, toast };
  }

  it('says nothing could be saved when every change is blocked', () => {
    const { save, saving, feedback } = setup();

    save('access', [], ['join rule'], vi.fn());

    expect(feedback.access()?.message).toBe(
      'Join rule could not be saved with your current permissions. Your edits are still here.',
    );
    expect(saving()).toBeNull();
  });

  it('commits what landed and reports success on the given section', () => {
    const { save, saving, feedback, toast } = setup();
    const commit = vi.fn();

    save('general', [{ field: 'name', op: of(undefined) }], [], commit);

    expect(commit).toHaveBeenCalledWith(new Set(['name']));
    expect(feedback.general()).toEqual({
      tone: 'success',
      message: 'Name saved.',
    });
    expect(feedback.access()).toBeNull();
    expect(saving()).toBeNull();
    expect(toast.show).not.toHaveBeenCalled();
  });

  it('keeps a failed write unsaved and toasts the remainder', () => {
    const { save, feedback, toast } = setup();
    const commit = vi.fn();

    save(
      'general',
      [
        { field: 'name', op: of(undefined) },
        { field: 'topic', op: throwError(() => new Error('no')) },
      ],
      [],
      commit,
    );

    expect(commit).toHaveBeenCalledWith(new Set(['name']));
    expect(feedback.general()?.tone).toBe('danger');
    expect(feedback.general()?.message).toContain('Topic is still unsaved');
    expect(toast.show).toHaveBeenCalledOnce();
  });
});
