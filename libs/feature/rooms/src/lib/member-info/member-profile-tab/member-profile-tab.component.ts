import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map, shareReplay, timer } from 'rxjs';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnBadge } from '@trinity/components/generic-content';
import { TrnToastService } from '@trinity/components/overlay';
import { type PresenceDetails } from '@trinity/data-access/identity';
import { type MemberSummary } from '@trinity/data-access/room-administration';
import { type UserSessions, type UserTrust } from '@trinity/data-access/trust';
import { relativeTimeLabel } from '../../shared/relative-time';
import { IdentityChangeActionsComponent } from '../../identity-change/identity-change-actions.component';

const PRESENCE_LABEL = {
  online: 'Online',
  unavailable: 'Away',
  offline: 'Offline',
} as const;

// Open cards share a minute tick so "Last seen" stays current; the last unmount releases it.
const clock = timer(60_000, 60_000).pipe(
  map(() => Date.now()),
  shareReplay({ bufferSize: 1, refCount: true }),
);

/** The member card's Profile tab: quick actions, then the Status, Global name and Sessions rows. */
@Component({
  selector: 'trn-member-profile-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IdentityChangeActionsComponent,
    TrnBadge,
    TrnButton,
    TrnIconComponent,
  ],
  templateUrl: './member-profile-tab.component.html',
})
export class MemberProfileTabComponent {
  private readonly toast = inject(TrnToastService);
  private readonly now = toSignal(clock, { initialValue: Date.now() });

  readonly member = input.required<MemberSummary>();
  readonly isSelf = input.required<boolean>();
  readonly trust = input.required<UserTrust | null>();
  readonly presence = input.required<PresenceDetails | null>();
  /** Null unless the person's global display name differs from their name in this room. */
  readonly globalName = input.required<string | null>();
  readonly showIdentityActions = input.required<boolean>();
  /** Null hides the Sessions row: no crypto, your own card, or another Account's card. */
  readonly sessions = input.required<UserSessions | null>();

  readonly messageUser = output<void>();
  readonly verify = output<void>();
  /** The clipboard refused the id; the host selects its user id handle for a manual copy. */
  readonly copyFailed = output<void>();
  /** The Sessions row opened: the moment a network read is allowed. */
  readonly sessionsOpened = output<void>();
  readonly sessionsRetried = output<void>();

  /** Follows the member, because a settings card shows the next person without being rebuilt. */
  readonly sessionsOpen = linkedSignal({
    source: () => this.member().userId,
    computation: () => false,
  });

  readonly sessionsCount = computed(() => {
    const sessions = this.sessions();
    if (sessions?.kind !== 'checked' && sessions?.kind !== 'unchecked') {
      return null;
    }
    const total = sessions.sessions.length;
    if (total === 0) return null;
    const count = total === 1 ? '1 session' : `${total} sessions`;
    return sessions.kind === 'checked' && sessions.notVerified > 0
      ? `${count} · ${sessions.notVerified} not verified`
      : count;
  });

  readonly canVerify = computed(
    () =>
      !this.isSelf() &&
      this.showIdentityActions() &&
      this.trust() === 'unverified',
  );

  /** A changed identity to answer in place of plain Verify, or null. */
  readonly identityChange = computed(() => {
    const trust = this.trust();
    if (this.isSelf() || !this.showIdentityActions()) return null;
    return trust === 'identity-changed' || trust === 'verified-identity-changed'
      ? {
          userId: this.member().userId,
          name: this.member().roomDisplayName,
          trust,
        }
      : null;
  });

  readonly status = computed(() => {
    const presence = this.presence();
    if (!presence) return null;
    const state =
      presence.state === 'offline' && presence.lastActiveAt !== null
        ? `Last seen ${relativeTimeLabel(presence.lastActiveAt, this.now())}`
        : PRESENCE_LABEL[presence.state];
    return presence.statusMessage
      ? `${state} · ${presence.statusMessage}`
      : state;
  });

  toggleSessions(): void {
    const open = !this.sessionsOpen();
    this.sessionsOpen.set(open);
    if (open) this.sessionsOpened.emit();
  }

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
