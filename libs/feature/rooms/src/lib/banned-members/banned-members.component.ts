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
import { TrnActionAvailability, TrnButton } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { TrnToastService } from '@trinity/components/overlay';
import {
  RoomActionPermissionsService,
  type ActionAvailability,
  type BannedMember,
  RoomMembersService,
  RoomModerationService,
} from '@trinity/data-access/room-administration';

/**
 * The room's banned members, with an Unban action per row. Rendered inside the room
 * settings dialog for viewers whose power level lets them ban. The list is a live Room
 * Administration projection and changes only when authoritative Matrix room state does.
 */
@Component({
  selector: 'trn-banned-members',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './banned-members.component.html',
  imports: [TrnButton, TrnActionAvailability, TrnTooltip],
})
export class BannedMembersComponent {
  readonly roomId = input.required<string>();

  private readonly moderation = inject(RoomModerationService);
  private readonly members = inject(RoomMembersService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** The current authoritative ban list for this Room. */
  readonly banned = computed(() => this.members.bannedFor(this.roomId())());
  /** User IDs whose unban is in flight (disables that row's button). */
  private readonly pending = signal<ReadonlySet<string>>(new Set());

  readonly isEmpty = computed(() => this.banned().length === 0);

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
    return this.permissions.unban(this.roomId(), userId);
  }

  /** Lift the member's ban; the authoritative sync echo removes the row. */
  unban(member: BannedMember): void {
    if (
      this.isPending(member.userId) ||
      !this.unbanPermission(member.userId).available
    ) {
      return;
    }
    this.setPending(member.userId, true);
    this.moderation
      .unban(this.roomId(), member.userId)
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
