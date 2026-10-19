import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, type Observable } from 'rxjs';
import { TrnActionAvailability, TrnButton } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  ASSIGNABLE_MEMBER_ROLES,
  ContentReportingService,
  type AssignableMemberRole,
  RoomActionPermissionsService,
  type ActionAvailability,
  type MemberSummary,
  RoomModerationService,
} from '@trinity/data-access/room-administration';
import {
  IgnoredUsersService,
  IdentityService,
} from '@trinity/data-access/identity';
import {
  BLOCK_FAILED_TOAST,
  BLOCKED_TOAST,
  ReportService,
  UNBLOCKED_TOAST,
} from '../../report/report.service';
import { MemberRolePickerComponent } from '../member-role-picker/member-role-picker.component';

let nextId = 0;

/** The member card's Manage tab: Safety (block, report), then moderation of this room. */
@Component({
  selector: 'trn-member-manage-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnButton,
    TrnActionAvailability,
    TrnTooltip,
    MemberRolePickerComponent,
  ],
  templateUrl: './member-manage-tab.component.html',
})
export class MemberManageTabComponent {
  private readonly toast = inject(TrnToastService);
  private readonly identity = inject(IdentityService);
  private readonly moderation = inject(RoomModerationService);
  private readonly permissionsService = inject(RoomActionPermissionsService);
  private readonly ignoredUsers = inject(IgnoredUsersService);
  private readonly alert = inject(TrnAlertService);
  private readonly reporting = inject(ContentReportingService);
  private readonly reports = inject(ReportService);
  private readonly destroyRef = inject(DestroyRef);

  /** Names the section headings for `aria-labelledby`. */
  protected readonly id = `trn-member-manage-${nextId++}`;

  readonly member = input.required<MemberSummary>();
  /** The room the member is being viewed in (scopes the moderation actions). */
  readonly roomId = input.required<string>();
  readonly accountId = input<string | null>(null);
  readonly owningAccountId = input<string | null>(null);
  readonly targetName = input('this room');
  readonly noun = input<'Room' | 'Space'>('Room');
  /** Exact-target observers bump this when membership or power policy changes. */
  readonly authorityRevision = input(0);
  readonly hideUnavailableModeration = input(false);
  readonly showIdentityActions = input(true);

  /** A moderation write landed; the shell closes the card (the row leaves via sync). */
  readonly finished = output<void>();

  constructor() {
    this.ignoredUsers
      .runProjection()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Whether the active account blocks this member, as its synced ignore list says. */
  readonly ignored = computed(() =>
    this.ignoredUsers.isIgnored(this.member().userId),
  );

  private readonly blockAnswer = signal<{
    readonly text: string;
    readonly failed: boolean;
    readonly ignored: boolean;
  } | null>(null);
  /**
   * The last block or unblock answer, said under the button because a toast would cover it
   * on desktop. Gone once the list no longer matches it, as after a change on another device.
   */
  readonly blockNotice = computed(() => {
    const answer = this.blockAnswer();
    return answer?.ignored === this.ignored() ? answer : null;
  });

  /** The owning Account is no longer the active one (the host is about to close this). */
  private readonly ownerInactive = computed(() => {
    const owner = this.owningAccountId();
    return owner !== null && owner !== this.identity.activeUserId();
  });

  /**
   * Blocking acts on the active account's list, so while another account is active the card
   * can neither show nor change this owner's block.
   */
  readonly blockUnavailableReason = computed(() =>
    this.ownerInactive()
      ? `Switch back to ${this.owningAccountId()} to block or unblock from this card.`
      : null,
  );

  /** The Account the commands run as, when one is known. */
  private readonly commandAccountId = computed(
    () => this.accountId() ?? this.owningAccountId(),
  );

  /** The account a report goes out as: the one this card was opened for. */
  private readonly reporterId = computed(
    () => this.commandAccountId() ?? this.identity.activeUserId(),
  );

  private readonly target = computed(() => {
    const accountId =
      this.accountId() ??
      (this.ownerInactive() ? this.owningAccountId() : null);
    return accountId ? { accountId, roomId: this.roomId() } : this.roomId();
  });

  readonly permissions = computed(() => {
    this.authorityRevision();
    return this.permissionsService.member(this.target(), this.member().userId);
  });

  /** Every meaningful preset except the current one; unavailable choices explain why. */
  readonly roleOptions = computed(() => {
    const current = this.permissions().targetPower;
    return ASSIGNABLE_MEMBER_ROLES.filter((role) => role.level !== current);
  });

  /** The picker's radios: the current role, checked, and every other role it may show. */
  readonly roleChoices = computed(() => {
    const current = this.permissions().targetPower;
    return ASSIGNABLE_MEMBER_ROLES.filter(
      (role) =>
        role.level === current ||
        this.showModerationAction(this.rolePermission(role.level)),
    );
  });

  readonly showRolePicker = computed(() =>
    this.roleOptions().some((option) =>
      this.showModerationAction(this.rolePermission(option.level)),
    ),
  );

  /** Bound for the picker, which asks per radio. */
  readonly rolePermissionFor = (level: number): ActionAvailability =>
    this.rolePermission(level);

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

  /** Whether the tab shows anything; the shell hides an empty Manage tab. */
  readonly hasContent = computed(
    () => this.showIdentityActions() || this.showModeration(),
  );

  showModerationAction(permission: ActionAvailability): boolean {
    return !this.hideUnavailableModeration() || permission.available;
  }

  /** Block or unblock the member (account-wide ignore); the button follows the synced list. */
  toggleIgnore(): void {
    if (this.ownerInactive()) return;
    const userId = this.member().userId;
    const wasIgnored = this.ignored();
    const action = wasIgnored
      ? this.ignoredUsers.unignore(userId)
      : this.ignoredUsers.ignore(userId);
    this.blockAnswer.set(null);
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () =>
        this.blockAnswer.set({
          text: wasIgnored ? UNBLOCKED_TOAST : BLOCKED_TOAST,
          failed: false,
          ignored: !wasIgnored,
        }),
      error: () =>
        this.blockAnswer.set({
          text: BLOCK_FAILED_TOAST,
          failed: true,
          ignored: wasIgnored,
        }),
    });
  }

  /** Hidden once the reporter's server has said it takes no user reports. */
  readonly canReport = computed(() => {
    const reporter = this.reporterId();
    return !!reporter && this.reporting.offers(reporter, 'user');
  });

  /** Report the member to the reporter's server admins, then offer to block them. */
  report(): void {
    const accountId = this.reporterId();
    if (!accountId) return;
    const member = this.member();
    this.reports
      .reportUser$({
        accountId,
        userId: member.userId,
        name: member.roomDisplayName,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Remove the member from the room (with an optional reason), on confirmation. */
  kick(): void {
    if (!this.permissions().kick.available) {
      return;
    }
    this.alert
      .prompt$({
        header: `Remove from ${this.noun().toLowerCase()}`,
        message: `Remove ${this.member().roomDisplayName} from ${this.targetName()} using account ${this.commandAccountId() ?? 'currently active'}? They can rejoin if invited or if this ${this.noun().toLowerCase()} is public.`,
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
        header: `Ban from ${this.noun().toLowerCase()}`,
        message: `Ban ${this.member().roomDisplayName} from ${this.targetName()} using account ${this.commandAccountId() ?? 'currently active'}? They won't be able to rejoin until they're unbanned.`,
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
        message: `Change ${this.member().roomDisplayName}'s role in ${this.targetName()} to ${option.label} using account ${this.commandAccountId() ?? 'currently active'}?`,
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

  /** Run a moderation write: announce success (the shell closes), toast on failure. */
  private run(action: Observable<void>, failure: string): void {
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.finished.emit(),
      error: () =>
        this.toast.show(failure, { duration: 4000, variant: 'danger' }),
    });
  }
}
