/** A single owned Chrome DevTools Protocol connection. */
export interface DevtoolsConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(reason?: Error): void;
}

export interface DevtoolsConnectionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error
    ? reason
    : new Error(fallback, { cause: reason });
}

/**
 * Connect to a CDP websocket without leaving requests pending when a host dies.
 * Node 24's global WebSocket is deliberately used so this helper has no second
 * websocket implementation or browser dependency.
 */
export async function openDevtoolsConnection(
  url: string,
  { signal, timeoutMs = 5_000 }: DevtoolsConnectionOptions = {},
): Promise<DevtoolsConnection> {
  if (signal?.aborted) {
    throw asError(signal.reason, 'DevTools connection cancelled before start');
  }
  const socket = new WebSocket(url);
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let closed = false;
  let opened = false;

  const rejectPending = (reason: unknown): void => {
    const error = asError(reason, 'DevTools connection closed');
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const onAbort = (): void =>
    close(asError(signal?.reason, 'DevTools connection cancelled'));
  const close = (reason = new Error('DevTools connection closed')): void => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    rejectPending(reason);
    socket.close();
  };

  socket.addEventListener('message', (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || !('id' in message)) return;
    const id = (message as { id?: unknown }).id;
    if (typeof id !== 'number') return;
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    const record = message as {
      error?: { message?: string };
      result?: unknown;
    };
    if (record.error) {
      request.reject(
        new Error(record.error.message ?? 'DevTools command failed'),
      );
    } else {
      request.resolve(record.result);
    }
  });
  socket.addEventListener('close', () => {
    if (!closed) {
      closed = true;
      signal?.removeEventListener('abort', onAbort);
      rejectPending(new Error('DevTools websocket closed unexpectedly'));
    }
  });
  socket.addEventListener('error', () => {
    if (!opened) close(new Error('Could not open DevTools websocket'));
  });
  signal?.addEventListener('abort', onAbort, { once: true });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      close(new Error(`DevTools websocket did not open within ${timeoutMs}ms`));
      reject(
        new Error(`DevTools websocket did not open within ${timeoutMs}ms`),
      );
    }, timeoutMs);
    const onOpen = (): void => {
      clearTimeout(timer);
      opened = true;
      resolve();
    };
    const onClose = (): void => {
      clearTimeout(timer);
      reject(new Error('DevTools websocket closed before opening'));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('close', onClose, { once: true });
  }).catch((error: unknown) => {
    close(asError(error, 'Could not open DevTools websocket'));
    throw error;
  });

  return {
    send(method, params = {}): Promise<unknown> {
      if (closed)
        return Promise.reject(new Error('DevTools connection is closed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`DevTools command ${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close,
  };
}
