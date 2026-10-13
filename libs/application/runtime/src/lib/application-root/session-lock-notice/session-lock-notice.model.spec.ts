import type { SessionLockState } from '@trinity/platform-native';
import { describe, expect, it } from 'vitest';
import type { ApplicationRuntimeState } from '../../application-runtime.models';
import {
  sessionLockNotice,
  type SessionLockNotice,
} from './session-lock-notice.model';

const waiting: ApplicationRuntimeState = {
  phase: 'waiting-for-session',
  attempt: 1,
  settlements: [],
};

describe('sessionLockNotice', () => {
  it.each<[SessionLockState, SessionLockNotice]>([
    ['waiting', 'waiting'],
    ['taking-over', 'taking-over'],
    ['handover-timed-out', 'handover-timed-out'],
    ['unavailable', 'unavailable'],
    ['acquiring', 'waiting'],
    ['held', 'waiting'],
    ['releasing', 'waiting'],
    ['not-required', 'waiting'],
  ])('shows a waiting tab whose lock is %s as %s', (lock, notice) => {
    expect(sessionLockNotice(waiting, lock)).toBe(notice);
  });

  it('shows the secure-connection notice for a startup blocked on the session lock', () => {
    expect(
      sessionLockNotice(
        {
          phase: 'blocked',
          attempt: 1,
          settlements: [],
          failure: {
            stage: 'session-lock',
            recovery: 'retry-startup',
            diagnostic: { code: 'session-lock-unavailable' },
          },
        },
        'unavailable',
      ),
    ).toBe('unavailable');
  });

  it.each<ApplicationRuntimeState>([
    { phase: 'stopped' },
    { phase: 'starting', attempt: 1, stage: 'session-lock', settlements: [] },
    { phase: 'ready', attempt: 1, settlements: [] },
    { phase: 'stopping', attempt: 1 },
    {
      phase: 'blocked',
      attempt: 1,
      settlements: [],
      failure: {
        stage: 'account-restoration',
        recovery: 'reauthenticate',
        diagnostic: { code: 'active-account-unavailable' },
      },
    },
  ])('shows no notice in phase $phase', (state) => {
    expect(sessionLockNotice(state, 'held')).toBeNull();
  });
});
