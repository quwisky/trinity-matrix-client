import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type Observable } from 'rxjs';
import { HlmButton } from '@trinity/helm/button';
import {
  DialogRef,
  TrnAlertService,
  TrnToastService,
} from '@trinity/helm/overlay';
import {
  RoomModerationService,
  type MemberSummary,
} from '@trinity/data-access-rooms';
import { PresenceService } from '@trinity/data-access-profile';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { AvatarComponent } from '@trinity/ui';

/**
 * A room-scoped info panel for a member (avatar, name, id, live presence, role), shown
 * when a member row is clicked. It is the launch surface for member actions: today it
 * offers **Message** (closes resolving the user id so the host opens/reuses a DM) and
 * **Copy user ID**; kick / ban / power-level / verify hang off here later. Owns
 * presentation only — the DM itself is the host's job.
 */
@Component({
  selector: 'trn-member-info',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, HlmButton],
  templateUrl: './member-info.component.html',
  styleUrl: './member-info.component.scss',
})
export class MemberInfoComponent {
  readonly member = input.required<MemberSummary>();
  /** The room the member is being viewed in (scopes the moderation actions). */
  readonly roomId = input.required<string>();
  /** Whether the viewer may remove this member (host computes it from power levels). */
  readonly canKick = input(false);
  /** Whether the viewer may ban this member. */
  readonly canBan = input(false);

  private readonly dialogRef =
    inject<DialogRef<string | null, MemberInfoComponent>>(DialogRef);
  private readonly presence = inject(PresenceService);
  private readonly toast = inject(TrnToastService);
  private readonly matrix = inject(MatrixClientService);
  private readonly moderation = inject(RoomModerationService);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);

  /** Live online status for the presence dot. */
  readonly presenceState = computed(() =>
    this.presence.presenceFor(this.member().userId)(),
  );

  /** Whether this row is the signed-in user — no point messaging yourself. */
  readonly isSelf = computed(
    () => this.member().userId === this.matrix.activeUserId(),
  );

  /** The member's role in the room, by the standard power-level convention. */
  readonly role = computed(() => {
    const power = this.member().powerLevel;
    if (power >= 100) {
      return 'Admin';
    }
    return power >= 50 ? 'Moderator' : 'Member';
  });

  /** Start (or reuse) a direct message with this member — the host does the navigation. */
  message(): void {
    this.dialogRef.close(this.member().userId);
  }

  /** Copy the member's user id to the clipboard, confirming with a toast. */
  copyId(): void {
    void navigator.clipboard?.writeText(this.member().userId);
    this.toast.show('User ID copied.', { duration: 2000 });
  }

  /** Remove the member from the room (with an optional reason), on confirmation. */
  async kick(): Promise<void> {
    const reason = await this.alert.prompt({
      header: 'Remove from room',
      message: `Remove ${this.member().name} from this room? They can rejoin if invited (or if the room is public).`,
      confirmText: 'Remove',
      destructive: true,
      placeholder: 'Reason (optional)',
    });
    if (reason === null) {
      return; // cancelled
    }
    this.run(
      this.moderation.kick(
        this.roomId(),
        this.member().userId,
        reason || undefined,
      ),
      'Could not remove them.',
    );
  }

  /** Ban the member from the room (with an optional reason), on confirmation. */
  async ban(): Promise<void> {
    const reason = await this.alert.prompt({
      header: 'Ban from room',
      message: `Ban ${this.member().name}? They won't be able to rejoin until they're unbanned.`,
      confirmText: 'Ban',
      destructive: true,
      placeholder: 'Reason (optional)',
    });
    if (reason === null) {
      return;
    }
    this.run(
      this.moderation.ban(
        this.roomId(),
        this.member().userId,
        reason || undefined,
      ),
      'Could not ban them.',
    );
  }

  close(): void {
    this.dialogRef.close(null);
  }

  /** Run a moderation write: close the panel on success (the row leaves via sync), toast on failure. */
  private run(action: Observable<void>, failure: string): void {
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.dialogRef.close(null),
      error: () =>
        this.toast.show(failure, { duration: 4000, variant: 'destructive' }),
    });
  }
}
