import { EventStatus, MatrixEventEvent, type MatrixEvent } from 'matrix-js-sdk';
import { isWaitingToSend } from '@trinity/util/matrix';
import type {
  DraftStoreService,
  PendingMessage,
} from '@trinity/platform-native';

type HoldStore = Pick<DraftStoreService, 'holdWaiting' | 'releaseWaiting'>;

/** The echo is on the server (`null` once its remote echo arrived) or gone for good. */
const SETTLED: ReadonlySet<EventStatus | null> = new Set([
  EventStatus.SENT,
  null,
  EventStatus.CANCELLED,
]);

/**
 * Keep `held` in the saved drafts under the echo's txn id until the echo is on the server or
 * cancelled. A failed echo stays held, so a reload, which drops the echo, can show it again.
 */
export function holdUntilSettled(
  drafts: HoldStore,
  draftKey: string,
  echo: MatrixEvent,
  held: string | PendingMessage,
): void {
  const txnId = echo.getTxnId();
  if (!txnId) return;
  drafts.holdWaiting(draftKey, txnId, held);
  const onStatus = (): void => {
    if (!SETTLED.has(echo.status)) return;
    echo.off(MatrixEventEvent.Status, onStatus);
    drafts.releaseWaiting(draftKey, txnId);
  };
  echo.on(MatrixEventEvent.Status, onStatus);
  onStatus();
}

/**
 * When `echo` failed only because it was offline, keep `held` in the saved drafts until the echo
 * is sent or cancelled, and say so. A resend the server refuses keeps it too: the row is then a
 * manual failure.
 */
export function keepWhileWaiting(
  drafts: HoldStore,
  draftKey: string,
  echo: MatrixEvent | undefined,
  held: string | PendingMessage,
): boolean {
  if (!echo?.getTxnId() || !isWaitingToSend(echo)) return false;
  holdUntilSettled(drafts, draftKey, echo, held);
  return true;
}
