import { ErrorHandler } from '@angular/core';
import { TrinityErrorHandler } from '@trinity/platform-native';
import { connectionError, httpError, matrixError } from '@trinity/testing';
import {
  describeMatrixRequestFailure,
  isTransientMatrixError,
  type MatrixRequestFailure,
} from '@trinity/util/matrix';
import {
  ConnectionError,
  HTTPError,
  MatrixError,
  TokenRefreshError,
  TokenRefreshLogoutError,
} from 'matrix-js-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SERVER = 'The homeserver is unavailable. Try again.';
const NETWORK = 'Check your connection and try again.';
const FALLBACK = 'Something went wrong. Try again.';

function outcome(
  kind: MatrixRequestFailure['kind'],
  message: string,
  diagnostic: Omit<MatrixRequestFailure['diagnostic'], 'kind'> = {},
): MatrixRequestFailure {
  return { kind, message, diagnostic: { kind, ...diagnostic } };
}

/**
 * The util classifiers read matrix-js-sdk's errors by shape, as util may not import the SDK.
 * These are the real classes, so a release that changes their shape fails here.
 */
describe('util/matrix error classifiers on the real SDK classes', () => {
  it.each([
    {
      label: 'ConnectionError',
      error: new ConnectionError('fetch failed', new TypeError('offline')),
      transient: true,
      failure: outcome('network', NETWORK),
    },
    {
      label: 'ConnectionError that timed out',
      error: new ConnectionError('request timed out'),
      transient: true,
      failure: outcome('timeout', 'The request timed out. Try again.'),
    },
    {
      label: 'HTTPError 503',
      error: new HTTPError('boom', 503),
      transient: true,
      failure: outcome('server', SERVER, { httpStatus: 503 }),
    },
    {
      label: 'HTTPError 400',
      error: new HTTPError('bad', 400),
      transient: false,
      failure: outcome('http', FALLBACK, { httpStatus: 400 }),
    },
    {
      label: 'HTTPError 403',
      error: new HTTPError('forbidden', 403),
      transient: false,
      failure: outcome('permission', 'You do not have permission to do that.', {
        httpStatus: 403,
      }),
    },
    {
      label: 'HTTPError 429 with Retry-After',
      error: new HTTPError(
        'slow down',
        429,
        new Headers({ 'Retry-After': '2' }),
      ),
      transient: true,
      failure: outcome(
        'rate-limit',
        'Too many requests. Try again in 2 seconds.',
        {
          httpStatus: 429,
          retryAfterMs: 2000,
        },
      ),
    },
    {
      label: 'MatrixError M_UNKNOWN 502',
      error: new MatrixError({ errcode: 'M_UNKNOWN' }, 502),
      transient: true,
      failure: outcome('server', SERVER, {
        httpStatus: 502,
        errcode: 'M_UNKNOWN',
      }),
    },
    {
      label: 'MatrixError M_NOT_FOUND 404',
      error: new MatrixError({ errcode: 'M_NOT_FOUND' }, 404),
      transient: false,
      failure: outcome('http', FALLBACK, {
        httpStatus: 404,
        errcode: 'M_NOT_FOUND',
      }),
    },
    {
      label: 'MatrixError M_UNKNOWN_TOKEN 401',
      error: new MatrixError({ errcode: 'M_UNKNOWN_TOKEN' }, 401),
      transient: false,
      failure: outcome(
        'authentication',
        'Your session has expired. Sign in again.',
        { httpStatus: 401, errcode: 'M_UNKNOWN_TOKEN' },
      ),
    },
    {
      label: 'MatrixError M_FORBIDDEN 400',
      error: new MatrixError({ errcode: 'M_FORBIDDEN' }, 400),
      transient: false,
      failure: outcome('permission', 'You do not have permission to do that.', {
        httpStatus: 400,
        errcode: 'M_FORBIDDEN',
      }),
    },
    {
      label: 'MatrixError M_LIMIT_EXCEEDED with retry_after_ms',
      error: new MatrixError(
        { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 2_100 },
        429,
      ),
      transient: true,
      failure: outcome(
        'rate-limit',
        'Too many requests. Try again in 3 seconds.',
        {
          httpStatus: 429,
          errcode: 'M_LIMIT_EXCEEDED',
          retryAfterMs: 2_100,
        },
      ),
    },
    {
      label: 'MatrixError M_LIMIT_EXCEEDED with a malformed delay',
      error: new MatrixError(
        { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1.5 },
        400,
      ),
      transient: false,
      failure: outcome('rate-limit', 'Too many requests. Try again shortly.', {
        httpStatus: 400,
        errcode: 'M_LIMIT_EXCEEDED',
      }),
    },
    {
      label: 'MatrixError of another errcode at 429',
      error: new MatrixError({ errcode: 'M_LIMIT' }, 429),
      transient: true,
      failure: outcome('http', FALLBACK, {
        httpStatus: 429,
        errcode: 'M_LIMIT',
      }),
    },
    {
      label: 'MatrixError without a status',
      error: new MatrixError({ errcode: 'M_UNKNOWN' }),
      transient: false,
      failure: outcome('http', FALLBACK, { errcode: 'M_UNKNOWN' }),
    },
    {
      label: 'MatrixError without a body or status',
      error: new MatrixError(),
      transient: false,
      failure: outcome('http', FALLBACK),
    },
    {
      label: 'MatrixError with a malformed errcode and a URL',
      error: new MatrixError(
        {
          errcode: { secret: 'body' } as unknown as string,
          error: 'secret response text',
        },
        503,
        'https://hs.example/path?access_token=secret',
      ),
      transient: true,
      failure: outcome('server', SERVER, { httpStatus: 503 }),
    },
    {
      label: 'TokenRefreshError',
      error: new TokenRefreshError(new Error('secret')),
      transient: false,
      failure: outcome(
        'network',
        'Your session could not be refreshed. Check your connection and try again.',
        { errorName: 'TokenRefreshError' },
      ),
    },
    {
      label: 'TokenRefreshLogoutError',
      error: new TokenRefreshLogoutError(new Error('secret')),
      transient: false,
      failure: outcome(
        'authentication',
        'Your session has expired. Sign in again.',
      ),
    },
  ])('classifies a $label', ({ error, transient, failure }) => {
    expect(isTransientMatrixError(error)).toBe(transient);
    expect(describeMatrixRequestFailure(error)).toEqual(failure);
  });
});

describe('the SDK error fakes', () => {
  it.each([
    [connectionError(), new ConnectionError('fetch failed')],
    [
      connectionError('request timed out'),
      new ConnectionError('request timed out'),
    ],
    [httpError(503), new HTTPError('HTTP 503', 503)],
    [httpError(400), new HTTPError('HTTP 400', 400)],
    [httpError(401), new HTTPError('HTTP 401', 401)],
    [httpError(403), new HTTPError('HTTP 403', 403)],
    [httpError(429), new HTTPError('HTTP 429', 429)],
    [
      httpError(429, 'slow down', '2'),
      new HTTPError('slow down', 429, new Headers({ 'Retry-After': '2' })),
    ],
    [
      httpError(429, 'slow down', 'soon'),
      new HTTPError('slow down', 429, new Headers({ 'Retry-After': 'soon' })),
    ],
    [
      matrixError('M_UNKNOWN', 502),
      new MatrixError({ errcode: 'M_UNKNOWN' }, 502),
    ],
    [
      matrixError('M_UNKNOWN', 429),
      new MatrixError({ errcode: 'M_UNKNOWN' }, 429),
    ],
    [matrixError('M_LIMIT', 429), new MatrixError({ errcode: 'M_LIMIT' }, 429)],
    [
      matrixError('M_NOT_FOUND', 404),
      new MatrixError({ errcode: 'M_NOT_FOUND' }, 404),
    ],
    [
      matrixError('M_UNKNOWN_TOKEN', 401),
      new MatrixError({ errcode: 'M_UNKNOWN_TOKEN' }, 401),
    ],
    [
      matrixError('M_FORBIDDEN', 403),
      new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
    ],
    [
      matrixError('M_LIMIT_EXCEEDED', 429, { retry_after_ms: 2_100 }),
      new MatrixError(
        { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 2_100 },
        429,
      ),
    ],
    [
      matrixError('M_LIMIT_EXCEEDED', 429, { retry_after_ms: 2_100 }, '5'),
      new MatrixError(
        { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 2_100 },
        429,
        undefined,
        undefined,
        new Headers({ 'Retry-After': '5' }),
      ),
    ],
    [
      matrixError('M_LIMIT_EXCEEDED', 400, { retry_after_ms: 1.5 }),
      new MatrixError(
        { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1.5 },
        400,
      ),
    ],
    [
      matrixError('M_LIMIT_EXCEEDED', 429, {
        retry_after_ms: Number.MAX_SAFE_INTEGER,
      }),
      new MatrixError(
        {
          errcode: 'M_LIMIT_EXCEEDED',
          retry_after_ms: Number.MAX_SAFE_INTEGER,
        },
        429,
      ),
    ],
    [
      matrixError('M_LIMIT_EXCEEDED'),
      new MatrixError({ errcode: 'M_LIMIT_EXCEEDED' }),
    ],
    [matrixError('M_UNKNOWN'), new MatrixError({ errcode: 'M_UNKNOWN' })],
  ])('classify %s like the SDK class', (fake, real) => {
    expect(isTransientMatrixError(fake)).toBe(isTransientMatrixError(real));
    expect(describeMatrixRequestFailure(fake)).toEqual(
      describeMatrixRequestFailure(real),
    );
  });

  it("match util/matrix's copy", () => {
    const read = (path: string) =>
      readFileSync(
        join(import.meta.dirname, '../../../../../..', path),
        'utf8',
      );
    expect(
      read('libs/util/matrix/src/lib/sdk-error-shapes.spec-harness.ts'),
    ).toBe(read('libs/testing/src/lib/sdk-error-shapes.ts'));
  });
});

describe('TrinityErrorHandler on the real SDK classes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('quiets transient SDK rejections and passes the rest on', () => {
    const fallback = vi
      .spyOn(ErrorHandler.prototype, 'handleError')
      .mockImplementation(() => undefined);
    const debug = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);
    const handler = new TrinityErrorHandler();

    handler.handleError(new ConnectionError('fetch failed'));
    handler.handleError(new HTTPError('unavailable', 503));
    handler.handleError(new MatrixError({ errcode: 'M_UNKNOWN' }, 502));
    expect(debug).toHaveBeenCalledTimes(3);
    expect(fallback).not.toHaveBeenCalled();

    const refused = new MatrixError({ errcode: 'M_FORBIDDEN' }, 403);
    handler.handleError(refused);
    expect(fallback).toHaveBeenCalledExactlyOnceWith(refused);
  });
});
