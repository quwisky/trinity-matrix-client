import { InjectionToken } from '@angular/core';
import { isInstalledNativePlatform } from '../mobile-os';
import { isElectronRenderer } from '../trinity-desktop-bridge';

/** The Web Lock every Trinity tab of one origin competes for. */
export const SESSION_LOCK_NAME = 'trinity-session';

/** The channel a waiting tab asks the holder on; only the holder acts on it. */
export const SESSION_CHANNEL_NAME = 'trinity-session';

/** How long "Use here" waits for the lock before offering "Try again". */
export const SESSION_HANDOVER_TIMEOUT_MS = 15_000;

/** What the session lock is doing in this tab. */
export type SessionLockState =
  | 'acquiring'
  | 'held'
  | 'waiting'
  | 'taking-over'
  | 'handover-timed-out'
  | 'releasing'
  | 'unavailable'
  | 'not-required';

/** How this tab's first claim on the session ended. */
export type SessionLockAcquisition =
  'held' | 'waiting' | 'unavailable' | 'not-required';

/** What a waiting tab posts when the user chooses "Use here". */
export interface SessionHandoverRequest {
  readonly type: 'handover-request';
  readonly id: string;
}

/** The part of the Web Locks API (`navigator.locks`) the session lock uses. */
export interface SessionLocks {
  request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<void> | undefined,
  ): Promise<unknown>;
}

/** The part of `BroadcastChannel` the session lock uses. */
export interface SessionChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: SessionHandoverRequest): void;
  close(): void;
}

/** The browser's lock manager, or `null` where there is none (an insecure context). */
export const SESSION_LOCKS = new InjectionToken<SessionLocks | null>(
  'SESSION_LOCKS',
  { providedIn: 'root', factory: browserSessionLocks },
);

/**
 * Whether this host needs the lock: the web and the installed PWA do; the Electron shell
 * (single instance, one window) and the Capacitor apps (one activity, one scene) do not.
 */
export const SESSION_LOCK_REQUIRED = new InjectionToken<boolean>(
  'SESSION_LOCK_REQUIRED',
  {
    providedIn: 'root',
    factory: () => !isInstalledNativePlatform() && !isElectronRenderer(),
  },
);

/** Opens the `trinity-session` channel, or `null` where `BroadcastChannel` does not exist. */
export const SESSION_CHANNEL_FACTORY = new InjectionToken<
  () => SessionChannel | null
>('SESSION_CHANNEL_FACTORY', {
  providedIn: 'root',
  factory: () => browserSessionChannel,
});

function browserSessionLocks(): SessionLocks | null {
  if (typeof navigator === 'undefined') return null;
  // Typed as always there, but browsers expose it only in a secure context: plain HTTP on a
  // LAN address has no `navigator.locks`, and startup is then blocked.
  const locks: LockManager | undefined = navigator.locks;
  return locks ?? null;
}

function browserSessionChannel(): SessionChannel | null {
  return typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(SESSION_CHANNEL_NAME);
}
