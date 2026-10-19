import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnToastService } from '@trinity/components/overlay';
import { type PresenceDetails } from '@trinity/data-access/identity';
import { type MemberSummary } from '@trinity/data-access/room-administration';
import { type UserTrust } from '@trinity/data-access/trust';
import { relativeTimeLabel } from '../../shared/relative-time';

const PRESENCE_LABEL = {
  online: 'Online',
  unavailable: 'Away',
  offline: 'Offline',
} as const;

/** The member card's Profile tab: quick actions, then the Status and Global name rows. */
@Component({
  selector: 'trn-member-profile-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnIconComponent],
  templateUrl: './member-profile-tab.component.html',
})
export class MemberProfileTabComponent {
  private readonly toast = inject(TrnToastService);

  readonly member = input.required<MemberSummary>();
  readonly isSelf = input.required<boolean>();
  readonly trust = input.required<UserTrust | null>();
  readonly presence = input.required<PresenceDetails | null>();
  /** Null unless the person's global display name differs from their name in this room. */
  readonly globalName = input.required<string | null>();
  readonly showIdentityActions = input.required<boolean>();

  readonly messageUser = output<void>();
  readonly verify = output<void>();
  /** The clipboard refused the id; the host selects its user id handle for a manual copy. */
  readonly copyFailed = output<void>();

  readonly canVerify = computed(
    () =>
      !this.isSelf() &&
      this.showIdentityActions() &&
      this.trust() !== 'verified',
  );

  readonly status = computed(() => {
    const presence = this.presence();
    if (!presence) return null;
    // shortcut: the relative time is fixed when presence changes; add a clock if it must tick.
    const state =
      presence.state === 'offline' && presence.lastActiveAt !== null
        ? `Last seen ${relativeTimeLabel(presence.lastActiveAt, Date.now())}`
        : PRESENCE_LABEL[presence.state];
    return presence.statusMessage
      ? `${state} · ${presence.statusMessage}`
      : state;
  });

  /**
   * Copy the member's user id, confirming with a toast only once the write has resolved:
   * a rejected write (denied permission, non-secure context) must not be reported as success.
   */
  copyId(): void {
    const value = this.member().userId;
    let write: Promise<void>;
    try {
      const clipboard = navigator.clipboard;
      write =
        typeof clipboard?.writeText === 'function'
          ? clipboard.writeText(value)
          : Promise.reject(new Error('Clipboard API unavailable'));
    } catch (error) {
      write = Promise.reject(error);
    }
    void write.then(
      () => this.toast.show('User ID copied.', { duration: 2000 }),
      () => {
        this.copyFailed.emit();
        this.toast.show(
          'Could not copy the user ID. It is selected above; copy it manually.',
          { duration: 5000, variant: 'danger' },
        );
      },
    );
  }
}
