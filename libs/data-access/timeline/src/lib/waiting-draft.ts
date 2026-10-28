import { type Observable, Subscription } from 'rxjs';
import type { DraftStoreService } from '@trinity/platform-native';
import type { SendState } from './timeline-engine';

/**
 * When `echo` failed only because it was offline, keep `body` in the saved drafts until the echo
 * is sent or cancelled, and say so. A resend the server refuses keeps it too: the row is then a
 * manual failure whose text the composer no longer holds. A reload drops the echo, and the draft
 * store then gives the text back to the composer under `draftKey`.
 *
 * `states` emits the echo's current state on subscribe, `null` once it is sent, and completes
 * when the echo leaves the timeline, as {@link TimelineStore.sendStates} does. Leaving is no
 * proof the text is safe (a timeline reset or a restarted client drops an unsent echo), so the
 * text stays held: whoever cancels the echo releases it.
 */
export function keepWhileWaiting(
  drafts: Pick<DraftStoreService, 'holdWaiting' | 'releaseWaiting'>,
  draftKey: string,
  body: string,
  echo: {
    readonly transactionId: string;
    readonly states: Observable<SendState | null>;
  },
): boolean {
  const { transactionId } = echo;
  let held = false;
  let done = false;
  const watch = new Subscription();
  const stop = (): void => {
    done = true;
    watch.unsubscribe();
  };
  const release = (): void => {
    if (done) return;
    stop();
    if (held) drafts.releaseWaiting(draftKey, transactionId);
  };
  watch.add(
    echo.states.subscribe({
      next: (state) => {
        if (held) {
          if (state === null) release();
          return;
        }
        // Only the state at the time of the call decides.
        if (done || state?.kind !== 'waiting') return stop();
        held = true;
        drafts.holdWaiting(draftKey, transactionId, body);
      },
      complete: stop,
    }),
  );
  if (!held) stop();
  return held;
}
