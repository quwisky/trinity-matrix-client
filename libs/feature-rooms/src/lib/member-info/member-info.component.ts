import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  linkedSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { switchMap, type Observable } from 'rxjs';
import { HlmButton } from '@trinity/helm/button';
import {
  DialogRef,
  TrnAlertService,
  TrnToastService,
} from '@trinity/helm/overlay';
import {
  RoomModerationService,
  RoomsService,
  type MemberSummary,
} from '@trinity/data-access-rooms';
import {
  IgnoredUsersService,
  PresenceService,
} from '@trinity/data-access-profile';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { VerificationService } from '@trinity/data-access-crypto';
import { AvatarComponent } from '@trinity/ui';
import { MEMBER_ROLE_LABEL, memberRole } from '../shared/member-role';

/**
 * Preset roles the panel can ASSIGN, by the standard power-level convention.
 *
 * Owner is deliberately absent and must stay absent: it is the room's creator, and no
 * power level makes someone that. Offering it here would be an action the server cannot
 * perform — which is why the displayed role and the assignable roles come from two
 * different places rather than one list.
 */
const ROLE_PRESETS = [
  { label: 'Member', level: 0 },
  { label: 'Moderator', level: 50 },
  { label: 'Admin', level: 100 },
] as const;

/**
 * A room-scoped info panel for a member (avatar, name, id, live presence, role), shown
 * when a member row is clicked. It is the launch surface for member actions: **Message**
 * (closes resolving the user id so the host opens/reuses a DM), **Copy user ID**, and —
 * when the viewer's power permits — **change role** and **remove / ban**. The moderation
 * writes run here; the host only handles the DM and computes the permission caps.
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
  /** Whether the viewer may change this member's power level (promote / demote). */
  readonly canSetPower = input(false);
  /** The viewer's own power level — caps which roles they can assign. */
  readonly myPower = input(0);

  private readonly dialogRef =
    inject<DialogRef<string | null, MemberInfoComponent>>(DialogRef);
  private readonly presence = inject(PresenceService);
  private readonly toast = inject(TrnToastService);
  private readonly matrix = inject(MatrixClientService);
  private readonly moderation = inject(RoomModerationService);
  private readonly ignoredUsers = inject(IgnoredUsersService);
  private readonly rooms = inject(RoomsService);
  private readonly verification = inject(VerificationService);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);

  /** Whether this member is ignored (blocked); flips locally when toggled. */
  readonly ignored = linkedSignal(() =>
    this.ignoredUsers.isIgnored(this.member().userId),
  );

  /** Live online status for the presence dot. */
  readonly presenceState = computed(() =>
    this.presence.presenceFor(this.member().userId)(),
  );

  /** Whether this row is the signed-in user — no point messaging yourself. */
  readonly isSelf = computed(
    () => this.member().userId === this.matrix.activeUserId(),
  );

  /** The member's role in the room, by the standard power-level convention. */
  /** Whether the room is a direct message — a DM has no owner. See {@link memberRole}. */
  readonly direct = input(false);

  readonly role = computed(
    () =>
      MEMBER_ROLE_LABEL[memberRole(this.member(), { direct: this.direct() })],
  );

  /** Roles the viewer may assign: presets at or below their own level, minus the current one. */
  readonly roleOptions = computed(() => {
    const my = this.myPower();
    const current = this.member().powerLevel;
    return ROLE_PRESETS.filter((r) => r.level <= my && r.level !== current);
  });

  /** Start (or reuse) a direct message with this member — the host does the navigation. */
  message(): void {
    this.dialogRef.close(this.member().userId);
  }

  /**
   * Verify this member (cross-user emoji SAS). Ensure a DM with them exists, request
   * verification over it, and close — the app's verification host then presents the SAS
   * comparison. Failure keeps the panel open with a toast.
   */
  verify(): void {
    const userId = this.member().userId;
    this.rooms
      .createDirectMessage(userId)
      .pipe(
        switchMap((roomId) =>
          this.verification.startUserVerification(userId, roomId),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => this.dialogRef.close(null),
        error: () =>
          this.toast.show('Could not start verification.', {
            duration: 4000,
            variant: 'destructive',
          }),
      });
  }

  /**
   * Copy the member's user id, confirming with a toast — but only once the write has
   * actually resolved. A rejected write (denied permission, non-secure context) must
   * not be reported as success: the user walks away believing they have the id.
   */
  copyId(): void {
    const value = this.member().userId;
    void (navigator.clipboard?.writeText(value) ?? Promise.reject()).then(
      () => this.toast.show('User ID copied.', { duration: 2000 }),
      () => this.toast.show('Could not copy the user ID.', { duration: 2000 }),
    );
  }

  /** Block or unblock the member (account-wide ignore); flips the button on success. */
  toggleIgnore(): void {
    const userId = this.member().userId;
    const wasIgnored = this.ignored();
    const action = wasIgnored
      ? this.ignoredUsers.unignore(userId)
      : this.ignoredUsers.ignore(userId);
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.ignored.set(!wasIgnored);
        this.toast.show(
          wasIgnored ? 'Unblocked.' : "Blocked — you won't see their messages.",
          { duration: 2500 },
        );
      },
      error: () =>
        this.toast.show('Could not update the block.', {
          duration: 4000,
          variant: 'destructive',
        }),
    });
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

  /** Promote / demote the member to a preset role, on confirmation. */
  async setRole(option: { label: string; level: number }): Promise<void> {
    const confirmed = await this.alert.confirm({
      header: 'Change role',
      message: `Change ${this.member().name}'s role to ${option.label}?`,
      confirmText: 'Change',
      // A demotion is the weightier direction — style its confirm as destructive.
      destructive: option.level < this.member().powerLevel,
    });
    if (!confirmed) {
      return;
    }
    this.run(
      this.moderation.setPowerLevel(
        this.roomId(),
        this.member().userId,
        option.level,
      ),
      'Could not change their role.',
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
