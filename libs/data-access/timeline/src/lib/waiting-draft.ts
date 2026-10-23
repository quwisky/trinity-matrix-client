import { EventStatus, MatrixEventEvent, type MatrixEvent } from 'matrix-js-sdk';
import { isWaitingToSend } from '@trinity/util/matrix';
import type { DraftStoreService } from '@trinity/platform-native';

/** The echo is on the server (`null` once its remote echo arrived) or gone for good. */
const SETTLED: ReadonlySet<EventStatus | null> = new Set([
  EventStatus.SENT,
  null,
  EventStatus.CANCELLED,
]);

/**
 * When `echo` failed only because it was offline, keep `body` in the saved drafts until the echo
 * is sent or cancelled, and say so. A resend the server refuses keeps it too: the row is then a
 * manual failure whose text the composer no longer holds. A reload drops the echo, and the draft
 * store then gives the text back to the composer under `draftKey`.
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
    if (!SETTLED.has(echo.status)) return;
    echo.off(MatrixEventEvent.Status, onStatus);
    drafts.releaseWaiting(draftKey, txnId);
  };
  echo.on(MatrixEventEvent.Status, onStatus);
  return true;
}
