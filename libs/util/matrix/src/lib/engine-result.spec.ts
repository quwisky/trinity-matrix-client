import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  assertPlainData,
  type DiscoveryFailureReason,
  type EngineFailure,
  engineFailureMessage,
  engineFail,
  engineOk,
  EngineRequestError,
  NOT_SIGNED_IN,
  plainEqual,
  retryableFailure,
  unwrapEngineResult,
} from './engine-result';
import { describeMatrixRequestFailure } from './request-failure';

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

const requestFailed = (
  kind: EngineFailure['kind'],
  diagnostic: Omit<EngineFailure['diagnostic'], 'kind'> = {},
): EngineFailure => ({
  kind,
  code: 'request-failed',
  diagnostic: { kind, ...diagnostic },
});

const SESSION_FAILURES = [
  {
    kind: 'authentication',
    code: 'account-start-failed',
    diagnostic: { kind: 'authentication' },
    params: { reason: 'reauthentication-required' },
  },
  {
    kind: 'unexpected',
    code: 'account-not-live',
    diagnostic: { kind: 'unexpected' },
  },
  {
    kind: 'permission',
    code: 'invite-blocked',
    diagnostic: { kind: 'permission' },
  },
  {
    kind: 'unexpected',
    code: 'unsupported',
    diagnostic: { kind: 'unexpected' },
  },
  {
    kind: 'network',
    code: 'not-cancellable',
    diagnostic: { kind: 'network' },
  },
] satisfies EngineFailure[];

describe('engineFailureMessage', () => {
  it.each(SESSION_FAILURES)(
    '$code maps to the request-failed text for its kind',
    (failure) => {
      expect(engineFailureMessage(failure)).toBe(
        engineFailureMessage(requestFailed(failure.kind)),
      );
    },
  );

  it('words not-signed-in', () => {
    expect(engineFailureMessage(NOT_SIGNED_IN)).toBe('Not signed in.');
  });

  it('message-unavailable reads "Message not found."', () => {
    expect(
      engineFailureMessage({
        kind: 'unexpected',
        code: 'message-unavailable',
        diagnostic: { kind: 'unexpected' },
      }),
    ).toBe('Message not found.');
  });

  it('not-forwardable reads "This message cannot be forwarded."', () => {
    expect(
      engineFailureMessage({
        kind: 'unexpected',
        code: 'not-forwardable',
        diagnostic: { kind: 'unexpected' },
      }),
    ).toBe('This message cannot be forwarded.');
  });

  it('encryption-unavailable reads "Encryption is unavailable."', () => {
    expect(
      engineFailureMessage({
        kind: 'unexpected',
        code: 'encryption-unavailable',
        diagnostic: { kind: 'unexpected' },
      }),
    ).toBe('Encryption is unavailable.');
  });

  it.each<[DiscoveryFailureReason, string]>([
    ['invalid', 'Invalid homeserver discovery response'],
    [
      'generic-failure',
      'Failed to get autodiscovery configuration from server',
    ],
    ['invalid-hs-base-url', 'Invalid base_url for m.homeserver'],
    [
      'invalid-homeserver',
      'Homeserver URL does not appear to be a valid Matrix homeserver',
    ],
    [
      'unsupported-homeserver-spec-version',
      'The homeserver does not meet the version requirements',
    ],
    ['missing-wellknown', 'No .well-known JSON file found'],
    ['invalid-json', 'Invalid JSON'],
  ])('words the discovery reason %s like the SDK', (reason, text) => {
    expect(
      engineFailureMessage({
        kind: 'unexpected',
        code: 'discovery-failed',
        diagnostic: { kind: 'unexpected' },
        params: { domain: 'x.org', reason },
      }),
    ).toBe(text);
  });

  it.each([undefined, 'toString', 'something new'])(
    'names the domain when the discovery reason is %s',
    (reason) => {
      expect(
        engineFailureMessage({
          kind: 'unexpected',
          code: 'discovery-failed',
          diagnostic: { kind: 'unexpected' },
          params: {
            domain: 'x.org',
            ...(reason ? { reason: reason as DiscoveryFailureReason } : {}),
          },
        }),
      ).toBe('Could not discover a homeserver for "x.org".');
    },
  );

  it('words a 3 second rate limit like the raw error path', () => {
    expect(
      engineFailureMessage(requestFailed('rate-limit', { retryAfterMs: 3000 })),
    ).toBe('Too many requests. Try again in 3 seconds.');
  });

  it.each([
    ['authentication', 'Your session has expired. Sign in again.'],
    ['permission', 'You do not have permission to do that.'],
    ['rate-limit', 'Too many requests. Try again shortly.'],
    ['network', 'Check your connection and try again.'],
    ['timeout', 'The request timed out. Try again.'],
    ['server', 'The homeserver is unavailable. Try again.'],
    ['http', 'Something went wrong. Try again.'],
    ['unexpected', 'Something went wrong. Try again.'],
  ] as const)('words a %s request failure', (kind, text) => {
    expect(engineFailureMessage(requestFailed(kind))).toBe(text);
  });

  it('is plain data without a message key, for every code', () => {
    for (const failure of [
      NOT_SIGNED_IN,
      requestFailed('rate-limit', { retryAfterMs: 1000 }),
      {
        kind: 'unexpected',
        code: 'discovery-failed',
        diagnostic: { kind: 'unexpected' },
        params: { domain: 'x.org', reason: 'invalid' },
      },
      ...SESSION_FAILURES,
    ] satisfies EngineFailure[]) {
      expect(() => assertPlainData(failure)).not.toThrow();
      expect(failure).not.toHaveProperty('message');
    }
  });
});

describe('a token refresh failure through the engine', () => {
  const refreshText =
    'Your session could not be refreshed. Check your connection and try again.';
  const raw = Object.assign(new Error('refresh'), {
    name: 'TokenRefreshError',
  });
  const carried = describeMatrixRequestFailure(raw);
  const failure: EngineFailure = {
    kind: 'network',
    code: 'request-failed',
    diagnostic: { kind: 'network' },
    params: { cause: 'session-refresh' },
  };

  it('keeps its text under a caller fallback and in the table', () => {
    expect(carried.message).toBe(refreshText);
    expect(engineFailureMessage(failure)).toBe(refreshText);
    expect(
      describeMatrixRequestFailure(new EngineRequestError(failure), 'Fallback.')
        .message,
    ).toBe(refreshText);
  });
});

describe('a token refresh failure from the engine', () => {
  it('is worded from params.cause, not the diagnostic', () => {
    expect(
      engineFailureMessage({
        kind: 'network',
        code: 'request-failed',
        diagnostic: { kind: 'network' },
        params: { cause: 'session-refresh' },
      }),
    ).toBe(
      'Your session could not be refreshed. Check your connection and try again.',
    );
  });
});

describe('describeMatrixRequestFailure for an engine failure', () => {
  const unexpected = new EngineRequestError({
    kind: 'unexpected',
    code: 'discovery-failed',
    diagnostic: { kind: 'unexpected' },
    params: { domain: 'x' },
  });

  it('replaces the message of an unexpected failure with an operation fallback', () => {
    expect(describeMatrixRequestFailure(unexpected, 'Try again.')).toEqual({
      kind: 'unexpected',
      message: 'Try again.',
      diagnostic: { kind: 'unexpected' },
    });
  });

  it('words an unexpected failure from its code under the default fallback', () => {
    expect(describeMatrixRequestFailure(unexpected).message).toBe(
      'Could not discover a homeserver for "x".',
    );
  });

  it('applies an operation fallback to a plain HTTP failure', () => {
    expect(
      describeMatrixRequestFailure(
        new EngineRequestError(requestFailed('http', { httpStatus: 404 })),
        'Try again.',
      ),
    ).toEqual({
      kind: 'http',
      message: 'Try again.',
      diagnostic: { kind: 'http', httpStatus: 404 },
    });
  });

  it('words other kinds from the table, whatever the fallback', () => {
    expect(
      describeMatrixRequestFailure(
        new EngineRequestError(
          requestFailed('permission', { httpStatus: 403 }),
        ),
        'Try again.',
      ),
    ).toEqual({
      kind: 'permission',
      message: 'You do not have permission to do that.',
      diagnostic: { kind: 'permission', httpStatus: 403 },
    });
  });

  it('words a signed-out failure', () => {
    expect(
      describeMatrixRequestFailure(new EngineRequestError(NOT_SIGNED_IN))
        .message,
    ).toBe('Not signed in.');
  });
});

describe('plainEqual', () => {
  it('compares nested objects and arrays by value', () => {
    expect(
      plainEqual(
        { a: [1, { b: 'x' }], c: null },
        { c: null, a: [1, { b: 'x' }] },
      ),
    ).toBe(true);
  });

  it.each([
    [{ a: 1 }, { a: 2 }],
    [{ a: 1 }, { a: 1, b: 2 }],
    [
      [1, 2],
      [2, 1],
    ],
    [[], {}],
    [null, {}],
  ])('tells %j from %j', (a, b) => {
    expect(plainEqual(a, b)).toBe(false);
  });
});

describe('retryableFailure', () => {
  it.each([
    ['network', true],
    ['timeout', true],
    ['rate-limit', true],
    ['server', true],
    ['authentication', false],
    ['permission', false],
    ['http', false],
    ['unexpected', false],
  ] as const)('retryableFailure follows kind: %s is %s', (kind, retryable) => {
    expect(retryableFailure(requestFailed(kind))).toBe(retryable);
  });
});
