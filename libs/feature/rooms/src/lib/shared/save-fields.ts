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
