import type { DestroyRef, WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { TrnToastService } from '@trinity/components/overlay';
import { Observable, catchError, forkJoin, map, of } from 'rxjs';

/** One field's write, named so a failure can say which field it was. */
export interface FieldWrite {
  /** How the field is named to the user in a failure message, e.g. `'join rule'`. */
  field: string;
  op: Observable<void>;
}

/** Which fields survived the round trip and which didn't. */
export interface FieldWriteResult {
  saved: string[];
  failed: string[];
}

/**
 * Run each field's write independently and report the real outcome.
 *
 * Every field in a settings dialog is its own state event, so partial failure is normal (the name
 * can land while the topic is rejected). Each write carries its own `catchError`, so one rejection
 * cannot cancel siblings as a bare `forkJoin` would, and the caller gets both lists. Emits exactly
 * once, including for an empty list. Callers own the messaging, since wording differs per surface.
 */
export function saveFields(
  writes: readonly FieldWrite[],
): Observable<FieldWriteResult> {
  // `forkJoin([])` completes without emitting, which would leave a caller's `saving` flag stuck on.
  // "Nothing to write" is a real result.
  if (writes.length === 0) {
    return of({ saved: [], failed: [] });
  }
  return forkJoin(
    writes.map(({ field, op }) =>
      op.pipe(
        map(() => ({ field, ok: true })),
        catchError(() => of({ field, ok: false })),
      ),
    ),
  ).pipe(
    map((results) => ({
      saved: results.filter((r) => r.ok).map((r) => r.field),
      failed: results.filter((r) => !r.ok).map((r) => r.field),
    })),
  );
}

/** Outcome line shown beside a settings section: the saved result or why it was not. */
export interface SettingsFeedback {
  readonly tone: 'success' | 'danger';
  readonly message: string;
}

/** Capitalised "a, b and c"; `whenEmpty` names the subject when nothing is listed. */
export function sentenceList(
  fields: readonly string[],
  whenEmpty: string,
): string {
  if (fields.length === 0) return whenEmpty;
  const sentence = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    fields,
  );
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The partial-failure line: what landed and what a retry will still write. */
export function unsavedRemainderMessage(
  saved: readonly string[],
  remaining: readonly string[],
): string {
  return `${sentenceList(saved, '')} saved. ${sentenceList(remaining, '')} ${remaining.length === 1 ? 'is' : 'are'} still unsaved; retry saves only what remains.`;
}

export interface SectionSaverOptions {
  /** Subject used when no field name is available, e.g. `'Room details'`. */
  emptyLabel: string;
  destroyRef: DestroyRef;
  toast: TrnToastService;
  /** Which section is saving right now, if any. */
  saving: WritableSignal<'general' | 'access' | null>;
  feedback: Record<
    'general' | 'access',
    WritableSignal<SettingsFeedback | null>
  >;
}

/**
 * Build a settings draft's section saver. It runs a section's writes and publishes the outcome as
 * that section's feedback (plus a toast on failure). `blocked` names fields the user changed but
 * may not write; they stay unsaved.
 */
export function sectionSaver(o: SectionSaverOptions) {
  return (
    section: 'general' | 'access',
    writes: readonly FieldWrite[],
    blocked: readonly string[],
    commit: (saved: ReadonlySet<string>) => void,
  ): void => {
    const setFeedback = o.feedback[section].set.bind(o.feedback[section]);
    if (writes.length === 0) {
      setFeedback({
        tone: 'danger',
        message: `${sentenceList(blocked, o.emptyLabel)} could not be saved with your current permissions. Your edits are still here.`,
      });
      return;
    }
    o.saving.set(section);
    setFeedback(null);
    saveFields(writes)
      .pipe(takeUntilDestroyed(o.destroyRef))
      .subscribe(({ saved, failed }) => {
        o.saving.set(null);
        commit(new Set(saved));
        const remaining = [...failed, ...blocked];
        if (remaining.length === 0) {
          setFeedback({
            tone: 'success',
            message: `${sentenceList(saved, o.emptyLabel)} saved.`,
          });
          return;
        }
        const message = saved.length
          ? unsavedRemainderMessage(saved, remaining)
          : `${sentenceList(remaining, o.emptyLabel)} could not be saved. Your edits are still here.`;
        setFeedback({ tone: 'danger', message });
        o.toast.show(message, { duration: 5000, variant: 'danger' });
      });
  };
}

/** Feedback line of a per-user preference form, which also has a pending state. */
export interface PreferenceFeedback {
  readonly tone: 'pending' | 'success' | 'danger';
  readonly message: string;
}

export type PreferenceLoadState =
  'idle' | 'loading' | 'ready' | 'unavailable' | 'failed';
