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

/** A joined room's display name as the SDK computes it, and whether it is a DM. */
export interface PushHandoffRoom {
  readonly roomId: string;
  readonly name: string;
  readonly direct: boolean;
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
   * the OS ends the time it granted. iOS only (`beginBackgroundTask`); Android holds nothing
   * and answers `id: 0`.
   */
  beginBackgroundWork(): Promise<{ id: number }>;
  /** Releases what `beginBackgroundWork` returned; an unknown or ended `id` is a no-op. */
  endBackgroundWork(options: { id: number }): Promise<void>;
}
