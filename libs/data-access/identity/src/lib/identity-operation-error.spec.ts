import { describe, expect, it } from 'vitest';
import { EngineRequestError, type EngineFailure } from '@trinity/util/matrix';
import {
  IdentityOperationError,
  identityNotReady,
  identityOperationFailure,
} from './identity-operation-error';

const requestFailed = (
  diagnostic: EngineFailure['diagnostic'],
): EngineRequestError =>
  new EngineRequestError({
    kind: diagnostic.kind,
    code: 'request-failed',
    diagnostic,
  });

describe('IdentityOperationError', () => {
  it('classifies an unreached server as a retryable offline failure', () => {
    expect(
      identityOperationFailure(
        'lookup-user',
        requestFailed({ kind: 'network', errorName: 'ConnectionError' }),
      ),
    ).toMatchObject({
      operation: 'lookup-user',
      kind: 'offline',
      recovery: 'retry',
      message:
        'Identity information is unavailable while this device is offline.',
    });
  });

  it('keeps a failed token refresh a retryable server failure, not offline', () => {
    expect(
      identityOperationFailure(
        'load-own-profile',
        new EngineRequestError({
          kind: 'network',
          code: 'request-failed',
          diagnostic: { kind: 'network', errorName: 'TokenRefreshError' },
          params: { cause: 'session-refresh' },
        }),
      ),
    ).toMatchObject({ kind: 'server-failure', recovery: 'retry' });
  });

  it('keeps a timed-out request a retryable server failure, not offline', () => {
    expect(
      identityOperationFailure(
        'set-display-name',
        requestFailed({ kind: 'timeout', errorName: 'TimeoutError' }),
      ),
    ).toMatchObject({ kind: 'server-failure', recovery: 'retry' });
  });

  it('classifies unsupported homeserver operations as unavailable', () => {
    expect(
      identityOperationFailure(
        'set-presence',
        requestFailed({
          kind: 'http',
          httpStatus: 400,
          errcode: 'M_UNRECOGNIZED',
        }),
      ),
    ).toMatchObject({
      operation: 'set-presence',
      kind: 'unavailable',
      recovery: 'none',
    });
  });

  it('classifies other homeserver failures without retaining the engine failure', () => {
    const failure = identityOperationFailure(
      'set-avatar',
      requestFailed({
        kind: 'permission',
        httpStatus: 403,
        errcode: 'M_FORBIDDEN',
      }),
    );

    expect(failure).toMatchObject({
      operation: 'set-avatar',
      kind: 'server-failure',
      recovery: 'retry',
    });
    expect(failure).toBeInstanceOf(IdentityOperationError);
    expect(failure).not.toHaveProperty('cause');
    expect(JSON.stringify(failure)).not.toContain('M_FORBIDDEN');
  });

  it('classifies an account without a live client as not ready', () => {
    expect(
      identityOperationFailure(
        'ignore-user',
        new EngineRequestError({
          kind: 'unexpected',
          code: 'account-not-live',
          diagnostic: { kind: 'unexpected' },
        }),
      ),
    ).toMatchObject({
      operation: 'ignore-user',
      kind: 'not-ready',
      recovery: 'retry',
    });
  });

  it('represents an absent active Account as a typed not-ready failure', () => {
    expect(identityNotReady('load-own-profile')).toMatchObject({
      operation: 'load-own-profile',
      kind: 'not-ready',
      recovery: 'retry',
    });
  });
});
