import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { DevtoolsEventConnection } from '../support/devtools-connection.mts';

export type MatrixRequestKind = 'invite' | 'join';

interface FetchRequestPaused {
  readonly requestId: string;
  readonly networkId?: string;
  readonly request: {
    readonly method: string;
    readonly url: string;
  };
}

interface FetchRequest {
  readonly method: string;
  readonly url: string;
}

export interface MatrixHttpFaultOptions {
  readonly kind: MatrixRequestKind;
  readonly status: number;
}

export interface MatrixHttpFault {
  readonly attempts: number;
  readonly firstOutcome: MatrixHttpOutcome | undefined;
  waitForAttempts(expected: number, signal: AbortSignal): Promise<number>;
  close(): Promise<void>;
}

export interface MatrixHttpOutcome {
  readonly responseStatus?: number;
  readonly finished?: true;
  readonly failedReason?: string;
  readonly blockedReason?: string;
  readonly bodyBytes?: number;
  readonly bodyMatchesInjected?: boolean;
  readonly bodyReadFailed?: true;
  readonly handlerReported?: true;
}

function fetchRequest(value: unknown): FetchRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { readonly request?: unknown };
  if (!record.request || typeof record.request !== 'object') {
    return undefined;
  }
  const request = record.request as {
    readonly method?: unknown;
    readonly url?: unknown;
  };
  return typeof request.method === 'string' && typeof request.url === 'string'
    ? { method: request.method, url: request.url }
    : undefined;
}

function pausedRequest(value: unknown): FetchRequestPaused | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const requestId = (value as { readonly requestId?: unknown }).requestId;
  const networkId = (value as { readonly networkId?: unknown }).networkId;
  const request = fetchRequest(value);
  return typeof requestId === 'string' && request
    ? {
        requestId,
        request,
        ...(typeof networkId === 'string' ? { networkId } : {}),
      }
    : undefined;
}

/** Classify only the Matrix POST requests owned by this migration batch. */
export function matrixRequestKind(value: unknown): MatrixRequestKind | undefined {
  const request = fetchRequest(value);
  if (!request || request.method !== 'POST') return undefined;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return undefined;
  }
  if (/^\/_matrix\/client\/[^/]+\/rooms\/[^/]+\/invite$/.test(pathname)) {
    return 'invite';
  }
  return /^\/_matrix\/client\/[^/]+\/join\/[^/]+$/.test(pathname)
    ? 'join'
    : undefined;
}

function fetchPattern(kind: MatrixRequestKind): string {
  return kind === 'invite'
    ? '*/_matrix/client/*/rooms/*/invite'
    : '*/_matrix/client/*/join/*';
}

function failurePayload(): string {
  return JSON.stringify({
    errcode: 'M_UNKNOWN',
    error: 'synthetic upstream failure',
  });
}

function failureBody(): string {
  return Buffer.from(failurePayload()).toString('base64');
}

/**
 * Fail the first matching Matrix request at CDP transport level and let every
 * later request reach Synapse. The caller owns both this controller and its
 * persistent page connection.
 */
export async function installFirstMatrixHttpFailure(
  connection: DevtoolsEventConnection,
  options: MatrixHttpFaultOptions,
): Promise<MatrixHttpFault> {
  assert(
    Number.isInteger(options.status) &&
      options.status >= 400 &&
      options.status <= 599,
    'Injected Matrix HTTP status must be a 4xx or 5xx integer',
  );
  let attempts = 0;
  let closed = false;
  let eventFailure: unknown;
  let work = Promise.resolve();
  let firstNetworkId: string | undefined;
  let firstOutcome: MatrixHttpOutcome | undefined;

  const networkEvent = (
    value: unknown,
  ): { readonly requestId: string; readonly record: Record<string, unknown> } | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    return typeof record.requestId === 'string'
      ? { requestId: record.requestId, record }
      : undefined;
  };
  const responseUnsubscribe = connection.on(
    'Network.responseReceived',
    (value) => {
      const event = networkEvent(value);
      if (!event || event.requestId !== firstNetworkId) return;
      const response = event.record.response;
      const status =
        response && typeof response === 'object'
          ? (response as { readonly status?: unknown }).status
          : undefined;
      if (typeof status === 'number' && Number.isFinite(status)) {
        firstOutcome = { ...firstOutcome, responseStatus: status };
      }
    },
  );
  const finishedUnsubscribe = connection.on(
    'Network.loadingFinished',
    (value) => {
      const event = networkEvent(value);
      if (!event || event.requestId !== firstNetworkId) return;
      firstOutcome = { ...firstOutcome, finished: true };
      work = work.then(async () => {
        try {
          const result = await connection.send('Network.getResponseBody', {
            requestId: event.requestId,
          });
          const bodyRecord =
            result && typeof result === 'object'
              ? (result as {
                  readonly body?: unknown;
                  readonly base64Encoded?: unknown;
                })
              : undefined;
          if (typeof bodyRecord?.body !== 'string') {
            firstOutcome = { ...firstOutcome, bodyReadFailed: true };
            return;
          }
          const body =
            bodyRecord.base64Encoded === true
              ? Buffer.from(bodyRecord.body, 'base64').toString('utf8')
              : bodyRecord.body;
          firstOutcome = {
            ...firstOutcome,
            bodyBytes: Buffer.byteLength(body),
            bodyMatchesInjected: body === failurePayload(),
          };
        } catch {
          firstOutcome = { ...firstOutcome, bodyReadFailed: true };
        }
      });
    },
  );
  const failedUnsubscribe = connection.on(
    'Network.loadingFailed',
    (value) => {
      const event = networkEvent(value);
      if (!event || event.requestId !== firstNetworkId) return;
      const errorText = event.record.errorText;
      const blockedReason = event.record.blockedReason;
      firstOutcome = {
        ...firstOutcome,
        ...(typeof errorText === 'string'
          ? { failedReason: errorText }
          : {}),
        ...(typeof blockedReason === 'string'
          ? { blockedReason }
          : {}),
      };
    },
  );
  const consoleUnsubscribe = connection.on(
    'Runtime.consoleAPICalled',
    (value) => {
      if (!value || typeof value !== 'object') return;
      const args = (value as { readonly args?: unknown }).args;
      if (
        Array.isArray(args) &&
        args.some(
          (argument) =>
            argument &&
            typeof argument === 'object' &&
            (argument as { readonly value?: unknown }).value ===
              '[trinity] Matrix request failed',
        )
      ) {
        firstOutcome = { ...firstOutcome, handlerReported: true };
      }
    },
  );

  const handle = async (value: unknown): Promise<void> => {
    const paused = pausedRequest(value);
    if (!paused) throw new Error('Fetch.requestPaused payload is malformed');
    if (matrixRequestKind(paused) !== options.kind) {
      await connection.send('Fetch.continueRequest', {
        requestId: paused.requestId,
      });
      return;
    }
    attempts += 1;
    if (attempts === 1) {
      firstNetworkId = paused.networkId;
      await connection.send('Fetch.fulfillRequest', {
        requestId: paused.requestId,
        responseCode: options.status,
        responsePhrase:
          options.status === 503 ? 'Service Unavailable' : 'Bad Gateway',
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          {
            name: 'Access-Control-Expose-Headers',
            value: 'Synapse-Trace-Id, Server',
          },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: failureBody(),
      });
      return;
    }
    await connection.send('Fetch.continueRequest', {
      requestId: paused.requestId,
    });
  };
  const unsubscribe = connection.on('Fetch.requestPaused', (params) => {
    if (closed) return;
    work = work.then(() => handle(params)).catch((error: unknown) => {
      eventFailure ??= error;
    });
  });

  try {
    await connection.send('Runtime.enable');
    await connection.send('Network.enable');
    await connection.send('Fetch.enable', {
      patterns: [
        { urlPattern: fetchPattern(options.kind), requestStage: 'Request' },
      ],
    });
  } catch (error) {
    unsubscribe();
    responseUnsubscribe();
    finishedUnsubscribe();
    failedUnsubscribe();
    consoleUnsubscribe();
    try {
      await connection.send('Network.disable');
    } catch {
      // Preserve the setup failure as the actionable cause.
    }
    try {
      await connection.send('Runtime.disable');
    } catch {
      // Preserve the setup failure as the actionable cause.
    }
    throw error;
  }

  const throwIfFailed = (): void => {
    if (eventFailure !== undefined) throw eventFailure;
  };
  return {
    get attempts() {
      return attempts;
    },
    get firstOutcome() {
      return firstOutcome ? { ...firstOutcome } : undefined;
    },
    async waitForAttempts(expected, signal): Promise<number> {
      assert(expected >= 0, 'Expected Matrix attempt count must be nonnegative');
      while (attempts < expected) {
        signal.throwIfAborted();
        throwIfFailed();
        await delay(25, undefined, { signal });
      }
      await work;
      throwIfFailed();
      return attempts;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribe();
      responseUnsubscribe();
      finishedUnsubscribe();
      failedUnsubscribe();
      consoleUnsubscribe();
      const failures: unknown[] = [];
      try {
        await work;
        throwIfFailed();
      } catch (error) {
        failures.push(error);
      }
      try {
        await connection.send('Fetch.disable');
      } catch (error) {
        failures.push(error);
      }
      try {
        await connection.send('Network.disable');
      } catch (error) {
        failures.push(error);
      }
      try {
        await connection.send('Runtime.disable');
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) {
        throw new AggregateError(
          failures,
          'Matrix HTTP fault instrumentation cleanup failed',
        );
      }
    },
  };
}
