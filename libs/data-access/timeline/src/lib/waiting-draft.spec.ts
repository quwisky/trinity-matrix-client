import { describe, expect, it, vi } from 'vitest';
import {
  ConnectionError,
  EventStatus,
  MatrixError,
  MatrixEvent,
} from 'matrix-js-sdk';
import { keepWhileWaiting } from './waiting-draft';

function offlineEcho(): MatrixEvent {
  const echo = new MatrixEvent({
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: 'hello' },
  });
  echo.setTxnId('txn-1');
  echo.error = new ConnectionError('offline') as never;
  echo.setStatus(EventStatus.NOT_SENT);
  return echo;
}

function drafts() {
  return { holdWaiting: vi.fn(), releaseWaiting: vi.fn() };
}

describe('keepWhileWaiting', () => {
  it('holds the text of an echo waiting to send under its transaction id', () => {
    const store = drafts();

    expect(keepWhileWaiting(store, 'key', offlineEcho(), 'hello')).toBe(true);

    expect(store.holdWaiting).toHaveBeenCalledWith('key', 'txn-1', 'hello');
  });

  it('holds nothing for an echo the server refused', () => {
    const store = drafts();
    const echo = offlineEcho();
    echo.error = new MatrixError({ errcode: 'M_FORBIDDEN' }, 403);
    echo.setStatus(EventStatus.NOT_SENT);

    expect(keepWhileWaiting(store, 'key', echo, 'hello')).toBe(false);
    expect(keepWhileWaiting(store, 'key', undefined, 'hello')).toBe(false);

    expect(store.holdWaiting).not.toHaveBeenCalled();
  });

  it('releases the text once the echo is sent, not while it is being resent', () => {
    const store = drafts();
    const echo = offlineEcho();
    keepWhileWaiting(store, 'key', echo, 'hello');

    echo.setStatus(EventStatus.SENDING);
    expect(store.releaseWaiting).not.toHaveBeenCalled();
    echo.setStatus(EventStatus.SENT);
    echo.setStatus(null);

    expect(store.releaseWaiting).toHaveBeenCalledOnce();
    expect(store.releaseWaiting).toHaveBeenCalledWith('key', 'txn-1');
  });

  it('releases the text once the echo is cancelled', () => {
    const store = drafts();
    const echo = offlineEcho();
    keepWhileWaiting(store, 'key', echo, 'hello');

    echo.setStatus(EventStatus.CANCELLED);

    expect(store.releaseWaiting).toHaveBeenCalledWith('key', 'txn-1');
  });

  it('keeps the text when the resend fails offline again, and releases it on a refusal', () => {
    const store = drafts();
    const echo = offlineEcho();
    keepWhileWaiting(store, 'key', echo, 'hello');

    echo.setStatus(EventStatus.SENDING);
    echo.error = new ConnectionError('offline again') as never;
    echo.setStatus(EventStatus.NOT_SENT);
    expect(store.releaseWaiting).not.toHaveBeenCalled();

    echo.setStatus(EventStatus.SENDING);
    echo.error = new MatrixError({ errcode: 'M_TOO_LARGE' }, 413);
    echo.setStatus(EventStatus.NOT_SENT);
    expect(store.releaseWaiting).toHaveBeenCalledWith('key', 'txn-1');
  });
});
