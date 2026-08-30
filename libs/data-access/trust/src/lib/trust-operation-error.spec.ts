import {
  UiaAttemptsExceededError,
  UiaCancelledError,
  UiaUnsupportedError,
} from '@trinity/util/matrix';
import { describe, expect, it } from 'vitest';
import {
  TrustOperationError,
  trustOperationFailure,
} from './trust-operation-error';

describe('trustOperationFailure', () => {
  it.each([
    [new UiaCancelledError(), 'cancelled', 'none'],
    [new UiaUnsupportedError(), 'provider-action-required', 'open-provider'],
    [new UiaAttemptsExceededError(), 'permission-denied', 'retry'],
  ] as const)(
    'normalizes an expected UIA refusal without retaining its cause',
    (cause, kind, recovery) => {
      const failure = trustOperationFailure('setup', cause);

      expect(failure).toMatchObject({
        operation: 'setup',
        kind,
        recovery,
      });
      expect(failure).not.toHaveProperty('cause');
    },
  );

  it('replaces arbitrary SDK details with secret-safe metadata', () => {
    const sensitive = 'secret=EsT-should-never-survive';

    const failure = trustOperationFailure(
      'recover',
      new Error(`homeserver response ${sensitive}`),
    );

    expect(failure).toBeInstanceOf(TrustOperationError);
    expect(failure).toMatchObject({
      operation: 'recover',
      kind: 'server-failure',
      recovery: 'retry',
    });
    expect(JSON.stringify(failure)).not.toContain(sensitive);
    expect(failure.message).not.toContain(sensitive);
  });

  it('marks an irreversible tail failure as a partial update', () => {
    const failure = trustOperationFailure(
      'reset-recovery',
      new Error('internal detail'),
      true,
    );

    expect(failure).toMatchObject({
      operation: 'reset-recovery',
      kind: 'partial-update',
      recovery: 'review-security-settings',
      partial: true,
    });
  });

  it('reports the public command operation instead of an internal helper operation', () => {
    const internal = new TrustOperationError(
      'start-verification',
      'stale-state',
      'retry',
      'The request changed.',
    );

    const failure = trustOperationFailure('accept-verification', internal);

    expect(failure).toMatchObject({
      operation: 'accept-verification',
      kind: 'stale-state',
      recovery: 'retry',
    });
  });
});
