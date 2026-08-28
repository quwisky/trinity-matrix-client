import { TimeoutError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionError, HTTPError, MatrixError } from './transient-errors';
import {
  describeMatrixRequestFailure,
  matrixRequestErrorHandling,
  matrixRequestFailureDiagnostic,
  reportMatrixRequestFailure,
} from './request-failure';

describe('describeMatrixRequestFailure', () => {
  it.each([
    {
      error: new ConnectionError('fetch failed'),
      kind: 'network',
      message: 'Check your connection and try again.',
    },
    {
      error: new TimeoutError(),
      kind: 'timeout',
      message: 'The request timed out. Try again.',
    },
    {
      error: new MatrixError({ errcode: 'M_UNKNOWN_TOKEN' }, 401),
      kind: 'authentication',
      message: 'Your session has expired. Sign in again.',
    },
    {
      error: new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
      kind: 'permission',
      message: 'You do not have permission to do that.',
    },
    {
      error: new HTTPError('unavailable', 503),
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
    const failure = describeMatrixRequestFailure(
      new MatrixError(
        { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 2_100 },
        429,
      ),
    );

    expect(failure).toMatchObject({
      kind: 'rate-limit',
      message: 'Too many requests. Try again in 3 seconds.',
      diagnostic: { httpStatus: 429, errcode: 'M_LIMIT_EXCEEDED' },
    });
  });

  it('does not mistake a generic HTTP 401 UIA challenge for session expiry', () => {
    expect(
      describeMatrixRequestFailure(
        new HTTPError('interactive authentication required', 401),
        'Complete authentication and try again.',
      ),
    ).toMatchObject({
      kind: 'http',
      message: 'Complete authentication and try again.',
    });
  });

  it('preserves plain domain error messages', () => {
    expect(
      describeMatrixRequestFailure(new Error('Recovery key is invalid.')),
    ).toMatchObject({
      kind: 'unexpected',
      message: 'Recovery key is invalid.',
    });
  });
});

describe('matrixRequestFailureDiagnostic', () => {
  it('returns only allowlisted diagnostic fields', () => {
    const error = new MatrixError(
      {
        errcode: 'M_UNKNOWN',
        error: 'secret response text',
        access_token: 'secret token',
      },
      503,
      'https://hs.example/path?access_token=secret',
    );

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

  it('reports the operation and sanitized metadata instead of the raw error', () => {
    const logger = vi.fn();
    const error = new MatrixError(
      { errcode: 'M_UNKNOWN', error: 'secret response text' },
      503,
      'https://hs.example/path?access_token=secret',
    );

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
    const error = new MatrixError({ errcode: 'M_FORBIDDEN' }, 403);

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
