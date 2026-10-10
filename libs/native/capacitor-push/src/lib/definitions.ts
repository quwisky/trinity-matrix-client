/** The name both hosts register the plugin under: iOS `jsName`, Android `@CapacitorPlugin`. */
export const PUSH_HANDOFF_PLUGIN_NAME = 'PushHandoff';

/** What the native push renderer needs to fetch one account's events. */
export interface PushHandoffAccount {
  readonly userId: string;
  readonly homeserverUrl: string;
  readonly accessToken: string;
  /** The account's "play a sound" notification preference. */
  readonly sound: boolean;
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
}
