import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HlmButton } from '@trinity/helm/button';
import { TrnToastService } from '@trinity/helm/overlay';
import {
  RoomModerationService,
  type BannedMember,
} from '@trinity/data-access-rooms';

/**
 * The room's banned members, with an Unban action per row. Rendered inside the room
 * settings dialog for viewers whose power level lets them ban. Loads the current ban
 * list from {@link RoomModerationService} on init and drops a member from the list once
 * their unban succeeds (the synced client also reflects it through its state listeners).
 */
@Component({
  selector: 'trn-banned-members',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './banned-members.component.html',
  imports: [HlmButton],
})
export class BannedMembersComponent implements OnInit {
  readonly roomId = input.required<string>();

  private readonly moderation = inject(RoomModerationService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** The current ban list (seeded on init, trimmed as members are unbanned). */
  readonly banned = signal<readonly BannedMember[]>([]);
  /** User IDs whose unban is in flight (disables that row's button). */
  private readonly pending = signal<ReadonlySet<string>>(new Set());

  readonly isEmpty = computed(() => this.banned().length === 0);

  ngOnInit(): void {
    this.banned.set(this.moderation.bannedMembers(this.roomId()));
  }

  /** Whether this member's unban is currently in flight. */
  isPending(userId: string): boolean {
    return this.pending().has(userId);
  }

  /** Lift the member's ban; on success remove them from the list, else toast. */
  unban(member: BannedMember): void {
    if (this.isPending(member.userId)) {
      return;
    }
    this.setPending(member.userId, true);
    this.moderation
      .unban(this.roomId(), member.userId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.setPending(member.userId, false);
          this.banned.update((list) =>
            list.filter((m) => m.userId !== member.userId),
          );
          this.toast.show(`Unbanned ${member.name}.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          this.setPending(member.userId, false);
          this.toast.show(`Could not unban ${member.name}.`, {
            duration: 4000,
            variant: 'destructive',
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
