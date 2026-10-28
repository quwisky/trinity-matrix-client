import { Injectable, computed, inject } from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { unwrapEngineResult } from '@trinity/util/matrix';
import { Observable, defer, map, throwError } from 'rxjs';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import { NotificationSettingsStore } from './notification-settings.store';

/**
 * The single global "play a sound" preference, per account.
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
  private readonly engine = inject(NOTIFICATION_ENGINE);
  private readonly store = inject(NotificationSettingsStore);
  private readonly session = inject(SessionStateService);

  /**
   * The active account's preference as a signal, for the settings UI. It follows the warm
   * settings store, so a late value (or a change on another device) lands without a reload.
   */
  readonly enabled = computed(() => this.isOn());

  /**
   * Whether notifications for `userId` (else the active account) may make a sound.
   *
   * Takes the OWNING account: notifications are raised for non-active accounts too and the
   * preference is per-account. Never throws, because this runs while BUILDING a
   * notification; an account without settings reads the default, on.
   */
  isOn(userId?: string): boolean {
    const owner = userId ?? this.session.activeAccountId();
    return owner ? this.store.settings(owner).sound : true;
  }

  /** Persist the active account's preference to account data. Cold: runs on subscribe. */
  setOn(on: boolean): Observable<void> {
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) {
        return throwError(() => new Error('Not signed in.'));
      }
      return this.engine.setPreference(accountId, 'sound', on).pipe(
        unwrapEngineResult<null>(),
        map(() => undefined),
      );
    });
  }
}
