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
import { filter, switchMap, type Observable } from 'rxjs';
import { TrnActionAvailability, TrnButton } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import {
  TrnDialogRef,
  TrnAlertService,
  TrnOverlaySurfaceDirective,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  ASSIGNABLE_MEMBER_ROLES,
  type AssignableMemberRole,
  MEMBER_ROLE_LABEL,
  RoomActionPermissionsService,
  type ActionAvailability,
  type MemberSummary,
  RoomModerationService,
  memberRole,
} from '@trinity/data-access/room-administration';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import {
  IgnoredUsersService,
  IdentityPresenceService,
  IdentityService,
} from '@trinity/data-access/identity';
import { TrustVerificationService } from '@trinity/data-access/trust';
import { AvatarComponent } from '@trinity/components/generic-content';
import { TrnIconComponent } from '@trinity/components/foundations';

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
  hostDirectives: [
    {
      directive: TrnOverlaySurfaceDirective,
      inputs: ['size: surfaceSize', 'layout: surfaceLayout'],
      outputs: [],
    },
  ],
  templateUrl: './member-info.component.html',
  styleUrl: './member-info.component.scss',
  host: {
    // The public `panel` recipe also serves viewport-pinned overlays. In the document slot,
    // the shell row owns the height, so its surface composes the same recipe with `h-full`.
    class: 'flex h-full flex-col',
    // Drives the panel presentation in the stylesheet — see the note on {@link isPanel}.
    '[class.member-info--panel]': 'isPanel',
  },
})
export class MemberInfoComponent {
  readonly member = input.required<MemberSummary>();
  /** The room the member is being viewed in (scopes the moderation actions). */
  readonly roomId = input.required<string>();
  /** Immutable Account owner when this panel is hosted from settings. */
  readonly accountId = input<string | null>(null);
  /** Whether the immutable Account-and-Room target can still supply live authority. */
  readonly exactTargetAvailable = input(true);
  readonly targetName = input('this Room');
  readonly noun = input<'Room' | 'Space'>('Room');
  /** Exact-target observers bump this when membership or power policy changes. */
  readonly authorityRevision = input(0);
  /** Settings keeps readable member detail but hides commands the viewer cannot run. */
  readonly hideUnavailableModeration = input(false);
  /** Identity actions remain on Conversation surfaces; settings owns exact moderation. */
  readonly showIdentityActions = input(true);
  /** Render in a parent settings dialog without inheriting that dialog as our owner. */
  readonly embedded = input(false);

  /**
   * Present when this is a DIALOG, absent when it is the shell's right-hand panel.
   *
   * The one surface that has to work both ways. Conversation member info belongs in the
   * slot beside the timeline; settings embeds the same content inside its owning dialog.
   * Rather than fork the component, every exit goes through {@link finish}, which closes
   * its own dialog when present and otherwise announces itself for the host to act on.
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
  get isPanel(): boolean {
    return this.embedded() || !this.dialogRef;
  }

  private readonly presence = inject(IdentityPresenceService);
  private readonly toast = inject(TrnToastService);
  private readonly identity = inject(IdentityService);
  private readonly moderation = inject(RoomModerationService);
  private readonly permissionsService = inject(RoomActionPermissionsService);
  private readonly ignoredUsers = inject(IgnoredUsersService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly verification = inject(TrustVerificationService);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly userIdHandle =
    viewChild<ElementRef<HTMLElement>>('userIdHandle');

  /** Whether this member is ignored (blocked); flips locally when toggled. */
  readonly ignored = linkedSignal(() =>
    this.ignoredUsers.isIgnored(this.member().userId),
  );

  /** Live online status for the presence dot. */
  readonly presenceState = computed(() =>
    this.accountId() ? null : this.presence.presenceFor(this.member().userId)(),
  );

  /** Whether this row is the signed-in user — no point messaging yourself. */
  readonly isSelf = computed(
    () =>
      this.member().userId ===
      (this.accountId() ?? this.identity.activeUserId()),
  );

  /** The member's role in the room, by the standard power-level convention. */
  /** Whether the room is a direct message — a DM has no owner. See {@link memberRole}. */
  readonly direct = input(false);

  readonly target = computed(() => {
    const accountId = this.accountId();
    return accountId ? { accountId, roomId: this.roomId() } : this.roomId();
  });

  readonly permissions = computed(() => {
    this.authorityRevision();
    return this.permissionsService.member(this.target(), this.member().userId);
  });

  readonly liveMember = computed<MemberSummary>(() => {
    const member = this.member();
    return {
      ...member,
      powerLevel:
        this.accountId() && !this.exactTargetAvailable()
          ? member.powerLevel
          : this.permissions().targetPower,
    };
  });

  readonly role = computed(
    () =>
      MEMBER_ROLE_LABEL[
        memberRole(this.liveMember(), { direct: this.direct() })
      ],
  );

  /** Every meaningful preset except the current one; unavailable choices explain why. */
  readonly roleOptions = computed(() => {
    const current = this.permissions().targetPower;
    return ASSIGNABLE_MEMBER_ROLES.filter((role) => role.level !== current);
  });

  rolePermission(level: number): ActionAvailability {
    return this.permissionsService.role(
      this.target(),
      this.member().userId,
      level,
    );
  }

  readonly showModeration = computed(() => {
    if (!this.hideUnavailableModeration()) return true;
    const permissions = this.permissions();
    return (
      permissions.kick.available ||
      permissions.ban.available ||
      this.roleOptions().some(
        (option) => this.rolePermission(option.level).available,
      )
    );
  });

  showModerationAction(permission: ActionAvailability): boolean {
    return !this.hideUnavailableModeration() || permission.available;
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
            variant: 'danger',
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
          { duration: 5000, variant: 'danger' },
        );
      },
    );
  }

  /** Focus and select the complete MXID for keyboard-accessible manual copying. */
  selectUserId(): void {
    const handle = this.userIdHandle()?.nativeElement;
    const selection = handle?.ownerDocument.getSelection();
    if (!handle || !selection) {
      return;
    }
    handle.focus();
    const range = handle.ownerDocument.createRange();
    range.selectNodeContents(handle);
    selection.removeAllRanges();
    selection.addRange(range);
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
          variant: 'danger',
        }),
    });
  }

  /** Remove the member from the room (with an optional reason), on confirmation. */
  kick(): void {
    if (!this.permissions().kick.available) {
      return;
    }
    this.alert
      .prompt$({
        header: `Remove from ${this.noun()}`,
        message: `Remove ${this.member().roomDisplayName} from ${this.targetName()} using Account ${this.accountId() ?? 'currently active'}? They can rejoin if invited or if this ${this.noun().toLowerCase()} is public.`,
        confirmText: 'Remove',
        variant: 'danger',
        placeholder: 'Reason (optional)',
      })
      .pipe(
        filter((reason): reason is string => reason !== null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((reason) =>
        this.run(
          this.moderation.kick(
            this.target(),
            this.member().userId,
            reason || undefined,
          ),
          'Could not remove them.',
        ),
      );
  }

  /** Ban the member from the room (with an optional reason), on confirmation. */
  ban(): void {
    if (!this.permissions().ban.available) {
      return;
    }
    this.alert
      .prompt$({
        header: `Ban from ${this.noun()}`,
        message: `Ban ${this.member().roomDisplayName} from ${this.targetName()} using Account ${this.accountId() ?? 'currently active'}? They won't be able to rejoin until they're unbanned.`,
        confirmText: 'Ban',
        variant: 'danger',
        placeholder: 'Reason (optional)',
      })
      .pipe(
        filter((reason): reason is string => reason !== null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((reason) =>
        this.run(
          this.moderation.ban(
            this.target(),
            this.member().userId,
            reason || undefined,
          ),
          'Could not ban them.',
        ),
      );
  }

  /** Promote / demote the member to a preset role, on confirmation. */
  setRole(option: Pick<AssignableMemberRole, 'label' | 'level'>): void {
    if (!this.rolePermission(option.level).available) {
      return;
    }
    this.alert
      .confirm$({
        header: 'Change role',
        message: `Change ${this.member().roomDisplayName}'s role in ${this.targetName()} to ${option.label} using Account ${this.accountId() ?? 'currently active'}?`,
        confirmText: 'Change',
        // A demotion is the weightier direction.
        variant:
          option.level < this.permissions().targetPower ? 'danger' : 'neutral',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() =>
        this.run(
          this.moderation.setPowerLevel(
            this.target(),
            this.member().userId,
            option.level,
          ),
          'Could not change their role.',
        ),
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
    if (this.dialogRef && !this.embedded()) {
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
        this.toast.show(failure, { duration: 4000, variant: 'danger' }),
    });
  }
}
