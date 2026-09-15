import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { DevtoolsEventConnection } from '../support/devtools-connection.mts';

export type MatrixRequestKind = 'invite' | 'join';

export interface MatrixRoomStateTarget {
  readonly roomId: string;
  readonly eventType: 'm.room.name' | 'm.room.topic' | 'm.space.child';
  readonly stateKey?: '' | '*' | string;
}

export interface MatrixRoomAliasTarget {
  readonly alias: string;
}

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

export type MatrixHttpFaultOptions =
  | {
      readonly kind: MatrixRequestKind;
      readonly status: number;
      readonly responseError?: string;
    }
  | (MatrixRoomStateTarget & {
      readonly kind: 'room-state';
      readonly status: number;
      readonly responseError?: string;
    })
  | (MatrixRoomAliasTarget & {
      readonly kind: 'room-alias';
      readonly status: number;
      readonly responseError?: string;
    });

export interface MatrixHttpFault {
  readonly attempts: number;
  readonly createRoomAttempts: number;
  readonly firstOutcome: MatrixHttpOutcome | undefined;
  roomStateAttempts(eventType: MatrixRoomStateTarget['eventType']): number;
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

export interface MatrixHttpDelay {
  readonly attempts: number;
  readonly released: boolean;
  waitForAttempts(expected: number, signal: AbortSignal): Promise<number>;
  release(): Promise<void>;
  close(): Promise<void>;
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

/** Match one exact or wildcard-keyed room state write without catching adjacent rooms or event types. */
export function isMatrixRoomStateRequest(
  value: unknown,
  target: MatrixRoomStateTarget,
): boolean {
  const request = fetchRequest(value);
  if (!request || request.method !== 'PUT') return false;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return false;
  }
  const match = pathname.match(
    /^\/_matrix\/client\/[^/]+\/rooms\/([^/]+)\/state\/([^/]+)(?:\/([^/]+))?\/?$/,
  );
  if (!match) return false;
  try {
    const stateKey = match[3] === undefined ? '' : decodeURIComponent(match[3]);
    return (
      decodeURIComponent(match[1]!) === target.roomId &&
      decodeURIComponent(match[2]!) === target.eventType &&
      (target.stateKey === undefined
        ? stateKey === ''
        : target.stateKey === '*'
          ? stateKey.length > 0
          : stateKey === target.stateKey)
    );
  } catch {
    return false;
  }
}

/** Match one exact room-alias directory write without catching adjacent aliases. */
export function isMatrixRoomAliasRequest(
  value: unknown,
  target: MatrixRoomAliasTarget,
): boolean {
  const request = fetchRequest(value);
  if (!request || request.method !== 'PUT') return false;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return false;
  }
  const match = pathname.match(
    /^\/_matrix\/client\/[^/]+\/directory\/room\/([^/]+)\/?$/,
  );
  if (!match) return false;
  try {
    return decodeURIComponent(match[1]!) === target.alias;
  } catch {
    return false;
  }
}

function isMatrixCreateRoomRequest(value: unknown): boolean {
  const request = fetchRequest(value);
  if (!request || request.method !== 'POST') return false;
  try {
    return /^\/_matrix\/client\/[^/]+\/createRoom$/.test(
      new URL(request.url).pathname,
    );
  } catch {
    return false;
  }
}

function fetchPattern(options: MatrixHttpFaultOptions | MatrixRoomStateTarget): string {
  if ('eventType' in options && !('kind' in options)) {
    return '*/_matrix/client/*/rooms/*/state/*';
  }
  return options.kind === 'invite'
    ? '*/_matrix/client/*/rooms/*/invite'
    : options.kind === 'join'
      ? '*/_matrix/client/*/join/*'
      : options.kind === 'room-alias'
        ? '*/_matrix/client/*/directory/room/*'
        : '*/_matrix/client/*/rooms/*/state/*';
}

function matchesFaultRequest(
  value: unknown,
  options: MatrixHttpFaultOptions,
): boolean {
  if (options.kind === 'room-alias') {
    assert(options.alias, 'Room-alias fault requires an exact alias');
    return isMatrixRoomAliasRequest(value, options);
  }
  if (options.kind === 'room-state') {
    assert(options.roomId, 'Room-state fault requires an exact room id');
    assert(options.eventType, 'Room-state fault requires an exact event type');
    return isMatrixRoomStateRequest(value, options);
  }
  return matrixRequestKind(value) === options.kind;
}

function failurePayload(responseError = 'synthetic upstream failure'): string {
  return JSON.stringify({
    errcode: 'M_UNKNOWN',
    error: responseError,
  });
}

function failureBody(responseError?: string): string {
  return Buffer.from(failurePayload(responseError)).toString('base64');
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
  if (options.kind === 'room-state') {
    assert(options.roomId, 'Room-state fault requires an exact room id');
    assert(options.eventType, 'Room-state fault requires an exact event type');
  }
  if (options.kind === 'room-alias') {
    assert(options.alias, 'Room-alias fault requires an exact alias');
  }
  let attempts = 0;
  let closed = false;
  let eventFailure: unknown;
  let work = Promise.resolve();
  let firstNetworkId: string | undefined;
  let firstOutcome: MatrixHttpOutcome | undefined;
  let createRoomAttempts = 0;
  const roomStateAttempts = new Map<MatrixRoomStateTarget['eventType'], number>();

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
            bodyMatchesInjected: body === failurePayload(options.responseError),
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
    if (isMatrixCreateRoomRequest(paused)) createRoomAttempts += 1;
    if (options.kind === 'room-state') {
      for (const eventType of [
        'm.room.name',
        'm.room.topic',
        'm.space.child',
      ] as const) {
        if (
          isMatrixRoomStateRequest(paused, {
            roomId: options.roomId,
            eventType,
            ...(eventType === 'm.space.child' ? { stateKey: '*' } : {}),
          })
        ) {
          roomStateAttempts.set(
            eventType,
            (roomStateAttempts.get(eventType) ?? 0) + 1,
          );
        }
      }
    }
    if (!matchesFaultRequest(paused, options)) {
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
          options.status === 500
            ? 'Internal Server Error'
            : options.status === 503
              ? 'Service Unavailable'
              : 'Bad Gateway',
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          {
            name: 'Access-Control-Expose-Headers',
            value: 'Synapse-Trace-Id, Server',
          },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: failureBody(options.responseError),
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
        { urlPattern: fetchPattern(options), requestStage: 'Request' },
        { urlPattern: '*/_matrix/client/*/createRoom', requestStage: 'Request' },
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
    get createRoomAttempts() {
      return createRoomAttempts;
    },
    get firstOutcome() {
      return firstOutcome ? { ...firstOutcome } : undefined;
    },
    roomStateAttempts(eventType) {
      return roomStateAttempts.get(eventType) ?? 0;
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

/**
 * Hold the first exact room-state write until the caller releases it. Adjacent
 * state writes and every later exact write continue immediately. Closing the
 * controller releases a pending request before disabling Fetch interception.
 */
export async function installMatrixRoomStateDelay(
  connection: DevtoolsEventConnection,
  target: MatrixRoomStateTarget,
): Promise<MatrixHttpDelay> {
  assert(target.roomId, 'Room-state delay requires an exact room id');
  assert(target.eventType, 'Room-state delay requires an exact event type');
  let attempts = 0;
  let closed = false;
  let released = false;
  let pendingRequestId: string | undefined;
  let eventFailure: unknown;
  let work = Promise.resolve();

  const continueRequest = async (requestId: string): Promise<void> => {
    await connection.send('Fetch.continueRequest', { requestId });
  };
  const handle = async (value: unknown): Promise<void> => {
    const paused = pausedRequest(value);
    if (!paused) throw new Error('Fetch.requestPaused payload is malformed');
    if (!isMatrixRoomStateRequest(paused, target)) {
      await continueRequest(paused.requestId);
      return;
    }
    attempts += 1;
    if (attempts === 1 && !released) {
      pendingRequestId = paused.requestId;
      return;
    }
    await continueRequest(paused.requestId);
  };
  const unsubscribe = connection.on('Fetch.requestPaused', (params) => {
    if (closed) return;
    work = work.then(() => handle(params)).catch((error: unknown) => {
      eventFailure ??= error;
    });
  });

  try {
    await connection.send('Fetch.enable', {
      patterns: [
        { urlPattern: fetchPattern(target), requestStage: 'Request' },
      ],
    });
  } catch (error) {
    unsubscribe();
    throw error;
  }

  const throwIfFailed = (): void => {
    if (eventFailure !== undefined) throw eventFailure;
  };
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await work;
    throwIfFailed();
    const requestId = pendingRequestId;
    pendingRequestId = undefined;
    if (requestId) await continueRequest(requestId);
  };

  return {
    get attempts() {
      return attempts;
    },
    get released() {
      return released;
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
    release,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribe();
      const failures: unknown[] = [];
      try {
        await release();
      } catch (error) {
        failures.push(error);
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
          'Matrix room-state delay cleanup failed',
        );
      }
    },
  };
}
