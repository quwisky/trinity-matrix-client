import { Injectable, inject, signal } from '@angular/core';
import { ClientEvent } from 'matrix-js-sdk';
import { projectFromClient } from '@trinity/data-access/matrix-client';
import { Observable, defer, from, map, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { migratedAccountDataContent } from './js-sdk/legacy-account-data';

/**
 * Account-data type holding the global "play a sound" preference.
 *
 * Cast at the call sites: the SDK types account-data keys as a closed union that excludes
 * client-namespaced types.
 */
export const NOTIFICATION_SOUND_EVENT =
  'dev.trinityproject.trinity.notification_sound';
/** Retired name; read while only it exists; `NotificationService` copies it to {@link NOTIFICATION_SOUND_EVENT}. */
export const LEGACY_NOTIFICATION_SOUND_EVENT =
  'eu.qwky.trinity.notification_sound';

/** Sound is on unless the account says otherwise — the Matrix default is audible. */
const DEFAULT_ON = true;

/**
 * The single global "play a sound" preference.
 *
 * Stored in ACCOUNT DATA, not in the push rules, because toggling the rules' `sound` tweak
 * (as observed on Synapse 1.119):
 *
 *  - does not silence the phone. Trinity registers its pusher with `format: 'event_id_only'`
 *    to keep message content off the gateway, and Synapse blanks the tweaks for that format
 *    before dispatching, so a `sound` tweak never reaches Sygnal.
 *  - HARMS the phone. Synapse marks a push `high` priority only when the event is encrypted
 *    or carries a truthy `highlight` or `sound` tweak. `.m.rule.call`,
 *    `.m.rule.invite_for_me` and `.m.rule.room_one_to_one` ship `highlight: false`, so
 *    removing their sound tweak demotes call and invite pushes to LOW priority.
 *  - can destroy a deliberate choice. Element models "notify without a sound" as a rule
 *    with `notify` and no sound tweak, indistinguishable from one this switch silenced;
 *    turning the switch back on would force a sound onto it.
 *
 * Account data keeps the choice following the account to other Trinity installs without
 * rewriting rules configured elsewhere. Element cannot see this switch, and the sound a
 * PHONE makes for a pushed notification is chosen by the phone either way.
 *
 * The preference is applied by passing `silent` on every notification Trinity raises itself:
 * the Web constructor, the service-worker registration, and the Electron main process (which
 * builds a native notification and never sees `NotificationOptions`).
 */
@Injectable({ providedIn: 'root' })
export class NotificationSoundService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _enabled = signal(DEFAULT_ON);
  /**
   * The preference as a signal, for the settings UI.
   *
   * A one-shot read at init is not enough: on a cold load the settings page can render
   * BEFORE the initial sync delivers account data. This tracks `ClientEvent.AccountData`, so
   * a late value (or a change on another device) lands without a reload.
   */
  readonly enabled = this._enabled.asReadonly();

  private readonly onAccountData = (): void => {
    this._enabled.set(this.isOn());
  };

  private readonly projection = projectFromClient({
    id: 'notifications.sound',
    matrix: this.matrix,
    rebuild: () => this._enabled.set(this.isOn()),
    bind: (client) => client.on(ClientEvent.AccountData, this.onAccountData),
    unbind: (client) => client.off(ClientEvent.AccountData, this.onAccountData),
  });

  /** Track the account's preference; pair with {@link disconnect}. */
  connect(): void {
    this.projection.connect();
  }

  disconnect(): void {
    this.projection.disconnect();
  }

  /**
   * Whether notifications for `userId` may make a sound.
   *
   * Takes the OWNING account: notifications are raised for non-active accounts too and the
   * preference is per-account, so reading `matrix.instance` would apply the foreground
   * account's choice to every account.
   *
   * Reads the LOCAL account-data store, which sync keeps current. Optional all the way down
   * because this runs while BUILDING a notification: a throw would stop the notification
   * appearing. Unknown state degrades to the default.
   */
  isOn(userId?: string): boolean {
    if (!this.matrix.isInitialized) {
      return DEFAULT_ON;
    }
    const client = userId
      ? this.matrix.clientFor(userId)
      : this.matrix.instance;
    const content = migratedAccountDataContent(
      client as never,
      NOTIFICATION_SOUND_EVENT,
      LEGACY_NOTIFICATION_SOUND_EVENT,
    ) as { enabled?: unknown } | undefined;
    return typeof content?.enabled === 'boolean' ? content.enabled : DEFAULT_ON;
  }

  /**
   * Persist the preference to account data. Cold: runs on subscribe.
   *
   * `setAccountData` rather than `setAccountDataRaw`: it retries, and it short-circuits when
   * the local store already deep-equals the new content, which is right for a toggle.
   */
  setOn(on: boolean): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.matrix.instance.setAccountData(
          NOTIFICATION_SOUND_EVENT as never,
          { enabled: on } as never,
        ),
      ).pipe(
        map(() => {
          // Reflect it now rather than waiting for the account-data echo.
          this._enabled.set(on);
        }),
      );
    });
  }
}
