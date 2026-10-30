import { defer, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectionError,
  httpError,
  matrixError,
} from './sdk-error-shapes.spec-harness';
import {
  isMatrixRequestAbortError,
  isTransientMatrixError,
  retryTransient,
} from './transient-errors';

describe('isMatrixRequestAbortError', () => {
  it('recognizes the AbortError preserved by the Matrix fetch transport', () => {
    expect(
      isMatrixRequestAbortError(
        new DOMException('The operation was aborted.', 'AbortError'),
      ),
    ).toBe(true);
    expect(isMatrixRequestAbortError(new Error('aborted'))).toBe(false);
  });
});

describe('isTransientMatrixError', () => {
  it('treats a ConnectionError as transient', () => {
    expect(isTransientMatrixError(connectionError('fetch failed'))).toBe(true);
  });

  it('treats a 5xx / 429 HTTP or Matrix error as transient', () => {
    expect(isTransientMatrixError(httpError(503))).toBe(true);
    expect(isTransientMatrixError(httpError(500))).toBe(true);
    expect(isTransientMatrixError(matrixError('M_LIMIT', 429))).toBe(true);
    expect(isTransientMatrixError(matrixError('M_UNKNOWN', 502))).toBe(true);
  });

  it('treats a 4xx (except 429) error as NON-transient', () => {
    expect(isTransientMatrixError(httpError(400))).toBe(false);
    expect(isTransientMatrixError(matrixError('M_NOT_FOUND', 404))).toBe(false);
    expect(isTransientMatrixError(httpError(403))).toBe(false);
  });

  it('reads the SDK classes by shape', () => {
    expect(isTransientMatrixError({ name: 'ConnectionError' })).toBe(false);
    expect(isTransientMatrixError({ httpStatus: 503 })).toBe(false);
  });

  it('treats a plain Error and undefined as NON-transient', () => {
    expect(isTransientMatrixError(new Error('nope'))).toBe(false);
    expect(isTransientMatrixError(new TypeError('fetch failed'))).toBe(false);
    expect(isTransientMatrixError(undefined)).toBe(false);
    expect(isTransientMatrixError(null)).toBe(false);
  });
});

describe('retryTransient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient error with backoff, then succeeds', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const src = defer(() => {
      attempts++;
      return attempts < 3 ? throwError(() => httpError(503)) : of('ok');
    }).pipe(retryTransient());

    const result = firstValueFrom(src);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(attempts).toBe(3); // 2 transient failures + 1 success
  });

  it('rethrows a non-transient error immediately without retrying', async () => {
    let attempts = 0;
    const err = httpError(400);
    const src = defer(() => {
      attempts++;
      return throwError(() => err);
    }).pipe(retryTransient());

    await expect(firstValueFrom(src)).rejects.toBe(err);
    expect(attempts).toBe(1);
  });

  it('gives up after 3 retries and rethrows the transient error', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const err = httpError(503);
    const src = defer(() => {
      attempts++;
      return throwError(() => err);
    }).pipe(retryTransient());

    const settled = firstValueFrom(src).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    await expect(settled).resolves.toBe(err);
    expect(attempts).toBe(4); // 1 initial + 3 retries
  });
});
