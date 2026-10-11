import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Observable, defer, from, map, of } from 'rxjs';
import {
  PUSH_HANDOFF_PLUGIN_NAME,
  type PushHandoffAccount,
  type PushHandoffPlugin,
  type PushHandoffRoom,
} from './definitions';

const pushHandoff = registerPlugin<PushHandoffPlugin>(PUSH_HANDOFF_PLUGIN_NAME);

/**
 * The push handoff store the closed-app renderers read (Android `TrinityMessagingService`,
 * iOS `NotificationService` extension), written through this package's `PushHandoff` plugin,
 * which `cap sync` registers in the iOS and Android hosts. Inert everywhere else, including
 * the Electron shell.
 */
@Injectable({ providedIn: 'root' })
export class PushHandoffBridge {
  /** Whether this host has a native push handoff store. */
  readonly available =
    Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable(PUSH_HANDOFF_PLUGIN_NAME);

  /** Cold. Writes or replaces one account's credentials, token expiry and sound choice. */
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

  /**
   * Cold. Asks the OS to keep the app running in the background until
   * {@link endBackgroundWork}, and emits the id to end it with. iOS holds background time;
   * Android and hosts without the plugin hold nothing and emit 0. Errors when the native side
   * failed to answer.
   */
  beginBackgroundWork(): Observable<number> {
    return defer(() =>
      this.available
        ? from(pushHandoff.beginBackgroundWork()).pipe(map(({ id }) => id))
        : of(0),
    );
  }

  /** Cold. Ends what {@link beginBackgroundWork} began; an unknown or ended id is a no-op. */
  endBackgroundWork(id: number): Observable<void> {
    return this.call(() => pushHandoff.endBackgroundWork({ id }));
  }

  private call(command: () => Promise<void>): Observable<void> {
    return defer(() => (this.available ? from(command()) : of(void 0)));
  }
}
