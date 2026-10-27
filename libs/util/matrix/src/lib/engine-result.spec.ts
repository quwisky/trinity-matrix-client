import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  assertPlainData,
  engineFail,
  engineOk,
  EngineRequestError,
  NOT_SIGNED_IN,
  unwrapEngineResult,
} from './engine-result';
import {
  describeMatrixRequestFailure,
  type MatrixRequestFailure,
} from './request-failure';

describe('assertPlainData', () => {
  it('accepts plain JSON-like data', () => {
    expect(() =>
      assertPlainData({ a: 1, b: 'x', c: null, d: [true, { e: [] }] }),
    ).not.toThrow();
  });

  class Custom {}
  it.each([
    ['undefined property', { a: undefined }, '$.a'],
    ['undefined element', [undefined], '$[0]'],
    ['Date', { a: new Date() }, '$.a'],
    ['Map', new Map(), '$'],
    ['function', { f() {} }, '$.f'],
    ['NaN', { n: NaN }, '$.n'],
    ['Infinity', [Infinity], '$[0]'],
    ['class instance', { x: new Custom() }, '$.x'],
  ])('rejects %s', (_name, value, path) => {
    expect(() => assertPlainData(value)).toThrow(TypeError);
    expect(() => assertPlainData(value)).toThrow(path);
  });
});

describe('unwrapEngineResult', () => {
  it('passes ok values through', async () => {
    await expect(
      firstValueFrom(of(engineOk(5)).pipe(unwrapEngineResult())),
    ).resolves.toBe(5);
  });

  it('turns a failure into an EngineRequestError', async () => {
    const error = await firstValueFrom(
      of(engineFail(NOT_SIGNED_IN)).pipe(unwrapEngineResult()),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineRequestError);
    expect((error as EngineRequestError).message).toBe('Not signed in.');
    expect((error as EngineRequestError).failure).toBe(NOT_SIGNED_IN);
  });

  it('leaves stream errors untouched', async () => {
    const boom = new Error('boom');
    await expect(
      firstValueFrom(throwError(() => boom).pipe(unwrapEngineResult())),
    ).rejects.toBe(boom);
  });
});

describe('describeMatrixRequestFailure with EngineRequestError', () => {
  it('returns the carried failure unchanged', () => {
    const f: MatrixRequestFailure = {
      kind: 'permission',
      message: 'You do not have permission to do that.',
      diagnostic: {
        kind: 'permission',
        httpStatus: 403,
        errcode: 'M_FORBIDDEN',
      },
    };
    expect(describeMatrixRequestFailure(new EngineRequestError(f))).toBe(f);
  });
});

describe('describeMatrixRequestFailure for an engine failure', () => {
  const unexpected = new EngineRequestError({
    kind: 'unexpected',
    message: 'Could not discover a homeserver for "x".',
    diagnostic: { kind: 'unexpected' },
  });

  it('replaces the message of an unexpected failure with an operation fallback', () => {
    expect(describeMatrixRequestFailure(unexpected, 'Try again.')).toEqual({
      kind: 'unexpected',
      message: 'Try again.',
      diagnostic: { kind: 'unexpected' },
    });
  });

  it('keeps the message of an unexpected failure under the default fallback', () => {
    expect(describeMatrixRequestFailure(unexpected).message).toBe(
      'Could not discover a homeserver for "x".',
    );
  });

  it('applies an operation fallback to a plain HTTP failure', () => {
    expect(
      describeMatrixRequestFailure(
        new EngineRequestError({
          kind: 'http',
          message: 'Something went wrong. Try again.',
          diagnostic: { kind: 'http', httpStatus: 404 },
        }),
        'Try again.',
      ),
    ).toEqual({
      kind: 'http',
      message: 'Try again.',
      diagnostic: { kind: 'http', httpStatus: 404 },
    });
  });

  it('returns other kinds unchanged', () => {
    const permission = {
      kind: 'permission' as const,
      message: 'You do not have permission to do that.',
      diagnostic: { kind: 'permission' as const, httpStatus: 403 },
    };
    expect(
      describeMatrixRequestFailure(
        new EngineRequestError(permission),
        'Try again.',
      ),
    ).toBe(permission);
  });
});
