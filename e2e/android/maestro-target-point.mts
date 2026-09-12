import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface NativeTargetPoint {
  readonly x: number;
  readonly y: number;
}

export interface MaestroTargetPointEndpoint {
  readonly url: string;
  readonly lastPoint: NativeTargetPoint | undefined;
  readonly lastError: unknown;
  close(): Promise<void>;
}

export interface MaestroTargetPointOptions {
  readonly signal: AbortSignal;
  readonly readPoint: (signal: AbortSignal) => Promise<NativeTargetPoint>;
  readonly readTimeoutMs?: number;
}

const CLOSE_TIMEOUT_MS = 2_000;
const READ_TIMEOUT_MS = 15_000;

function write(response: ServerResponse, status: number, body: string): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close' });
  response.end(body);
}

function listen(server: Server, signal: AbortSignal): Promise<{ readonly port: number }> {
  return new Promise((resolve, reject) => {
    let listening = false;
    let abortRequested = false;
    const finishAbort = (): void => {
      void closeServer(server).then(
        () => reject(signal.reason instanceof Error ? signal.reason : new Error('Target point endpoint cancelled')),
        cleanupError => reject(new AggregateError([signal.reason, cleanupError], 'Target point listen cleanup failed')),
      );
    };
    const abort = (): void => {
      abortRequested = true;
      if (listening) finishAbort();
    };
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    signal.addEventListener('abort', abort, { once: true });
    server.listen(0, '127.0.0.1', () => {
      listening = true;
      server.removeListener('error', onError);
      signal.removeEventListener('abort', abort);
      if (abortRequested) {
        finishAbort();
        return;
      }
      const address = server.address();
      assert(address && typeof address === 'object' && address.port > 0, 'Target point server has no port');
      resolve({ port: address.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      reject(new Error('Target point server did not close within its bounded timeout'));
    }, CLOSE_TIMEOUT_MS);
    server.close(error => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function drainPending(
  pending: Set<Promise<unknown>>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled([...pending]).then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A short-lived, loopback-only Maestro read endpoint for a freshly measured native point. */
export async function openMaestroTargetPoint(
  options: MaestroTargetPointOptions,
): Promise<MaestroTargetPointEndpoint> {
  options.signal.throwIfAborted();
  const endpointController = new AbortController();
  const requestSignal = AbortSignal.any([options.signal, endpointController.signal]);
  const pathname = `/point/${randomUUID()}`;
  const pending = new Set<Promise<void>>();
  const pendingReads = new Set<Promise<unknown>>();
  let lastPoint: NativeTargetPoint | undefined;
  let lastError: unknown;
  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const operation = (async (): Promise<void> => {
      if (request.method !== 'GET' || request.url !== pathname) {
        write(response, 404, 'NOT_FOUND');
        return;
      }
      try {
        requestSignal.throwIfAborted();
        const readController = new AbortController();
        const readSignal = AbortSignal.any([requestSignal, readController.signal]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let readAbort: (() => void) | undefined;
        let point: NativeTargetPoint;
        try {
          const readPromise = Promise.resolve().then(() => options.readPoint(readSignal));
          pendingReads.add(readPromise);
          void readPromise.then(
            () => pendingReads.delete(readPromise),
            () => pendingReads.delete(readPromise),
          );
          const aborted = new Promise<NativeTargetPoint>((_, reject) => {
            readAbort = () => reject(readSignal.reason instanceof Error ? readSignal.reason : new Error('Target point read cancelled'));
            if (readSignal.aborted) readAbort();
            else readSignal.addEventListener('abort', readAbort, { once: true });
          });
          timer = setTimeout(() => readController.abort(new Error('Target point read timed out')), readTimeoutMs);
          point = await Promise.race([readPromise, aborted]);
          readSignal.throwIfAborted();
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (readAbort) readSignal.removeEventListener('abort', readAbort);
        }
        assert(Number.isFinite(point.x) && Number.isFinite(point.y), 'Native target point is not finite');
        lastPoint = point;
        write(response, 200, `${point.x},${point.y}`);
      } catch (error) {
        if (!requestSignal.aborted) lastError = error;
        if (!response.writableEnded && !requestSignal.aborted) write(response, 500, 'POINT_UNAVAILABLE');
      }
    })();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => undefined);
  });
  try {
    await listen(server, options.signal);
  } catch (error) {
    server.closeAllConnections();
    throw error;
  }
  const address = server.address();
  assert(address && typeof address === 'object', 'Target point server address disappeared');
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= (async () => {
    endpointController.abort(new Error('Target point endpoint closed'));
    const failures: unknown[] = [];
    const serverClose = closeServer(server).catch(error => { failures.push(error); });
    server.closeAllConnections();
    const reads = new Set<Promise<unknown>>([...pending, ...pendingReads]);
    const drained = await drainPending(reads);
    if (drained === false) failures.push(new Error('Target point pending read did not terminate within its bounded timeout'));
    await serverClose;
    if (failures.length) throw new AggregateError(failures, 'Target point endpoint cleanup failed');
  })());
  const abort = (): void => { void close().catch(() => undefined); };
  if (options.signal.aborted) {
    await close();
    options.signal.throwIfAborted();
  }
  options.signal.addEventListener('abort', abort, { once: true });
  return {
    url: `http://127.0.0.1:${address.port}${pathname}`,
    get lastPoint() { return lastPoint; },
    get lastError() { return lastError; },
    close: async () => {
      options.signal.removeEventListener('abort', abort);
      await close();
    },
  };
}
