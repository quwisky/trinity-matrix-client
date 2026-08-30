import { describe, expect, it } from 'vitest';
import {
  IdentityOperationError,
  identityNotReady,
  identityOperationFailure,
} from './identity-operation-error';

describe('IdentityOperationError', () => {
  it('classifies network failures as retryable offline failures', () => {
    expect(
      identityOperationFailure('lookup-user', new TypeError('fetch failed')),
    ).toMatchObject({
      operation: 'lookup-user',
      kind: 'offline',
      recovery: 'retry',
    });
  });

  it('classifies unsupported homeserver operations as unavailable', () => {
    expect(
      identityOperationFailure('set-presence', {
        errcode: 'M_UNRECOGNIZED',
      }),
    ).toMatchObject({
      operation: 'set-presence',
      kind: 'unavailable',
      recovery: 'none',
    });
  });

  it('classifies other homeserver failures without retaining their payload', () => {
    const failure = identityOperationFailure('set-avatar', {
      errcode: 'M_FORBIDDEN',
      access_token: 'secret',
    });

    expect(failure).toMatchObject({
      operation: 'set-avatar',
      kind: 'server-failure',
      recovery: 'retry',
    });
    expect(failure).toBeInstanceOf(IdentityOperationError);
    expect(failure).not.toHaveProperty('cause');
    expect(JSON.stringify(failure)).not.toContain('secret');
  });

  it('represents an absent active Account as a typed not-ready failure', () => {
    expect(identityNotReady('load-own-profile')).toMatchObject({
      operation: 'load-own-profile',
      kind: 'not-ready',
      recovery: 'retry',
    });
  });
});
