import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Observable, defer, from, map, of } from 'rxjs';

const PLUGIN_NAME = 'PushHandoff';

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

interface PushHandoffPlugin {
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

const pushHandoff = registerPlugin<PushHandoffPlugin>(PLUGIN_NAME);

/**
 * The push handoff store the closed-app renderers read (Android `TrinityMessagingService`,
 * iOS `NotificationService` extension), written through the local `PushHandoff` plugin in
 * the iOS and Android hosts. Inert everywhere else, including the Electron shell.
 */
@Injectable({ providedIn: 'root' })
export class PushHandoffBridge {
  /** Whether this host has a native push handoff store. */
  readonly available =
    Capacitor.isNativePlatform() && Capacitor.isPluginAvailable(PLUGIN_NAME);

  /** Cold. Writes or replaces one account's credentials and sound choice. */
  setAccount(account: PushHandoffAccount): Observable<void> {
    return this.call(() => pushHandoff.setAccount({ ...account }));
  }

  /** Cold. Upserts room names and DM flags for one account. */
  setRooms(
    userId: string,
    rooms: readonly PushHandoffRoom[],
  ): Observable<void> {
    return this.call(() =>
      pushHandoff.setRooms({
        userId,
        rooms: rooms.map((room) => ({ ...room })),
      }),
    );
  }

  /** Cold. Deletes one account and its rooms. */
  removeAccount(userId: string): Observable<void> {
    return this.call(() => pushHandoff.removeAccount({ userId }));
  }

  /** Cold. Empties the store. */
  clear(): Observable<void> {
    return this.call(() => pushHandoff.clear());
  }

  /** Cold. Removes one account's delivered notifications for a room. */
  clearRoom(userId: string, roomId: string): Observable<void> {
    return this.call(() => pushHandoff.clearRoom({ userId, roomId }));
  }

  /**
   * Cold. Whether this host can request a push token; false without the plugin. Errors
   * when the native side failed to answer.
   */
  registrationAvailable(): Observable<boolean> {
    return defer(() =>
      this.available
        ? from(pushHandoff.registrationAvailable()).pipe(
            map(({ value }) => value === true),
          )
        : of(false),
    );
  }

  private call(command: () => Promise<void>): Observable<void> {
    return defer(() => (this.available ? from(command()) : of(void 0)));
  }
}
