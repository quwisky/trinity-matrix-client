import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Observable, defer, from, map, of, throwError } from 'rxjs';
import {
  PUSH_HANDOFF_PLUGIN_NAME,
  type BackgroundWork,
  type NativeTokenRecord,
  type NativeTokenResult,
  type NativeTokenRevocation,
  type PushHandoffAccount,
  type PushHandoffNotificationText,
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
   * {@link endBackgroundWork}, and emits the id to end it with and whether protected data is
   * available and the device locking. iOS holds background time; Android and hosts without
   * the plugin hold nothing and emit id 0, available and not locking. Errors when the native
   * side failed to answer.
   */
  beginBackgroundWork(): Observable<BackgroundWork> {
    return defer(() =>
      this.available
        ? from(pushHandoff.beginBackgroundWork()).pipe(
            map(({ id, protectedDataAvailable, locking }): BackgroundWork => ({
              id,
              protectedDataAvailable: protectedDataAvailable !== false,
              locking: locking === true,
            })),
          )
        : of<BackgroundWork>({
            id: 0,
            protectedDataAvailable: true,
            locking: false,
          }),
    );
  }

  /** Cold. Ends what {@link beginBackgroundWork} began; an unknown or ended id is a no-op. */
  endBackgroundWork(id: number): Observable<void> {
    return this.call(() => pushHandoff.endBackgroundWork({ id }));
  }

  /** Cold. Writes the Notification text mirror the renderers read; inert off native. */
  setNotificationText(mode: PushHandoffNotificationText): Observable<void> {
    return this.call(() => pushHandoff.setNotificationText({ mode }));
  }

  /** Cold. Removes every delivered Trinity notification; inert off native. */
  clearDelivered(): Observable<void> {
    return this.call(() => pushHandoff.clearDelivered());
  }

  /**
   * Cold. Grants new tokens natively if the stored access token is still `tokenSeen`; answers
   * unavailable off native. Errors only when the native side failed to answer.
   */
  refreshTokens(
    userId: string,
    lineage: string,
    tokenSeen: string,
  ): Observable<NativeTokenResult> {
    return this.ask(
      () => pushHandoff.refreshTokens({ userId, lineage, tokenSeen }),
      { kind: 'unavailable' },
    );
  }

  /** Cold. Reads the stored access token; answers unavailable off native. */
  currentTokens(
    userId: string,
    lineage: string,
  ): Observable<NativeTokenResult> {
    return this.ask(() => pushHandoff.currentTokens({ userId, lineage }), {
      kind: 'unavailable',
    });
  }

  /** Cold. Emits whether the native vault holds the record; false off native. */
  migrateTokens(record: NativeTokenRecord): Observable<boolean> {
    return this.ask(
      async () =>
        (await pushHandoff.migrateTokens({ ...record })).stored === true,
      false,
    );
  }

  /** Cold. Revokes the account's tokens at the provider; answers gone off native. */
  revokeTokens(
    userId: string,
    lineage: string,
  ): Observable<NativeTokenRevocation> {
    return this.ask(() => pushHandoff.revokeTokens({ userId, lineage }), {
      kind: 'gone',
    });
  }

  /**
   * Cold. Removes one account's tokens; inert off native. Errors on any host for an empty or
   * non-string id, which must never reach native as a wipe.
   */
  removeTokens(userId: string): Observable<void> {
    return typeof userId === 'string' && userId !== ''
      ? this.call(() => pushHandoff.removeTokens({ userId }))
      : throwError(() => new Error('removeTokens needs a user id'));
  }

  /** Cold. Removes every account's tokens; inert off native. */
  removeAllTokens(): Observable<void> {
    return this.call(() => pushHandoff.removeTokens({ all: true }));
  }

  /**
   * Cold. Removes every account's tokens but the listed ones', and emits how many went; an empty
   * list removes them all. Emits 0 off native. Errors on any host unless given a list of user ids.
   */
  removeTokensExcept(
    userIds: readonly string[],
  ): Observable<{ readonly removed: number }> {
    return Array.isArray(userIds) &&
      userIds.every((id) => typeof id === 'string' && id !== '')
      ? this.ask(
          () => pushHandoff.removeTokensExcept({ userIds: [...userIds] }),
          { removed: 0 },
        )
      : throwError(
          () => new Error('removeTokensExcept needs a list of user ids'),
        );
  }

  private call(command: () => Promise<void>): Observable<void> {
    return this.ask(command, void 0);
  }

  private ask<T>(command: () => Promise<T>, inert: T): Observable<T> {
    return defer(() => (this.available ? from(command()) : of(inert)));
  }
}
