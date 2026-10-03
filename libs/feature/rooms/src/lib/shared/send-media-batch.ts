import {
  Observable,
  catchError,
  concatMap,
  filter,
  finalize,
  from,
  map,
  mergeMap,
  of,
  take,
  tap,
  throwError,
  toArray,
} from 'rxjs';
import {
  type MediaTransferEvent,
  type StagedMediaReference,
} from '@trinity/data-access/media';

/** One file in a batch, carrying the id the composer knows it by. */
export interface BatchItem {
  readonly id: string;
  readonly file: File;
  readonly media: StagedMediaReference;
}

/** What the composer shows while a batch is going out: "2 of 5", plus that file's fraction. */
export interface BatchProgress {
  /** 1-based position of the file currently uploading. */
  readonly index: number;
  readonly total: number;
  /** Upload fraction in [0, 1] for THIS file, not for the batch. */
  readonly fraction: number;
}

/** How one item finished. */
export interface BatchOutcome {
  readonly id: string;
  readonly failed: boolean;
}

/** Sends one file through either a Conversation or exact-thread media capability. */
export type SendOneMedia = (
  file: File,
  caption: string,
  progress: (fraction: number) => void,
  media: StagedMediaReference,
) => Observable<void>;

/**
 * Send a batch of files as N events, **strictly one at a time**.
 *
 * `concatMap`, and the sequencing is the substance rather than a style choice:
 *
 * - **Order.** The SDK orders `sendMessage` *calls* three ways over, but the call only happens
 *   after that file's own upload resolves — so N concurrent uploads send fastest-file-first and
 *   the SDK faithfully preserves the wrong order. Sequencing the upload→send pairs is the only
 *   thing that makes "in the order staged" true.
 * - **A failure cannot take siblings with it.** The SDK's scheduler rejects *every* queued event
 *   in a room's queue when one hard-fails, not just the failing one. Depth 1 sidesteps that.
 * - **Memory.** Encrypting holds the plaintext, the ciphertext and a Blob of the same bytes at
 *   once; sequential caps that at one file rather than the whole batch.
 * - **Timeouts.** The SDK aborts an upload that makes no progress for 30s, which parallel
 *   uploads on a starved connection invite.
 *
 * One item failing does not stop the rest: its outcome is recorded and the batch continues, so
 * a batch of five with a bad third delivers four and leaves one to retry.
 */
export function sendMediaBatch(
  items: readonly BatchItem[],
  caption: string,
  send: SendOneMedia,
  onProgress: (progress: BatchProgress | null) => void,
): Observable<readonly BatchOutcome[]> {
  // No `defer` wrapper: `from(array)` is already cold and every side effect below lives inside
  // `concatMap`'s projection, so nothing runs until someone subscribes.
  return from(items).pipe(
    concatMap((item, position) => {
      const index = position + 1;
      onProgress({ index, total: items.length, fraction: 0 });
      // The caption rides the media event only when there is exactly one file; a batch
      // sends it as its own message afterwards, which is the caller's job.
      return send(
        item.file,
        items.length === 1 ? caption : '',
        (fraction) => onProgress({ index, total: items.length, fraction }),
        item.media,
      ).pipe(
        map(() => ({ id: item.id, failed: false })),
        // Per item, so one failure is recorded and the rest still go. The same shape
        // `save-fields.ts` uses, with `concatMap` in place of its `forkJoin`.
        catchError(() => of({ id: item.id, failed: true })),
      );
    }),
    toArray(),
    finalize(() => onProgress(null)),
  );
}

/**
 * Drive one capability `media.send(...)` stream to a single outcome: progress events feed
 * `progress`, the first terminal event ends it, and anything but `sent` becomes an error.
 * `onFailure` sees the failure code first, so a host can count it as abandoned.
 */
export function sendViaCapability(
  events: Observable<MediaTransferEvent>,
  progress?: (fraction: number) => void,
  onFailure?: (failure: string) => void,
): Observable<void> {
  return events.pipe(
    tap((event) => {
      if (event.kind === 'progress') progress?.(event.fraction);
    }),
    filter((event) => event.kind !== 'progress'),
    take(1),
    mergeMap((event) => {
      if (event.kind === 'sent') return of(void 0);
      onFailure?.(event.failure);
      return throwError(() => new Error(event.failure));
    }),
  );
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The toast for a batch with failures. Two fates are counted apart: the composer drops its
 * staging on leaving `place`, so "still in the composer" is true for a failed upload and false
 * for one abandoned by leaving.
 */
export function batchFailureToast(
  failed: number,
  abandoned: number,
  place: 'room' | 'thread',
): string {
  const upload = failed - abandoned;
  const left = `you left the ${place} before they went out`;
  return abandoned && upload
    ? `${abandoned} ${plural(abandoned, 'attachment', 'attachments')} not sent — ${left} — and ${upload} could not be uploaded.`
    : abandoned
      ? `${abandoned} ${plural(abandoned, 'attachment was', 'attachments were')} not sent — ${left}.`
      : upload === 1
        ? 'One attachment could not be sent. It is still in the composer.'
        : `${upload} attachments could not be sent. They are still in the composer.`;
}
