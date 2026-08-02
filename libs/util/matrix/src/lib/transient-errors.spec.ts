import { ConnectionError, HTTPError, MatrixError } from 'matrix-js-sdk';
import { defer, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTransientMatrixError, retryTransient } from './transient-errors';

describe('isTransientMatrixError', () => {
  it('treats a ConnectionError as transient', () => {
    expect(isTransientMatrixError(new ConnectionError('fetch failed'))).toBe(
      true,
    );
  });

  it('treats a 5xx / 429 HTTP or Matrix error as transient', () => {
    expect(isTransientMatrixError(new HTTPError('boom', 503))).toBe(true);
    expect(isTransientMatrixError(new HTTPError('boom', 500))).toBe(true);
    expect(
      isTransientMatrixError(new MatrixError({ errcode: 'M_LIMIT' }, 429)),
    ).toBe(true);
    expect(
      isTransientMatrixError(new MatrixError({ errcode: 'M_UNKNOWN' }, 502)),
    ).toBe(true);
  });

  it('treats a 4xx (except 429) error as NON-transient', () => {
    expect(isTransientMatrixError(new HTTPError('bad', 400))).toBe(false);
    expect(
      isTransientMatrixError(new MatrixError({ errcode: 'M_NOT_FOUND' }, 404)),
    ).toBe(false);
    expect(isTransientMatrixError(new HTTPError('forbidden', 403))).toBe(false);
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
      return attempts < 3
        ? throwError(() => new HTTPError('503', 503))
        : of('ok');
    }).pipe(retryTransient());

    const result = firstValueFrom(src);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(attempts).toBe(3); // 2 transient failures + 1 success
  });

  it('rethrows a non-transient error immediately without retrying', async () => {
    let attempts = 0;
    const err = new HTTPError('bad request', 400);
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
    const err = new HTTPError('down', 503);
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
