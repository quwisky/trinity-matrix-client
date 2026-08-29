import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { switchMap, type Observable } from 'rxjs';
import { TrnActionAvailability, TrnButton } from '@trinity/components/button';
import { TrnTooltip } from '@trinity/components/tooltip';
import {
  TrnDialogRef,
  TrnAlertService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  RoomModerationService,
  RoomActionPermissionsService,
  RoomsService,
  type ActionAvailability,
  type MemberSummary,
} from '@trinity/data-access/rooms';
import {
  IgnoredUsersService,
  PresenceService,
} from '@trinity/data-access/profile';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { VerificationService } from '@trinity/data-access/crypto';
import { AvatarComponent } from '@trinity/components/avatar';
import { TrnIconComponent } from '@trinity/components/icon';
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
  imports: [
    AvatarComponent,
    TrnButton,
    TrnActionAvailability,
    TrnTooltip,
    TrnIconComponent,
  ],
  templateUrl: './member-info.component.html',
  styleUrl: './member-info.component.scss',
  host: {
    // Drives the panel presentation in the stylesheet — see the note on {@link isPanel}.
    '[class.member-info--panel]': 'isPanel',
  },
})
export class MemberInfoComponent {
  readonly member = input.required<MemberSummary>();
  /** The room the member is being viewed in (scopes the moderation actions). */
  readonly roomId = input.required<string>();

  /**
   * Present when this is a DIALOG, absent when it is the shell's right-hand panel.
   *
   * The one surface that has to work both ways. Member info opened from a room member's row
   * belongs in the slot beside the timeline; the same panel opened from the space-members
   * dialog carries a SPACE id (`space-actions.service.ts`), where there is no open room and
   * therefore no slot — so it stays a dialog there. Rather than fork the component, every
   * exit goes through {@link finish}, which closes the ref if there is one and otherwise
   * announces itself for the host to act on.
   */
  private readonly dialogRef = inject<TrnDialogRef<string | null>>(
    TrnDialogRef,
    { optional: true },
  );

  /** The viewer picked "Message": open (or reuse) a DM with them. Panel mode only. */
  readonly messageUser = output<string>();
  /** Closed without picking anything. Panel mode only. */
  readonly dismissed = output<void>();

  /**
   * Whether this is the shell's right-hand panel rather than a dialog.
   *
   * The two presentations are genuinely different surfaces, not a skin: a dialog is a
   * centred profile card that the backdrop and Escape dismiss, while the slot is a
   * full-height panel with no backdrop and — above the `members` breakpoint — no Escape
   * either, so it has to carry its own header and close button or there is no way out of
   * it. Read from the ref rather than passed in, so the two can never disagree.
   */
  readonly isPanel = !this.dialogRef;

  private readonly presence = inject(PresenceService);
  private readonly toast = inject(TrnToastService);
  private readonly matrix = inject(MatrixClientService);
  private readonly moderation = inject(RoomModerationService);
  private readonly permissionsService = inject(RoomActionPermissionsService);
  private readonly ignoredUsers = inject(IgnoredUsersService);
  private readonly rooms = inject(RoomsService);
  private readonly verification = inject(VerificationService);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly userIdHandle =
    viewChild<ElementRef<HTMLInputElement>>('userIdHandle');

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

  readonly permissions = computed(() =>
    this.permissionsService.member(this.roomId(), this.member().userId),
  );

  readonly liveMember = computed<MemberSummary>(() => ({
    ...this.member(),
    powerLevel: this.permissions().targetPower,
  }));

  readonly role = computed(
    () =>
      MEMBER_ROLE_LABEL[
        memberRole(this.liveMember(), { direct: this.direct() })
      ],
  );

  /** Every meaningful preset except the current one; unavailable choices explain why. */
  readonly roleOptions = computed(() => {
    const current = this.permissions().targetPower;
    return ROLE_PRESETS.filter((role) => role.level !== current);
  });

  rolePermission(level: number): ActionAvailability {
    return this.permissionsService.role(
      this.roomId(),
      this.member().userId,
      level,
    );
  }

  /** Start (or reuse) a direct message with this member — the host does the navigation. */
  message(): void {
    this.finish(this.member().userId);
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
        next: () => this.finish(null),
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
        this.selectUserId();
        this.toast.show(
          'Could not copy the user ID. It is selected above; copy it manually.',
          { duration: 5000, variant: 'destructive' },
        );
      },
    );
  }

  /** Focus and select the complete MXID for keyboard-accessible manual copying. */
  selectUserId(): void {
    const handle = this.userIdHandle()?.nativeElement;
    if (!handle) {
      return;
    }
    handle.focus();
    handle.select();
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
    if (!this.permissions().kick.available) {
      return;
    }
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
    if (!this.permissions().ban.available) {
      return;
    }
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
    if (!this.rolePermission(option.level).available) {
      return;
    }
    const confirmed = await this.alert.confirm({
      header: 'Change role',
      message: `Change ${this.member().name}'s role to ${option.label}?`,
      confirmText: 'Change',
      // A demotion is the weightier direction — style its confirm as destructive.
      destructive: option.level < this.permissions().targetPower,
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
    this.finish(null);
  }

  /**
   * The single exit. `userId` is set only for "Message"; everything else — closing, a
   * moderation write landing, verification starting — ends with `null`.
   */
  private finish(userId: string | null): void {
    if (this.dialogRef) {
      this.dialogRef.close(userId);
      return;
    }
    if (userId) {
      this.messageUser.emit(userId);
      return;
    }
    this.dismissed.emit();
  }

  /** Run a moderation write: close the panel on success (the row leaves via sync), toast on failure. */
  private run(action: Observable<void>, failure: string): void {
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.finish(null),
      error: () =>
        this.toast.show(failure, { duration: 4000, variant: 'destructive' }),
    });
  }
}
