import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  RoomActionPermissionsService,
  type ActionAvailability,
  type BannedMember,
  RoomMembersService,
  RoomModerationService,
} from '@trinity/data-access/room-administration';
import { filter } from 'rxjs';

/**
 * A Room or Space's banned members, with an Unban action where exact live authority permits.
 * The list is a live Room Administration projection and changes only when authoritative
 * Matrix room state does.
 */
@Component({
  selector: 'trn-banned-members',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './banned-members.component.html',
  imports: [TrnButton, TrnTooltip],
})
export class BannedMembersComponent {
  readonly accountId = input<string | null>(null);
  readonly roomId = input.required<string>();
  readonly targetName = input('this Room');
  readonly noun = input<'Room' | 'Space'>('Room');
  readonly bannedMembers = input<readonly BannedMember[] | null>(null);
  readonly exactAvailability = input<'available' | 'unavailable'>('available');

  private readonly moderation = inject(RoomModerationService);
  private readonly members = inject(RoomMembersService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** The current or explicitly stale ban-list presentation for this Room. */
  readonly target = computed(() => {
    const accountId = this.accountId();
    return accountId ? { accountId, roomId: this.roomId() } : this.roomId();
  });
  readonly view = computed(() => {
    const exact = this.bannedMembers();
    return exact
      ? {
          availability:
            this.exactAvailability() === 'available'
              ? ('coherent' as const)
              : ('unavailable' as const),
          current: this.exactAvailability() === 'available' ? exact : null,
          stale: this.exactAvailability() === 'available' ? null : exact,
        }
      : this.members.bannedView(this.roomId());
  });
  readonly banned = computed(() => {
    const view = this.view();
    return view.current ?? view.stale ?? [];
  });
  /** User IDs whose unban is in flight (disables that row's button). */
  private readonly pending = signal<ReadonlySet<string>>(new Set());

  readonly isEmpty = computed(
    () => this.view().availability === 'coherent' && this.banned().length === 0,
  );

  /** Release an accepted unban's pending marker once its sync echo removes the row. */
  private readonly _reconcilePending = effect(() => {
    const bannedIds = new Set(this.banned().map((member) => member.userId));
    untracked(() => {
      const current = this.pending();
      const next = new Set([...current].filter((id) => bannedIds.has(id)));
      if (next.size !== current.size) {
        this.pending.set(next);
      }
    });
  });

  /** Whether this member's unban is currently in flight. */
  isPending(userId: string): boolean {
    return this.pending().has(userId);
  }

  unbanPermission(userId: string): ActionAvailability {
    return this.permissions.unban(this.target(), userId);
  }

  /** Lift the member's ban; the authoritative sync echo removes the row. */
  unban(member: BannedMember): void {
    if (
      this.isPending(member.userId) ||
      !this.unbanPermission(member.userId).available
    ) {
      return;
    }
    this.alert
      .confirm$({
        header: `Unban from ${this.noun().toLowerCase()}`,
        message: `Unban ${member.roomDisplayName} from ${this.targetName()} using Account ${this.accountId() ?? 'currently active'}? They may be invited or join again according to this ${this.noun().toLowerCase()}'s access policy.`,
        confirmText: 'Unban',
        variant: 'neutral',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.setPending(member.userId, true);
        this.moderation
          .unban(this.target(), member.userId)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: () => {
              this.toast.show(`Unbanned ${member.roomDisplayName}.`, {
                duration: 3000,
                variant: 'success',
              });
            },
            error: () => {
              this.setPending(member.userId, false);
              this.toast.show(`Could not unban ${member.roomDisplayName}.`, {
                duration: 4000,
                variant: 'danger',
              });
            },
          });
      });
  }

  private setPending(userId: string, on: boolean): void {
    this.pending.update((set) => {
      const next = new Set(set);
      if (on) {
        next.add(userId);
      } else {
        next.delete(userId);
      }
      return next;
    });
  }
}
