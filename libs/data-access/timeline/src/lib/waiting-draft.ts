import { EventStatus, MatrixEventEvent, type MatrixEvent } from 'matrix-js-sdk';
import { isWaitingToSend } from '@trinity/util/matrix';
import type { DraftStoreService } from '@trinity/platform-native';

/** A resend in progress: the echo may still fail offline and wait again. */
const RESENDING: ReadonlySet<EventStatus | null> = new Set([
  EventStatus.QUEUED,
  EventStatus.ENCRYPTING,
  EventStatus.SENDING,
]);

/**
 * When `echo` failed only because it was offline, keep `body` in the saved drafts until the echo
 * is sent, cancelled or refused, and say so. A reload drops the echo, and the draft store then
 * gives the text back to the composer under `draftKey`.
 */
export function keepWhileWaiting(
  drafts: Pick<DraftStoreService, 'holdWaiting' | 'releaseWaiting'>,
  draftKey: string,
  echo: MatrixEvent | undefined,
  body: string,
): boolean {
  const txnId = echo?.getTxnId();
  if (!echo || !txnId || !isWaitingToSend(echo)) return false;
  drafts.holdWaiting(draftKey, txnId, body);
  const onStatus = (): void => {
    if (RESENDING.has(echo.status) || isWaitingToSend(echo)) return;
    echo.off(MatrixEventEvent.Status, onStatus);
    drafts.releaseWaiting(draftKey, txnId);
  };
  echo.on(MatrixEventEvent.Status, onStatus);
  return true;
}
