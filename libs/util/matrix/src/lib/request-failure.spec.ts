import {
  connectionError,
  httpError,
  matrixError,
} from './sdk-error-shapes.spec-harness';
import { TimeoutError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  describeMatrixRequestFailure,
  matrixRequestErrorHandling,
  matrixRequestFailureDiagnostic,
  reportMatrixRequestFailure,
} from './request-failure';

/** An `M_LIMIT_EXCEEDED` answer whose body asks for `retryAfterMs`. */
function rateLimited(retryAfterMs: number) {
  return matrixError('M_LIMIT_EXCEEDED', 429, { retry_after_ms: retryAfterMs });
}

describe('describeMatrixRequestFailure', () => {
  it.each([
    {
      error: connectionError(),
      kind: 'network',
      message: 'Check your connection and try again.',
    },
    {
      error: new TimeoutError(),
      kind: 'timeout',
      message: 'The request timed out. Try again.',
    },
    {
      error: new DOMException('The operation was aborted.', 'AbortError'),
      kind: 'timeout',
      message: 'The request timed out. Try again.',
    },
    {
      error: matrixError('M_UNKNOWN_TOKEN', 401),
      kind: 'authentication',
      message: 'Your session has expired. Sign in again.',
    },
    {
      error: matrixError('M_FORBIDDEN', 403),
      kind: 'permission',
      message: 'You do not have permission to do that.',
    },
    {
      error: httpError(503),
      kind: 'server',
      message: 'The homeserver is unavailable. Try again.',
    },
  ])(
    'maps $kind failures to an actionable message',
    ({ error, kind, message }) => {
      expect(describeMatrixRequestFailure(error)).toMatchObject({
        kind,
        message,
      });
    },
  );

  it('includes a safe server-provided retry delay for rate limits', () => {
    const failure = describeMatrixRequestFailure(rateLimited(2_100));

    expect(failure).toMatchObject({
      kind: 'rate-limit',
      message: 'Too many requests. Try again in 3 seconds.',
      diagnostic: { httpStatus: 429, errcode: 'M_LIMIT_EXCEEDED' },
    });
  });

  it('does not mistake a generic HTTP 401 UIA challenge for session expiry', () => {
    expect(
      describeMatrixRequestFailure(
        httpError(401, 'interactive authentication required'),
        'Complete authentication and try again.',
      ),
    ).toMatchObject({
      kind: 'http',
      message: 'Complete authentication and try again.',
    });
  });

  it('reads the SDK classes by shape', () => {
    // A MatrixError built without a status still owns `httpStatus`.
    expect(describeMatrixRequestFailure(matrixError('M_UNKNOWN'))).toEqual({
      kind: 'http',
      message: 'Something went wrong. Try again.',
      diagnostic: { kind: 'http', errcode: 'M_UNKNOWN' },
    });
    expect(
      describeMatrixRequestFailure(connectionError('request timed out')).kind,
    ).toBe('timeout');
    expect(describeMatrixRequestFailure(httpError(429))).toMatchObject({
      kind: 'rate-limit',
      diagnostic: { httpStatus: 429 },
    });
    expect(
      describeMatrixRequestFailure(httpError(429, 'slow down', '2')).message,
    ).toBe('Too many requests. Try again in 2 seconds.');
    // Without the SDK's rate-limit hooks, the status decides.
    expect(
      describeMatrixRequestFailure(
        Object.assign(new Error('x'), { httpStatus: 429 }),
      ).kind,
    ).toBe('http');
    expect(
      describeMatrixRequestFailure({ httpStatus: 503, errcode: 'M_UNKNOWN' })
        .kind,
    ).toBe('unexpected');
  });

  it('preserves plain domain error messages', () => {
    expect(
      describeMatrixRequestFailure(new Error('Recovery key is invalid.')),
    ).toMatchObject({
      kind: 'unexpected',
      message: 'Recovery key is invalid.',
    });
  });

  it('does not expose unmatched SDK wrapper details at a request boundary', () => {
    const error = new Error(
      'MatrixError: secret response (https://hs.example/path?access_token=secret)',
    );
    Object.defineProperty(error, 'name', { value: 'TokenRefreshError' });

    const result = describeMatrixRequestFailure(
      error,
      'Could not invite this user. Try again.',
    );

    expect(result).toMatchObject({
      kind: 'network',
      message:
        'Your session could not be refreshed. Check your connection and try again.',
      diagnostic: { kind: 'network' },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('hs.example');
  });

  it('classifies a failed terminal token refresh as session expiry', () => {
    const error = new Error('secret response at https://hs.example/private');
    Object.defineProperty(error, 'name', {
      value: 'TokenRefreshLogoutError',
    });

    expect(describeMatrixRequestFailure(error)).toEqual({
      kind: 'authentication',
      message: 'Your session has expired. Sign in again.',
      diagnostic: { kind: 'authentication' },
    });
  });

  it('uses the safe operation fallback for other unmatched request errors', () => {
    const result = describeMatrixRequestFailure(
      new Error('secret response at https://hs.example/private'),
      'Could not join the room. Try again.',
    );

    expect(result.message).toBe('Could not join the room. Try again.');
    expect(result.diagnostic).toEqual({
      kind: 'unexpected',
      errorName: 'Error',
    });
  });
});

describe('matrixRequestFailureDiagnostic', () => {
  it('returns only allowlisted diagnostic fields', () => {
    const error = matrixError('M_UNKNOWN', 503, {
      error: 'secret response text',
      access_token: 'secret token',
    });

    const diagnostic = matrixRequestFailureDiagnostic(
      'background Matrix request',
      error,
    );

    expect(diagnostic).toEqual({
      operation: 'background Matrix request',
      kind: 'server',
      httpStatus: 503,
      errcode: 'M_UNKNOWN',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('secret');
    expect(JSON.stringify(diagnostic)).not.toContain('access_token');
  });

  it('omits malformed diagnostic values and unrealistic retry delays', () => {
    const malformed = Object.assign(httpError(503), {
      errcode: { secret: 'response text' },
    });

    expect(matrixRequestFailureDiagnostic('load directory', malformed)).toEqual(
      {
        operation: 'load directory',
        kind: 'server',
        httpStatus: 503,
      },
    );
    expect(
      describeMatrixRequestFailure(rateLimited(Number.MAX_SAFE_INTEGER)),
    ).toMatchObject({
      kind: 'rate-limit',
      message: 'Too many requests. Try again shortly.',
      diagnostic: {
        kind: 'rate-limit',
        httpStatus: 429,
        errcode: 'M_LIMIT_EXCEEDED',
      },
    });
  });

  it('reports the operation and sanitized metadata instead of the raw error', () => {
    const logger = vi.fn();
    const error = matrixError('M_UNKNOWN', 503, {
      error: 'secret response text',
    });

    reportMatrixRequestFailure('load room directory', error, logger);

    expect(logger).toHaveBeenCalledWith('[trinity] Matrix request failed', {
      operation: 'load room directory',
      kind: 'server',
      httpStatus: 503,
      errcode: 'M_UNKNOWN',
    });
    expect(JSON.stringify(logger.mock.calls)).not.toContain('secret');
  });

  it('builds formatter and reporter hooks for a named request', () => {
    const logger = vi.fn();
    const handling = matrixRequestErrorHandling(
      'invite user to room',
      'Could not invite this user. Try again.',
      logger,
    );
    const error = matrixError('M_FORBIDDEN', 403);

    expect(handling.formatError(error)).toBe(
      'You do not have permission to do that.',
    );
    handling.reportError(error);

    expect(logger).toHaveBeenCalledWith('[trinity] Matrix request failed', {
      operation: 'invite user to room',
      kind: 'permission',
      httpStatus: 403,
      errcode: 'M_FORBIDDEN',
    });
  });
});
