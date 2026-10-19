import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { MemberRoomsTabComponent } from './member-rooms-tab/member-rooms-tab.component';
import { SidePanelHeaderComponent } from '../side-panel/side-panel-header.component';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { catchError, map, of, startWith, switchMap } from 'rxjs';
import {
  TrnTab,
  TrnTabList,
  TrnTabPanel,
  TrnTabs,
} from '@trinity/components/controls';
import { TrnBadge } from '@trinity/components/generic-content';
import {
  TrnDialogRef,
  TrnDialogShellComponent,
  TrnOverlaySurfaceDirective,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  MEMBER_ROLE_LABEL,
  RoomActionPermissionsService,
  type MemberSummary,
  memberRole,
} from '@trinity/data-access/room-administration';
import {
  RoomLibraryService,
  RoomsInCommonService,
  type CommonRoom,
} from '@trinity/data-access/room-library';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  IdentityPresenceService,
  IdentityService,
  type PresenceDetails,
} from '@trinity/data-access/identity';
import {
  TrustOperationError,
  TrustUsersService,
  TrustVerificationService,
} from '@trinity/data-access/trust';
import { AvatarComponent } from '@trinity/components/generic-content';
import { MemberProfileTabComponent } from './member-profile-tab/member-profile-tab.component';
import { MemberManageTabComponent } from './member-manage-tab/member-manage-tab.component';

/**
 * A room-scoped info card for a member (avatar, name, id, live presence, role), shown
 * when a member row is clicked: a dialog on a large screen, a bottom sheet on a phone or
 * tablet or below `md`, or in place inside settings. It launches member actions:
 * **Message** (closes resolving the user id so the host opens/reuses a DM) and **Copy ID**,
 * both on the Profile tab, and, when the viewer's power permits, **change role** and
 * **remove / ban** on the Manage tab, which runs the moderation writes; the host only handles
 * the DM and computes the permission caps.
 */
@Component({
  selector: 'trn-member-info',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    SidePanelHeaderComponent,
    TrnDialogShellComponent,
    TrnOverlaySurfaceDirective,
    AvatarComponent,
    TrnBadge,
    TrnTabs,
    TrnTabList,
    TrnTab,
    TrnTabPanel,
    MemberProfileTabComponent,
    MemberRoomsTabComponent,
    MemberManageTabComponent,
  ],
  templateUrl: './member-info.component.html',
  styleUrl: './member-info.component.scss',
  host: {
    // Embedded in settings, the detail column owns the height, so the panel fills it.
    class: 'flex h-full flex-col',
    // Drives the panel presentation in the stylesheet (see {@link isPanel}).
    '[class.member-info--panel]': 'isPanel',
  },
})
export class MemberInfoComponent {
  readonly member = input.required<MemberSummary>();
  /** The room the member is being viewed in (scopes the moderation actions). */
  readonly roomId = input.required<string>();
  /** Immutable Account owner when this panel is hosted from settings. */
  readonly accountId = input<string | null>(null);
  /**
   * The Account a Conversation opened this for. While it is the active Account the
   * commands read the live active-Account room; if another Account becomes active before
   * the host closes this, they stay on this one rather than following the switch.
   */
  readonly owningAccountId = input<string | null>(null);
  /** Whether the immutable Account-and-Room target can still supply live authority. */
  readonly exactTargetAvailable = input(true);
  readonly targetName = input('this room');
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
   * Present when this is a dialog or sheet (opened through `TrnSurfaceService`), absent when
   * settings embeds it in place. Every exit goes through {@link finish}, which closes the
   * dialog when present and otherwise announces itself for the host to act on.
   */
  private readonly dialogRef = inject<TrnDialogRef<string | null>>(
    TrnDialogRef,
    { optional: true },
  );

  /** The viewer picked "Message": open (or reuse) a DM with them. Embedded mode only. */
  readonly messageUser = output<string>();
  /** Closed without picking anything. Embedded mode only. */
  readonly dismissed = output<void>();
  /** Embedded mode only: a shared room was opened, so the host should close what shows this. */
  readonly roomOpened = output<void>();

  /**
   * Whether this renders in place (embedded in settings) rather than as a dialog or sheet.
   * In place there is no backdrop or Escape of its own, so it carries its own header and
   * close button. Read from the ref rather than passed in, so the two cannot disagree.
   */
  get isPanel(): boolean {
    return this.embedded() || !this.dialogRef;
  }

  private readonly presence = inject(IdentityPresenceService);
  private readonly toast = inject(TrnToastService);
  private readonly identity = inject(IdentityService);
  private readonly permissionsService = inject(RoomActionPermissionsService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly verification = inject(TrustVerificationService);
  private readonly trustUsers = inject(TrustUsersService);
  private readonly commonRoomsService = inject(RoomsInCommonService);
  private readonly matrix = inject(MatrixClientService);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly userIdHandle =
    viewChild<ElementRef<HTMLElement>>('userIdHandle');
  /** Hides the Manage tab when its panel would be empty. */
  protected readonly manageTab = viewChild(MemberManageTabComponent);
  protected readonly manageOffered = computed(
    () => !this.isSelf() && !!this.manageTab()?.hasContent(),
  );
  protected readonly tab = signal<string | undefined>('profile');
  /** Falls back to Profile when Manage empties while selected, so the card never goes blank. */
  protected readonly activeTab = computed(() =>
    this.tab() === 'manage' && !this.manageOffered() ? 'profile' : this.tab(),
  );

  /** The owning Account is no longer the active one (the host is about to close this). */
  private readonly ownerInactive = computed(() => {
    const owner = this.owningAccountId();
    return owner !== null && owner !== this.identity.activeUserId();
  });

  /** The Account the commands run as, when one is known. */
  private readonly commandAccountId = computed(
    () => this.accountId() ?? this.owningAccountId(),
  );

  /** Live online status for the presence dot. */
  readonly presenceState = computed(() =>
    this.accountId() || this.ownerInactive()
      ? null
      : this.presence.presenceFor(this.member().userId)(),
  );

  /** Presence text for the Profile tab, on the same terms as {@link presenceState}. */
  readonly presenceDetails = computed<PresenceDetails | null>(() => {
    if (this.accountId() || this.ownerInactive()) return null;
    // Your own SDK user is often stale, so yourself reads the presence you set.
    if (this.isSelf()) {
      if (!this.presence.presenceAvailable()) return null;
      return {
        state: this.presence.myPresence(),
        statusMessage: this.presence.myStatusMessage(),
        lastActiveAt: null,
        currentlyActive: true,
      };
    }
    const userId = this.member().userId;
    return untracked(() => this.presence.presenceDetailsFor(userId))();
  });

  /** The member's global display name, only when it differs from their name in this room. */
  readonly globalName = toSignal(
    toObservable(this.member).pipe(
      switchMap((member) =>
        this.identity.lookup(member.userId).pipe(
          // A lookup without a name falls back to the user id: that is no global name.
          map(({ displayName }) =>
            displayName === member.roomDisplayName ||
            displayName === member.userId
              ? null
              : displayName,
          ),
          catchError(() => of(null)),
          startWith(null),
        ),
      ),
    ),
    { initialValue: null },
  );

  /** Trust is the active Account's view, so it shows only while that is the card's Account. */
  readonly trust = computed(() => {
    const active = this.identity.activeUserId();
    if ((this.commandAccountId() ?? active) !== active) return null;
    const userId = this.member().userId;
    // untracked: the service may settle its signal synchronously, which a computed forbids.
    return untracked(() => this.trustUsers.userTrust(userId))();
  });

  /** Joined rooms shared with the member besides this one; null while unknown. */
  readonly commonRooms = computed(() => {
    // A client restart orphans a held view, so ask again when the accounts change.
    this.matrix.accountIds();
    const userId = this.member().userId;
    const roomId = this.roomId();
    const accountId = this.commandAccountId();
    return untracked(() =>
      this.commonRoomsService.roomsInCommon(userId, roomId, accountId),
    )();
  });

  readonly roomsTabLabel = computed(() => {
    const rooms = this.commonRooms();
    return rooms ? `Rooms (${rooms.length})` : 'Rooms';
  });

  /** Whether this row is the signed-in user — no point messaging yourself. */
  readonly isSelf = computed(
    () =>
      this.member().userId ===
      (this.commandAccountId() ?? this.identity.activeUserId()),
  );

  /** Whether the room is a direct message — a DM has no owner. See {@link memberRole}. */
  readonly direct = input(false);

  readonly target = computed(() => {
    const accountId =
      this.accountId() ??
      (this.ownerInactive() ? this.owningAccountId() : null);
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

  /** The member's role in the room, by the standard power-level convention. */
  readonly role = computed(
    () =>
      MEMBER_ROLE_LABEL[
        memberRole(this.liveMember(), { direct: this.direct() })
      ],
  );

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
    // Verification and blocking run as the active Account; never as one that replaced ours.
    if (this.ownerInactive()) return;
    const userId = this.member().userId;
    this.verification
      .startUserVerification(userId, this.rooms.createDirectMessage(userId))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.finish(null),
        error: (error: unknown) =>
          this.toast.show(
            error instanceof TrustOperationError
              ? error.message
              : 'Could not start verification.',
            { duration: 4000, variant: 'danger' },
          ),
      });
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

  close(): void {
    this.finish(null);
  }

  /** Opens a shared room (a space opens its home scope), then closes the card. */
  openRoom(room: CommonRoom): void {
    this.workspace
      .navigate(
        room.kind === 'space'
          ? {
              kind: 'scope',
              accountId: room.accountId,
              scope: { kind: 'space', spaceId: room.id },
            }
          : {
              kind: 'room',
              accountId: room.accountId,
              roomId: room.id,
              origin: 'room-action',
            },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          if (outcome.kind !== 'ready') this.openFailed();
          else if (this.dialogRef && !this.embedded()) this.finish(null);
          else this.roomOpened.emit();
        },
        error: () => this.openFailed(),
      });
  }

  private openFailed(): void {
    this.toast.show('Unable to open that destination right now.', {
      duration: 4000,
      variant: 'danger',
    });
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
}
