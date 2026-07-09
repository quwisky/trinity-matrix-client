import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import { AvatarComponent } from '@trinity/ui';
import { type MemberSummary } from '@trinity/data-access-rooms';
import { PresenceService } from '@trinity/data-access-profile';
import { type PresenceState } from '@trinity/util-matrix';

/** A member decorated with their live presence, for the presence-sorted list. */
interface MemberRow {
  readonly member: MemberSummary;
  readonly presence: PresenceState;
}

/** Sort order: online first, then away, then offline (stable within each group). */
const PRESENCE_RANK: Record<PresenceState, number> = {
  online: 0,
  unavailable: 1,
  offline: 2,
};

/** Discord member list (right column): joined members of the active room. */
@Component({
  selector: 'trn-member-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, NgIcon],
  viewProviders: [provideIcons({ lucideX })],
  templateUrl: './member-list.component.html',
  styleUrl: './member-list.component.scss',
})
export class MemberListComponent {
  private readonly presence = inject(PresenceService);

  readonly members = input<MemberSummary[]>([]);
  /** Hide the member list; the toolbar's members toggle reopens it. */
  readonly closed = output<void>();

  /**
   * Members decorated with live presence and ordered online-first. The incoming list is
   * already name-sorted, and the sort is stable, so members keep alphabetical order within
   * each presence group. Recomputes when membership OR any listed member's presence changes.
   */
  readonly rows = computed<MemberRow[]>(() =>
    this.members()
      .map((member) => ({
        member,
        presence: this.presence.presenceFor(member.userId)(),
      }))
      .sort((a, b) => PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence]),
  );

  /** How many members are online or away (i.e. not offline). */
  readonly onlineCount = computed(
    () => this.rows().filter((row) => row.presence !== 'offline').length,
  );
}
