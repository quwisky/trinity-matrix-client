/** The name both hosts register the plugin under: iOS `jsName`, Android `@CapacitorPlugin`. */
export const PUSH_HANDOFF_PLUGIN_NAME = 'PushHandoff';

/** What the native push renderer needs to fetch one account's events. */
export interface PushHandoffAccount {
  readonly userId: string;
  readonly homeserverUrl: string;
  readonly accessToken: string;
  /** The account's "play a sound" notification preference. */
  readonly sound: boolean;
  /**
   * When `accessToken` stops working (epoch ms), for an OAuth account whose server gave the
   * token a lifetime; absent when it does not expire on a schedule. Once it has passed, the
   * renderers read nothing and show the expired-token text. Not secret; it still never goes
   * to a log.
   */
  readonly accessTokenExpiresAt?: number;
}

/**
 * A joined room's display name as the SDK computes it, whether it is a DM, and whether it
 * counts as encrypted. The renderers show unencrypted text only for a room stored with
 * `encrypted: false`.
 */
export interface PushHandoffRoom {
  readonly roomId: string;
  readonly name: string;
  readonly direct: boolean;
  readonly encrypted: boolean;
}

/** Background run time the OS granted, and whether a token refresh begun now can be saved. */
export interface BackgroundWork {
  /** What to pass to `endBackgroundWork`. */
  readonly id: number;
  /**
   * Whether data protected until the device locks (the session's keychain items on iOS) can
   * be read and written now. iOS reads `isProtectedDataAvailable`; other hosts are always
   * available.
   */
  readonly protectedDataAvailable: boolean;
  /**
   * Whether the device is locking: iOS announced, within the last 10 s and without unlocking
   * since, that protected data is about to become unavailable, which it does about 10 s
   * after the lock. Other hosts never lock it away.
   */
  readonly locking: boolean;
}

/** The native plugin's calls. Debug iOS builds add `renderProbe`, which only the e2e suite calls. */
export interface PushHandoffPlugin {
  setAccount(options: PushHandoffAccount): Promise<void>;
  /** Upserts the given rooms for the account; rooms not listed keep their entries. */
  setRooms(options: {
    userId: string;
    rooms: PushHandoffRoom[];
  }): Promise<void>;
  removeAccount(options: { userId: string }): Promise<void>;
  clear(): Promise<void>;
  /** Removes the account's delivered notifications for one room. */
  clearRoom(options: { userId: string; roomId: string }): Promise<void>;
  /**
   * Whether the host can request a push token: Android only when Firebase is
   * configured (`register()` would crash the app otherwise); iOS always.
   */
  registrationAvailable(): Promise<{ value: boolean }>;
  /**
   * Asks the OS to keep the app running in the background until `endBackgroundWork`, or until
   * the OS ends the time it granted, and reports whether protected data is available and
   * whether the device is locking. iOS only (`beginBackgroundTask`); Android holds nothing
   * and answers `id: 0`, available and not locking. A host that predates the protected-data
   * fields omits them, which reads as available and not locking.
   */
  beginBackgroundWork(): Promise<{
    id: number;
    protectedDataAvailable?: boolean;
    locking?: boolean;
  }>;
  /** Releases what `beginBackgroundWork` returned; an unknown or ended `id` is a no-op. */
  endBackgroundWork(options: { id: number }): Promise<void>;
  /**
   * Mirrors App lock's effective Notification text for the closed-app renderers; rejects a
   * mode it doesn't know. The full reset's `clear` removes it (a missing mirror reads Show).
   */
  setNotificationText(options: {
    mode: PushHandoffNotificationText;
  }): Promise<void>;
  /** Removes every notification Trinity delivered (the text became more private). */
  clearDelivered(): Promise<void>;
}

/** App lock's Notification text, as the renderers read it. */
export type PushHandoffNotificationText =
  'show' | 'hide-on-lock-screen' | 'always-hide';
