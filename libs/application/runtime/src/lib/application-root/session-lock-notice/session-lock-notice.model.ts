import type { SessionLockState } from '@trinity/platform-native';
import {
  SESSION_LOCK_UNAVAILABLE_CODE,
  type ApplicationRuntimeState,
} from '../../application-runtime.models';

/** The full-page notice a tab that does not run Trinity shows. */
export type SessionLockNotice =
  'waiting' | 'taking-over' | 'handover-timed-out' | 'unavailable';

/** Which notice the root shows, or `null` when this tab runs (or is starting) Trinity. */
export function sessionLockNotice(
  runtime: ApplicationRuntimeState,
  lock: SessionLockState,
): SessionLockNotice | null {
  switch (runtime.phase) {
    case 'waiting-for-session':
      return waitingNotice(lock);
    case 'blocked':
      return runtime.failure.diagnostic.code === SESSION_LOCK_UNAVAILABLE_CODE
        ? 'unavailable'
        : null;
    case 'stopped':
    case 'starting':
    case 'ready':
    case 'stopping':
      return null;
    default: {
      const unhandled: never = runtime;
      void unhandled;
      return null;
    }
  }
}

function waitingNotice(lock: SessionLockState): SessionLockNotice {
  switch (lock) {
    case 'taking-over':
      return 'taking-over';
    case 'handover-timed-out':
      return 'handover-timed-out';
    case 'unavailable':
      return 'unavailable';
    case 'waiting':
    case 'acquiring':
    case 'held':
    case 'releasing':
    case 'not-required':
      // `held` only flashes here between a grant and startup resuming.
      return 'waiting';
    default: {
      const unhandled: never = lock;
      void unhandled;
      return 'waiting';
    }
  }
}
