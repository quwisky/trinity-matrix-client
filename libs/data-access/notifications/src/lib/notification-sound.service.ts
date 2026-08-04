import { Injectable, inject, signal } from '@angular/core';
import { ClientEvent } from 'matrix-js-sdk';
import { projectFromClient } from '@trinity/data-access/matrix-client';
import { Observable, defer, from, map, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/**
 * Account-data type holding the global "play a sound" preference.
 *
 * Cast at the call sites because the SDK types account-data keys as a closed union of the
 * events it knows about; a client-namespaced type is by definition not in it.
 */
export const NOTIFICATION_SOUND_EVENT = 'eu.qwky.trinity.notification_sound';

/** Sound is on unless the account says otherwise — the Matrix default is audible. */
const DEFAULT_ON = true;

/**
 * The single global "play a sound" preference.
 *
 * Stored in ACCOUNT DATA, not in the push rules. The push-rule route was built first and
 * then measured against Synapse 1.119, where it turned out to cost more than it delivered:
 *
 *  - It does not silence the phone. Trinity registers its pusher with
 *    `format: 'event_id_only'` to keep message content off the gateway, and Synapse
 *    explicitly blanks the tweaks for that format before dispatching — so a `sound` tweak
 *    never reaches Sygnal at all.
 *  - It actively HARMS the phone. Synapse marks a push `high` priority only when the event
 *    is encrypted or carries a truthy `highlight` or `sound` tweak. `.m.rule.call`,
 *    `.m.rule.invite_for_me` and `.m.rule.room_one_to_one` all ship `highlight: false`
 *    (verified on the live server), so removing their sound tweak demotes call and invite
 *    pushes to LOW priority — delaying exactly the notifications that are urgent.
 *  - It can destroy a deliberate choice. Element models "notify without a sound" as a rule
 *    carrying `notify` and no sound tweak, which is indistinguishable from one this switch
 *    silenced; turning the switch back on would force a sound onto it.
 *
 * Account data keeps the good half — the choice still follows the account to Trinity on
 * another machine — without rewriting rules the user may have configured elsewhere. What is
 * given up is that Element cannot see this particular switch; and the sound a PHONE makes
 * for a pushed notification is chosen by the phone either way.
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
   * A one-shot read at component init is not enough: on a cold load the settings page can
   * render BEFORE the initial sync has delivered account data, so the switch would show the
   * default and never correct itself — which is exactly what the e2e caught. This tracks
   * `ClientEvent.AccountData`, so a value arriving late (or changed on another device) lands
   * without a reload.
   */
  readonly enabled = this._enabled.asReadonly();

  private readonly onAccountData = (): void => this._enabled.set(this.isOn());

  private readonly projection = projectFromClient({
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
   * Whether notifications may make a sound.
   *
   * Read from the LOCAL account-data store, which sync keeps current — so a change made on
   * another device lands here without a round trip. Optional all the way down because this
   * is called while BUILDING a notification: a throw would not surface as a broken setting,
   * it would stop the notification appearing at all. Unknown state degrades to the default.
   */
  isOn(): boolean {
    if (!this.matrix.isInitialized) {
      return DEFAULT_ON;
    }
    const content = this.matrix.instance
      ?.getAccountData?.(NOTIFICATION_SOUND_EVENT as never)
      ?.getContent?.() as { enabled?: unknown } | undefined;
    return typeof content?.enabled === 'boolean' ? content.enabled : DEFAULT_ON;
  }

  /**
   * Persist the preference to account data. Cold — runs on subscribe.
   *
   * `setAccountData` rather than `setAccountDataRaw`: it retries, and its one quirk — it
   * short-circuits when the local store already deep-equals the new content — is exactly
   * right for a toggle, where "already in that state" means there is nothing to write.
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
          // The local store is updated by the echo, but reflect it now so the UI does not
          // depend on a round trip it does not need.
          this._enabled.set(on);
        }),
      );
    });
  }
}
