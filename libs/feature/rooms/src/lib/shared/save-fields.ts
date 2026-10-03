import type { DestroyRef } from '@angular/core';
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
 * Every field in a settings dialog is its own state event, so a partial failure is a normal
 * outcome rather than an edge case — the name can land while the topic is rejected. Each write
 * therefore carries its own `catchError`, so one rejection cannot cancel the siblings the way a
 * bare `forkJoin` would, and the caller gets both lists instead of a single boolean it would have
 * to translate into "nothing saved".
 *
 * Emits exactly once, including for an empty list. Callers own the messaging: the wording differs per surface ("room settings" vs
 * "space settings"), which is exactly why that stays out here.
 */
export function saveFields(
  writes: readonly FieldWrite[],
): Observable<FieldWriteResult> {
  // `forkJoin([])` completes without ever emitting, which would leave a caller's `saving`
  // flag stuck on and its dialog showing "Saving…" forever. "Nothing to write" is a real
  // result, not the absence of one.
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

export interface RunSaveOptions {
  writes: readonly FieldWrite[];
  /** Fields the user changed but may not write; they stay unsaved. */
  blocked: readonly string[];
  /** Subject used when no field name is available, e.g. `'Room details'`. */
  emptyLabel: string;
  destroyRef: DestroyRef;
  toast: TrnToastService;
  setSaving: (saving: boolean) => void;
  setFeedback: (feedback: SettingsFeedback | null) => void;
  commit: (saved: ReadonlySet<string>) => void;
}

/** Run a settings section's writes and publish the outcome as feedback (and a toast on failure). */
export function runSave(o: RunSaveOptions): void {
  if (o.writes.length === 0) {
    o.setFeedback({
      tone: 'danger',
      message: `${sentenceList(o.blocked, o.emptyLabel)} could not be saved with your current permissions. Your edits are still here.`,
    });
    return;
  }
  o.setSaving(true);
  o.setFeedback(null);
  saveFields(o.writes)
    .pipe(takeUntilDestroyed(o.destroyRef))
    .subscribe(({ saved, failed }) => {
      o.setSaving(false);
      o.commit(new Set(saved));
      const remaining = [...failed, ...o.blocked];
      if (remaining.length === 0) {
        o.setFeedback({
          tone: 'success',
          message: `${sentenceList(saved, o.emptyLabel)} saved.`,
        });
        return;
      }
      const message = saved.length
        ? unsavedRemainderMessage(saved, remaining)
        : `${sentenceList(remaining, o.emptyLabel)} could not be saved. Your edits are still here.`;
      o.setFeedback({ tone: 'danger', message });
      o.toast.show(message, { duration: 5000, variant: 'danger' });
    });
}

/** Feedback line of a per-user preference form, which also has a pending state. */
export interface PreferenceFeedback {
  readonly tone: 'pending' | 'success' | 'danger';
  readonly message: string;
}

export type PreferenceLoadState =
  'idle' | 'loading' | 'ready' | 'unavailable' | 'failed';
