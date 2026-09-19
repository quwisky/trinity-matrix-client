import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import type { DevtoolsEventConnection } from '../support/devtools-connection.mts';

export interface CrossUserIdentityQueryDelayOptions {
  readonly counterpartUserId: string;
  readonly delayMs: number;
  readonly signal?: AbortSignal;
}

export interface CrossUserIdentityQueryDelay {
  readonly matchingRequests: number;
  markVerificationStarted(): void;
  close(): Promise<void>;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface PausedRequest {
  readonly requestId: string;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly postData?: string;
  };
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pausedRequest(value: unknown): PausedRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as {
    readonly requestId?: unknown;
    readonly request?: unknown;
  };
  if (
    typeof record.requestId !== 'string' ||
    !record.request ||
    typeof record.request !== 'object'
  ) {
    return undefined;
  }
  const request = record.request as {
    readonly method?: unknown;
    readonly url?: unknown;
    readonly postData?: unknown;
  };
  if (typeof request.method !== 'string' || typeof request.url !== 'string') {
    return undefined;
  }
  return {
    requestId: record.requestId,
    request: {
      method: request.method,
      url: request.url,
      ...(typeof request.postData === 'string'
        ? { postData: request.postData }
        : {}),
    },
  };
}

function targetsCounterpart(
  paused: PausedRequest,
  counterpartUserId: string,
): boolean {
  const request = paused.request;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return false;
  }
  if (
    request.method === 'POST' &&
    pathname === '/_matrix/client/v3/keys/query' &&
    request.postData
  ) {
    try {
      const body = JSON.parse(request.postData) as {
        readonly device_keys?: unknown;
      };
      const deviceKeys =
        body.device_keys && typeof body.device_keys === 'object'
          ? body.device_keys
          : {};
      return Object.hasOwn(deviceKeys, counterpartUserId);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Delay only primary-client key queries that name the exact counterpart. Every
 * paused request is released before Fetch interception is disabled.
 */
export async function installCrossUserIdentityQueryDelay(
  connection: DevtoolsEventConnection,
  options: CrossUserIdentityQueryDelayOptions,
): Promise<CrossUserIdentityQueryDelay> {
  const { counterpartUserId, delayMs, signal } = options;
  assert(counterpartUserId.startsWith('@'), 'Counterpart must be an exact MXID');
  assert(
    Number.isInteger(delayMs) && delayMs >= 0,
    'Identity-query delay must be a nonnegative integer',
  );

  let matchingRequests = 0;
  let started = false;
  let closed = false;
  let eventFailure: unknown;
  const verificationStarted = deferred();
  const pendingRequestIds = new Set<string>();
  const tasks = new Set<Promise<void>>();

  const continueRequest = async (requestId: string): Promise<void> => {
    if (!pendingRequestIds.has(requestId)) return;
    await connection.send('Fetch.continueRequest', { requestId });
    pendingRequestIds.delete(requestId);
  };

  const handle = async (value: unknown): Promise<void> => {
    const paused = pausedRequest(value);
    if (!paused) throw new Error('Identity Fetch.requestPaused payload is malformed');
    pendingRequestIds.add(paused.requestId);
    if (!targetsCounterpart(paused, counterpartUserId)) {
      await continueRequest(paused.requestId);
      return;
    }
    matchingRequests += 1;
    await verificationStarted.promise;
    try {
      await setTimeout(delayMs, undefined, signal ? { signal } : undefined);
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
    await continueRequest(paused.requestId);
  };

  const unsubscribe = connection.on('Fetch.requestPaused', (value) => {
    if (closed) return;
    let task!: Promise<void>;
    task = handle(value)
      .catch((error: unknown) => {
        eventFailure ??= error;
      })
      .finally(() => tasks.delete(task));
    tasks.add(task);
  });

  try {
    await connection.send('Fetch.enable', {
      patterns: [
        {
          urlPattern: '*/_matrix/client/v3/keys/query*',
          requestStage: 'Request',
        },
      ],
    });
  } catch (error) {
    unsubscribe();
    throw error;
  }

  const throwIfFailed = (): void => {
    if (eventFailure !== undefined) throw eventFailure;
  };

  return {
    get matchingRequests() {
      throwIfFailed();
      return matchingRequests;
    },
    markVerificationStarted(): void {
      if (started) return;
      started = true;
      verificationStarted.resolve();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribe();
      verificationStarted.resolve();
      const failures: unknown[] = [];
      try {
        await Promise.all(tasks);
        throwIfFailed();
      } catch (error) {
        failures.push(error);
      }
      for (const requestId of [...pendingRequestIds]) {
        try {
          await continueRequest(requestId);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await connection.send('Fetch.disable');
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) {
        throw new AggregateError(
          failures,
          'Cross-user identity-query cleanup failed',
        );
      }
    },
  };
}
