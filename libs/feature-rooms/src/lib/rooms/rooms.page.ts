import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Observable, finalize } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideLock,
  lucideMenu,
  lucideMessagesSquare,
  lucidePin,
  lucideSearch,
  lucideSettings,
  lucideUserPlus,
  lucideUsers,
} from '@ng-icons/lucide';
import { HlmButton } from '@trinity/helm/button';
import { HlmTooltip } from '@trinity/helm/tooltip';
import {
  TrnActionSheetService,
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/helm/overlay';
import { AuthService } from '@trinity/data-access-auth';
import { CryptoService } from '@trinity/data-access-crypto';
import { InvitesService } from '@trinity/data-access-invites';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { MediaService } from '@trinity/data-access-media';
import {
  NotificationService,
  PushService,
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access-notifications';
import { PinnedMessagesService } from '@trinity/data-access-pinned';
import {
  PresenceService,
  type UserProfile,
} from '@trinity/data-access-profile';
import {
  RoomsService,
  RoomSettingsService,
  RoomModerationService,
  RoomAliasesService,
  PublicRoomsService,
  SpacesService,
  UnreadAggregatorService,
  type MemberSummary,
  type RoomSummary,
  type SpaceChildRoom,
} from '@trinity/data-access-rooms';
import { RoomSettingsComponent } from '../room-settings/room-settings.component';
import {
  RoomDirectoryComponent,
  type DirectoryJoin,
} from '../room-directory/room-directory.component';
import { MemberInfoService } from '../member-info/member-info.service';
import { type SwitcherSelection } from '@trinity/data-access-search';
import { ThreadsService, TimelineService } from '@trinity/data-access-timeline';
import { type MatrixLinkTarget, type Mention } from '@trinity/util-matrix';
import { FeatureFlagsService } from '@trinity/platform-native';
import { PageHeaderComponent, runWithBusy } from '@trinity/ui';
import { UserPickerService } from '../user-picker/user-picker.service';
import { UserCardService } from '../user-card/user-card.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { MessageSearchService } from '../message-search/message-search.service';
import {
  ServerRailComponent,
  type RailUnread,
} from '../server-rail/server-rail.component';
import {
  ChannelSidebarComponent,
  type AccountSummary,
} from '../channel-sidebar/channel-sidebar.component';
import { MemberListComponent } from '../member-list/member-list.component';
import { SimpleMessageListComponent } from '../message-list/simple-message-list/simple-message-list.component';
import { VirtualMessageListComponent } from '../message-list/virtual-message-list/virtual-message-list.component';
import { EncryptionBannerComponent } from '../encryption-banner/encryption-banner.component';
import { ConnectivityBannerComponent } from '../connectivity-banner/connectivity-banner.component';
import { TombstoneBannerComponent } from '../tombstone-banner/tombstone-banner.component';
import { ThreadPanelService } from '../thread/thread-panel.service';
import { PinnedPanelService } from '../pinned/pinned-panel.service';

/**
 * Discord-style authenticated shell: server rail + channel sidebar (in a
 * responsive Tailwind drawer — static column at md+, slide-in below), the read
 * timeline, and a member list.
 * Wired to live synced rooms via `RoomsService` + `TimelineService`.
 */
@Component({
  selector: 'trn-rooms',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'rooms.page.html',
  styleUrls: ['rooms.page.scss'],
  imports: [
    PageHeaderComponent,
    HlmButton,
    HlmTooltip,
    NgIcon,
    ServerRailComponent,
    ChannelSidebarComponent,
    MemberListComponent,
    SimpleMessageListComponent,
    VirtualMessageListComponent,
    EncryptionBannerComponent,
    ConnectivityBannerComponent,
    TombstoneBannerComponent,
  ],
  viewProviders: [
    provideIcons({
      lucideLock,
      lucideMenu,
      lucideMessagesSquare,
      lucidePin,
      lucideSearch,
      lucideSettings,
      lucideUserPlus,
      lucideUsers,
    }),
  ],
})
export class RoomsPage implements OnInit, OnDestroy {
  readonly rooms = inject(RoomsService);
  readonly spaces = inject(SpacesService);
  readonly invites = inject(InvitesService);
  readonly timeline = inject(TimelineService);
  readonly threads = inject(ThreadsService);
  readonly pinned = inject(PinnedMessagesService);
  readonly flags = inject(FeatureFlagsService);
  private readonly threadPanel = inject(ThreadPanelService);
  private readonly pinnedPanel = inject(PinnedPanelService);
  private readonly userPicker = inject(UserPickerService);
  private readonly userCard = inject(UserCardService);
  private readonly memberInfo = inject(MemberInfoService);
  private readonly switcher = inject(QuickSwitcherService);
  private readonly messageSearch = inject(MessageSearchService);
  private readonly media = inject(MediaService);
  private readonly unreadAgg = inject(UnreadAggregatorService);
  private readonly matrix = inject(MatrixClientService);
  private readonly crypto = inject(CryptoService);
  private readonly presence = inject(PresenceService);
  private readonly push = inject(PushService);
  private readonly notifications = inject(NotificationService);
  private readonly roomNotifications = inject(RoomNotificationsService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly dialog = inject(TrnDialogService);
  private readonly roomSettings = inject(RoomSettingsService);
  private readonly moderation = inject(RoomModerationService);
  private readonly aliases = inject(RoomAliasesService);
  private readonly publicRooms = inject(PublicRoomsService);
  private readonly toast = inject(TrnToastService);
  private readonly alert = inject(TrnAlertService);
  private readonly actionSheet = inject(TrnActionSheetService);
  private readonly destroyRef = inject(DestroyRef);

  readonly activeSpaceId = signal<string | null>(null);
  /** Whether the Rooms view is active — filters the sidebar to non-DM rooms. Home (the
   * default, no space) shows direct messages only; a space or this view clears the other. */
  readonly roomsView = signal(false);
  readonly activeRoomId = signal<string | null>(null);
  /** Whether the side pane is shown as an overlay drawer (below the md breakpoint). */
  readonly drawerOpen = signal(false);
  /** Whether the right-hand member list is shown (toggled from the toolbar). */
  readonly membersOpen = signal(true);
  /**
   * Event id the message list should scroll to, set by in-room search, a reply
   * preview, or the pinned panel. Bound to the list's `jumpToId`, paired with
   * {@link jumpRequest} so re-selecting the SAME message still re-triggers the jump.
   */
  readonly messageSearchTarget = signal<string | null>(null);
  /** Bumped on every jump request so the list re-jumps even to an unchanged target. */
  readonly jumpRequest = signal(0);
  /** Attachment upload fraction in [0, 1] while a send is uploading, else null. */
  readonly uploadProgress = signal<number | null>(null);

  /** A create-space / create-channel / leave-space action is in flight. */
  readonly spaceBusy = signal(false);
  /** Last space-management failure (surfaced as a toast); null when clear. */
  readonly spaceError = signal<string | null>(null);

  /** Ids of every joined room that is a child of some space, unioned across all spaces.
   * Used to keep space-owned rooms out of the flat Rooms view (they live in their space). */
  private readonly spaceChildRoomIds = computed<Set<string>>(() => {
    const ids = new Set<string>();
    for (const space of this.spaces.spaces()) {
      for (const id of space.childRoomIds) ids.add(id);
    }
    return ids;
  });

  /**
   * Rooms shown in the channel sidebar. Home (`null`, the default) shows only direct
   * messages (`m.direct`) in recency order. The Rooms view shows every non-DM joined
   * room that does not belong to any space (space-owned rooms live under their space).
   * A selected space shows only its joined child rooms, in the space's own order
   * (`m.space.child` `order` then name). All read live signals, so the list reacts to
   * sync, membership, and `m.space.child` changes.
   */
  readonly visibleRooms = computed<RoomSummary[]>(() => {
    const all = this.rooms.rooms();
    const direct = this.rooms.directRoomIds();
    // Rooms view: non-DM joined rooms that aren't owned by a space (overrides the space scope).
    if (this.roomsView()) {
      const inSpace = this.spaceChildRoomIds();
      return all.filter(
        (room) => !direct.has(room.id) && !inSpace.has(room.id),
      );
    }
    const spaceId = this.activeSpaceId();
    if (!spaceId) {
      // Home: direct messages only.
      return all.filter((room) => direct.has(room.id));
    }
    const byId = new Map(all.map((room) => [room.id, room] as const));
    return this.spaces
      .childRoomIds(spaceId)
      .map((id) => byId.get(id))
      .filter((room): room is RoomSummary => room !== undefined);
  });

  readonly activeSpaceName = computed(() => {
    const id = this.activeSpaceId();
    if (!id) {
      return 'Home';
    }
    return this.spaces.spaces().find((s) => s.id === id)?.name ?? 'Home';
  });

  /** Channel-sidebar header: the Rooms view label, a selected space, else Home's DMs. */
  readonly sidebarTitle = computed(() => {
    if (this.roomsView()) {
      return 'Rooms';
    }
    return this.activeSpaceId() ? this.activeSpaceName() : 'Direct Messages';
  });

  /** Total unread notifications across direct-message rooms (Home rail badge). */
  readonly homeUnread = computed(() => {
    const direct = this.rooms.directRoomIds();
    return this.rooms
      .rooms()
      .reduce((sum, r) => (direct.has(r.id) ? sum + r.unreadCount : sum), 0);
  });

  /** Total unread notifications across the Rooms view — non-DM rooms that don't
   * belong to any space (space unread is surfaced on the space pills). */
  readonly roomsUnread = computed(() => {
    const direct = this.rooms.directRoomIds();
    const inSpace = this.spaceChildRoomIds();
    return this.rooms
      .rooms()
      .reduce(
        (sum, r) =>
          direct.has(r.id) || inSpace.has(r.id) ? sum : sum + r.unreadCount,
        0,
      );
  });

  /** Unread notifications summed per space, keyed by space id (space-pill badges). */
  readonly spaceUnread = computed<Record<string, number>>(() => {
    const byId = new Map(this.rooms.rooms().map((r) => [r.id, r] as const));
    const totals: Record<string, number> = {};
    for (const space of this.spaces.spaces()) {
      totals[space.id] = this.spaces
        .childRoomIds(space.id)
        .reduce((sum, id) => sum + (byId.get(id)?.unreadCount ?? 0), 0);
    }
    return totals;
  });

  /** The rail's unread badges bundled into one object input. */
  readonly railUnread = computed<RailUnread>(() => ({
    home: this.homeUnread(),
    rooms: this.roomsUnread(),
    perSpace: this.spaceUnread(),
  }));

  readonly activeRoom = computed(() => {
    const id = this.activeRoomId();
    return id ? (this.rooms.rooms().find((r) => r.id === id) ?? null) : null;
  });

  readonly members = computed(() => {
    // Recompute only when membership actually changes — not on every sync tick or
    // read receipt (those bump `revision`, which the member list doesn't depend on).
    this.rooms.memberRevision();
    return this.rooms.membersOf(this.activeRoomId());
  });

  /** The active account's user id — recomputes when the account is switched. */
  readonly userId = computed(() => this.matrix.activeUserId() ?? '');

  readonly userName = computed(() => {
    const uid = this.userId();
    if (!uid || !this.matrix.isInitialized) {
      return uid;
    }
    return this.matrix.instance.getUser(uid)?.displayName ?? uid;
  });

  readonly userAvatarMxc = computed(() => {
    this.rooms.revision(); // re-read once the user's profile hydrates on sync
    const uid = this.userId();
    if (!uid || !this.matrix.isInitialized) {
      return null;
    }
    return this.matrix.instance.getUser(uid)?.avatarUrl ?? null;
  });

  /** The signed-in user's profile, bundled for the channel sidebar's user panel. */
  readonly userProfile = computed<UserProfile>(() => ({
    userId: this.userId(),
    displayName: this.userName(),
    avatarMxc: this.userAvatarMxc(),
  }));

  /** Every signed-in account, for the user-panel switcher (profile + unread total). */
  readonly accounts = computed<AccountSummary[]>(() => {
    this.rooms.revision(); // re-read each account's profile as it hydrates on sync
    const unread = this.unreadAgg.unreadByAccount();
    return this.matrix.accountIds().map((userId) => {
      const user = this.matrix.clientFor(userId)?.getUser(userId);
      return {
        userId,
        displayName: user?.displayName || userId,
        avatarMxc: user?.avatarUrl ?? null,
        unread: unread.get(userId) ?? 0,
      };
    });
  });

  /** The account currently in view — marks the active row in the switcher. */
  readonly activeAccountId = this.matrix.activeUserId;

  /** Accounts the server signed out that need re-authentication (switcher re-auth rows). */
  readonly reauthAccounts = this.matrix.softLoggedOut;

  readonly syncLabel = computed(() => {
    const state = String(this.matrix.syncState() ?? '');
    if (state === 'PREPARED' || state === 'SYNCING') {
      return 'Welcome to Trinity';
    }
    if (state === 'ERROR' || state === 'RECONNECTING') {
      return 'Reconnecting…';
    }
    return 'Connecting…';
  });

  constructor() {
    // Space-management failures (create/leave) have no inline echo in the shell, so
    // surface each new error as a danger toast. runWithBusy captures the message
    // into spaceError; this reacts to that signal turning non-null.
    effect(() => {
      const message = this.spaceError();
      if (message) {
        void this.showError(message);
      }
    });
    // If every account is gone (e.g. a server-side soft-logout of the last one), the
    // shell has nothing to show — return to login instead of leaving it broken.
    effect(() => {
      if (!this.matrix.activeUserId()) {
        void this.router.navigateByUrl('/login', { replaceUrl: true });
      }
    });
  }

  ngOnInit(): void {
    this.rooms.connect();
    this.spaces.connect();
    this.invites.connect();
    this.crypto.connect();
    this.presence.connect(); // live online-status for member avatars
    // Register for push once the authenticated shell is live (covers both fresh
    // login and a restored session). Best-effort + native-only; no-op elsewhere.
    this.push.register().subscribe({ error: () => undefined });
    // Desktop/web OS notifications from live sync (no-op on native mobile + web
    // without permission). Listener dies with the client on logout/reset.
    this.notifications.connect();
  }

  ngOnDestroy(): void {
    this.timeline.close();
    this.threads.close();
    this.threads.closeThread();
    this.pinned.close();
    this.invites.disconnect();
    this.media.releaseAll();
  }

  /**
   * Global quick switcher. `meta` is Cmd (macOS) and `control` is Ctrl (Win/Linux);
   * Angular auto-unbinds both on destroy, and the chord's modifier means plain typing
   * (including in the composer) never triggers it. `preventDefault` stops the
   * browser's own Cmd/Ctrl+K. Re-entrancy is guarded in {@link QuickSwitcherService}.
   */
  // Angular 21 type-checks host listeners; `document:keydown` is typed as the base
  // `Event`, so accept that and just call the shared `preventDefault`.
  @HostListener('document:keydown.meta.k', ['$event'])
  @HostListener('document:keydown.control.k', ['$event'])
  onQuickSwitch(event: Event): void {
    event.preventDefault();
    void this.openSwitcher();
  }

  /**
   * Open the switcher and jump to the selection: room/DM open the room, space selects
   * it in the rail, a directory person opens (or reuses) a DM, an invite runs the
   * page's existing accept path. Also the header search button's handler.
   *
   * Bail when an overlay already owns the screen: the Cmd/Ctrl+K shortcut fires even
   * while a thread/search/verification modal is open (RoomsPage isn't destroyed), so
   * without this it would stack the switcher over that modal — and picking a result
   * runs onSelectRoom() → media.releaseAll(), revoking the open modal's pinned blobs.
   */
  async openSwitcher(): Promise<void> {
    if (this.dialog.hasOpen()) {
      return; // an overlay owns the screen — don't stack the switcher over it
    }
    const selection = await this.switcher.pick();
    if (!selection) {
      return; // cancelled / already open
    }
    this.jumpTo(selection);
  }

  private jumpTo(selection: SwitcherSelection): void {
    switch (selection.kind) {
      case 'room':
      case 'dm':
        this.onSelectRoom(selection.id);
        break;
      case 'space':
        this.onSelectSpace(selection.id);
        break;
      case 'user':
        this.spaceError.set(null);
        runWithBusy(this.rooms.createDirectMessage(selection.id), {
          busy: this.spaceBusy,
          error: this.spaceError,
          destroyRef: this.destroyRef,
        }).subscribe((roomId) => this.onSelectRoom(roomId));
        break;
      case 'invite':
        this.onAcceptInvite(selection.id);
        break;
    }
  }

  /**
   * Open in-room message search for the active room and, on a chosen hit, jump the
   * timeline to that event. Bumping jumpRequest guarantees the list's jump effect
   * re-fires even when the same message is picked again.
   */
  async openMessageSearch(): Promise<void> {
    const roomId = this.activeRoomId();
    if (!roomId) {
      return;
    }
    const eventId = await this.messageSearch.search(roomId);
    if (!eventId) {
      return; // cancelled / already open
    }
    this.messageSearchTarget.set(eventId);
    this.jumpRequest.update((n) => n + 1);
  }

  onSelectSpace(id: string | null): void {
    // Selecting a space (or Home) leaves the Rooms view.
    this.roomsView.set(false);
    this.activeSpaceId.set(id);
    // Load (or clear, for Home) the space's full child hierarchy so the sidebar can
    // offer not-yet-joined channels + sub-spaces. The fetch is cancelled/replaced if
    // the selection changes again before it lands.
    this.spaces.openSpace(id);
  }

  /** Switch to the Rooms view (non-DM rooms); clears any selected space. */
  onShowRooms(): void {
    this.activeSpaceId.set(null);
    this.roomsView.set(true);
  }

  /** Rail "+": prompt for a name, create the space, then select it on success. */
  async onCreateSpace(): Promise<void> {
    this.spaceError.set(null); // don't carry a stale error into a fresh action
    const name = await this.alert.prompt({
      header: 'Create a space',
      message: 'A space groups related rooms, like a Discord server.',
      placeholder: 'Space name',
      confirmText: 'Create',
      maxLength: 100,
    });
    if (name !== null) {
      this.applyCreateSpace(name);
    }
  }

  /** Sidebar "+": prompt for a name and create a room inside the active space. */
  async onCreateChannel(): Promise<void> {
    const spaceId = this.activeSpaceId();
    if (!spaceId) {
      return; // the affordance is hidden on Home, but guard regardless
    }
    this.spaceError.set(null);
    const name = await this.alert.prompt({
      header: 'Create a channel',
      message: `New channels are end-to-end encrypted and added to “${this.activeSpaceName()}”.`,
      placeholder: 'Channel name',
      confirmText: 'Create',
      maxLength: 100,
    });
    if (name !== null) {
      this.applyCreateChannel(spaceId, name);
    }
  }

  /** Sidebar exit icon: confirm, then leave the active space (back to Home). */
  async onLeaveSpace(): Promise<void> {
    const spaceId = this.activeSpaceId();
    if (!spaceId) {
      return;
    }
    this.spaceError.set(null);
    if (
      await this.alert.confirm({
        header: 'Leave space',
        message: `Leave “${this.activeSpaceName()}”? Its rooms stay on your account — only the space is left.`,
        confirmText: 'Leave',
        destructive: true,
      })
    ) {
      this.applyLeaveSpace(spaceId);
    }
  }

  private applyCreateSpace(name: string): void {
    if (!name.trim()) {
      return; // empty name — dismiss the prompt without creating
    }
    runWithBusy(this.spaces.createSpace({ name }), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe((spaceId) => this.onSelectSpace(spaceId));
  }

  private applyCreateChannel(spaceId: string, name: string): void {
    if (!name.trim()) {
      return;
    }
    // The new room surfaces in the sidebar live via Rooms/Spaces sync listeners.
    runWithBusy(this.spaces.createRoomInSpace(spaceId, { name }), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe();
  }

  private applyLeaveSpace(spaceId: string): void {
    runWithBusy(this.spaces.leaveSpace(spaceId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe(() => this.onSelectSpace(null));
  }

  /** Sidebar "Join" on a not-yet-joined child: join it (via its routing servers). */
  onJoinChild(child: SpaceChildRoom): void {
    this.spaceError.set(null);
    // On success the child lands in the synced read model — a room moves into the
    // joined channel list, a space into the rail — and its `joined` flag flips live,
    // dropping it from the "more channels"/Spaces lists. No manual selection here.
    runWithBusy(this.spaces.joinRoom(child.roomId, child.via), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe();
  }

  /** Sidebar remove icon on a joined channel: confirm, then unlink it from the space. */
  async onRemoveFromSpace(roomId: string): Promise<void> {
    const spaceId = this.activeSpaceId();
    if (!spaceId) {
      return; // the affordance only shows in a space, but guard regardless
    }
    this.spaceError.set(null);
    const name =
      this.rooms.rooms().find((r) => r.id === roomId)?.name ?? 'this channel';
    if (
      await this.alert.confirm({
        header: 'Remove from space',
        message: `Remove “${name}” from “${this.activeSpaceName()}”? You stay in the room — it’s just unlinked from this space.`,
        confirmText: 'Remove',
        destructive: true,
      })
    ) {
      this.applyRemoveFromSpace(spaceId, roomId);
    }
  }

  private applyRemoveFromSpace(spaceId: string, childId: string): void {
    runWithBusy(this.spaces.removeRoomFromSpace(spaceId, childId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe();
  }

  /** Sidebar room ⋮ menu "Leave room": confirm, then leave the room entirely. */
  async onLeaveRoom(roomId: string): Promise<void> {
    const name =
      this.rooms.rooms().find((r) => r.id === roomId)?.name ?? 'this room';
    const confirmed = await this.alert.confirm({
      header: 'Leave room',
      message: `Leave “${name}”? You'll stop receiving its messages and need a new invite (or a public join) to come back.`,
      confirmText: 'Leave',
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    this.rooms
      .leave(roomId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // The room drops from the sidebar via sync. If it was the open one, tear the
        // room panes down (mirroring ngOnDestroy / onSelectRoom) so the timeline,
        // threads, and pinned projections stop listening on a room we just left.
        next: () => {
          if (this.activeRoomId() === roomId) {
            this.activeRoomId.set(null);
            this.timeline.close();
            this.threads.close();
            this.threads.closeThread();
            this.pinned.close();
            this.media.releaseAll();
          }
        },
        error: () => void this.showError('Could not leave the room.'),
      });
  }

  /** Home "+": choose between creating a room, exploring the directory, and a DM. */
  onNewChat(): void {
    this.actionSheet.open({
      header: 'New message',
      buttons: [
        { text: 'Create a room', handler: () => void this.onCreateRoom() },
        {
          text: 'Explore public rooms',
          handler: () => void this.onExploreRooms(),
        },
        {
          text: 'Start a direct message',
          handler: () => void this.onStartDm(),
        },
        { text: 'Cancel', role: 'cancel' },
      ],
    });
  }

  /** Browse the public directory; open a room — or select a space — joined from it. */
  async onExploreRooms(): Promise<void> {
    const joined = await this.dialog.openAndWait<DirectoryJoin | null>(
      RoomDirectoryComponent,
    );
    if (!joined) {
      return;
    }
    if (joined.isSpace) {
      // A joined space lands in the rail — select it there.
      this.onSelectSpace(joined.roomId);
    } else {
      // A joined public room is a spaceless non-DM, so it lives in the Rooms view
      // (Home shows DMs only) — switch there so it's listed, then open it.
      this.onShowRooms();
      this.onSelectRoom(joined.roomId);
    }
  }

  /** Move to a room's upgraded successor (from the tombstone banner): join it, then open it. */
  onGoToUpgradedRoom(roomId: string): void {
    this.spaceError.set(null);
    runWithBusy(this.publicRooms.join(roomId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe((joinedId) => {
      // Surface the successor in the sidebar (Home shows DMs only) so it isn't
      // opened-but-invisible, mirroring onExploreRooms.
      this.onShowRooms();
      this.onSelectRoom(joinedId);
    });
  }

  /** Prompt for a name, create a standalone encrypted room, then select it. */
  async onCreateRoom(): Promise<void> {
    this.spaceError.set(null);
    const name = await this.alert.prompt({
      header: 'Create a room',
      message: 'New rooms are end-to-end encrypted.',
      placeholder: 'Room name',
      confirmText: 'Create',
      maxLength: 100,
    });
    if (name !== null) {
      this.applyCreateRoom(name);
    }
  }

  /** Pick a user (MXID or directory), open/reuse a DM with them, then select it. */
  async onStartDm(): Promise<void> {
    this.spaceError.set(null);
    const userId = await this.userPicker.pick({
      title: 'Start a direct message',
      confirmLabel: 'Message',
    });
    if (!userId) {
      return; // cancelled
    }
    runWithBusy(this.rooms.createDirectMessage(userId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe((roomId) => this.onSelectRoom(roomId));
  }

  /** Open-room header: invite a user to the active room. */
  async onInviteToRoom(): Promise<void> {
    const roomId = this.activeRoomId();
    if (roomId) {
      await this.invitePeople(roomId, this.activeRoom()?.name ?? 'this room');
    }
  }

  /** Space sidebar: invite a user to the active space. */
  async onInviteToSpace(): Promise<void> {
    const spaceId = this.activeSpaceId();
    if (spaceId) {
      await this.invitePeople(spaceId, this.activeSpaceName());
    }
  }

  /** Accept a pending invite (join); select the joined room when it's not a space. */
  onAcceptInvite(roomId: string): void {
    this.spaceError.set(null);
    const invite = this.invites
      .pendingInvites()
      .find((i) => i.roomId === roomId);
    runWithBusy(this.invites.acceptInvite(roomId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe(() => {
      // A joined room/DM lives under Home; surface it by switching there and
      // opening it. A joined space just appears in the rail (no auto-select).
      if (invite && !invite.isSpace) {
        this.onSelectSpace(null);
        this.onSelectRoom(roomId);
      }
    });
  }

  /** Decline a pending invite (leave the invited room/space). */
  onDeclineInvite(roomId: string): void {
    this.spaceError.set(null);
    runWithBusy(this.invites.declineInvite(roomId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe();
  }

  private applyCreateRoom(name: string): void {
    if (!name.trim()) {
      return; // empty name — dismiss without creating
    }
    runWithBusy(this.rooms.createRoom({ name }), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe((roomId) => this.onSelectRoom(roomId));
  }

  /** Shared invite flow for a room or space: pick a user, invite, then toast. */
  private async invitePeople(targetId: string, label: string): Promise<void> {
    this.spaceError.set(null);
    const userId = await this.userPicker.pick({
      title: `Invite to ${label}`,
      confirmLabel: 'Invite',
    });
    if (!userId) {
      return; // cancelled
    }
    runWithBusy(this.rooms.inviteUser(targetId, userId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe(() => void this.showSuccess(`Invitation sent to ${userId}.`));
  }

  onSelectRoom(id: string): void {
    // Drop the previous room's resolved media URLs before switching timelines.
    this.media.releaseAll();
    this.activeRoomId.set(id);
    this.timeline.open(id);
    this.threads.open(id); // project this room's thread summaries for indicators
    this.pinned.open(id); // project this room's pinned messages
    this.closeDrawer(); // collapse the drawer on mobile after picking a room
  }

  /**
   * Route a `matrix.to` permalink clicked in a message, in-app. A user shows a profile
   * card (from which the viewer can start a DM); a room resolves its id/alias and — if
   * we're joined — opens it, then jumps to a linked event. A room we haven't joined
   * surfaces a toast rather than navigating.
   */
  onMatrixLink(target: MatrixLinkTarget): void {
    if (target.kind === 'user') {
      void this.openUserCard(target.userId);
      return;
    }
    this.rooms
      .resolveRoomId(target.roomIdOrAlias)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (roomId) => this.openLinkedRoom(roomId, target.eventId),
        error: () => void this.showError('Could not open that room.'),
      });
  }

  /** Show the user card; if they pick "Message", open (or reuse) a DM with the user. */
  private async openUserCard(userId: string): Promise<void> {
    const messageUserId = await this.userCard.open(userId);
    if (messageUserId) {
      this.startDirectMessage(messageUserId);
    }
  }

  /** Member-list row: open the member's info panel; "Message" opens/reuses a DM. */
  onSelectMember(member: MemberSummary): void {
    const roomId = this.activeRoomId();
    if (roomId) {
      void this.openMemberInfo(member, roomId);
    }
  }

  private async openMemberInfo(
    member: MemberSummary,
    roomId: string,
  ): Promise<void> {
    // Kick/ban actions are gated by the viewer's power over this member; the panel
    // resolves a user id only for "Message" (kick/ban close it themselves via sync).
    const caps = this.moderation.canModerate(roomId, member.userId);
    const messageUserId = await this.memberInfo.open(member, roomId, caps);
    if (messageUserId) {
      this.startDirectMessage(messageUserId);
    }
  }

  /** Open (or reuse) a direct message with `userId` and navigate to it. */
  private startDirectMessage(userId: string): void {
    runWithBusy(this.rooms.createDirectMessage(userId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe((roomId) => this.onSelectRoom(roomId));
  }

  /** Open a resolved room if joined (jumping to `eventId` when given), else toast. */
  private openLinkedRoom(roomId: string, eventId?: string): void {
    if (!this.rooms.rooms().some((r) => r.id === roomId)) {
      void this.showError("You're not in that room.");
      return;
    }
    if (roomId !== this.activeRoomId()) {
      this.onSelectRoom(roomId);
    }
    if (eventId) {
      // Jump to the linked event (a no-op until it's in the loaded timeline).
      this.messageSearchTarget.set(eventId);
      this.jumpRequest.update((n) => n + 1);
    }
  }

  /** Toggle the mobile navigation drawer (no-op visual at md+, where it's static). */
  toggleDrawer(): void {
    this.drawerOpen.update((open) => !open);
  }

  /** Close the mobile navigation drawer. */
  closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  /** Show/hide the right-hand member list from the toolbar. */
  toggleMembers(): void {
    this.membersOpen.update((open) => !open);
  }

  /** Open the thread rooted at `rootEventId` (raised by a message's indicator). */
  onOpenThread(rootEventId: string): void {
    const roomId = this.activeRoomId();
    if (roomId) {
      void this.threadPanel.open(roomId, rootEventId);
    }
  }

  /** Sidebar room ⋮ menu: apply a chosen notification level (all / mentions / mute). */
  onSetNotifyMode({
    roomId,
    mode,
  }: {
    roomId: string;
    mode: RoomNotifyMode;
  }): void {
    this.setNotifyMode(roomId, mode);
  }

  private setNotifyMode(roomId: string, mode: RoomNotifyMode): void {
    this.roomNotifications
      .setMode(roomId, mode)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => void this.showError('Could not update notifications.'),
      });
  }

  /** Mark a single room read (from its ⋮ menu); the badge clears via sync. */
  onMarkRead(roomId: string): void {
    this.rooms
      .markRead(roomId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => void this.showError('Could not mark the room read.'),
      });
  }

  /** Mark the currently-visible unread rooms read (header action). Scoped to the
   * sidebar's rooms so it matches the button, which is gated on their unread state. */
  onMarkAllRead(): void {
    this.rooms
      .markAllRead(this.visibleRooms().map((room) => room.id))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => void this.showError('Could not mark rooms read.'),
      });
  }

  /** Header "Room settings": edit the active room's name and topic in a dialog. */
  onOpenRoomSettings(): void {
    const room = this.activeRoom();
    if (!room) {
      return;
    }
    const editable = this.roomSettings.editableFields(room.id);
    const access = this.roomSettings.currentAccess(room.id);
    // The dialog writes on save; the name/topic/access update live via the rooms
    // sync listeners, so nothing to do with the resolved result here.
    void this.dialog.openAndWait(RoomSettingsComponent, {
      inputs: {
        roomId: room.id,
        name: room.name,
        topic: room.topic,
        avatarMxc: room.avatarMxc,
        joinRule: access.joinRule,
        historyVisibility: access.historyVisibility,
        canEditName: editable.name,
        canEditTopic: editable.topic,
        canEditAvatar: editable.avatar,
        canEditJoinRule: editable.joinRule,
        canEditHistory: editable.history,
        canManageBans: this.moderation.canManageBans(room.id),
        canManageAliases: this.aliases.canManageAliases(room.id),
      },
    });
  }

  /** Open the threads-list panel for the active room (header "Threads" button). */
  openThreadsList(): void {
    const roomId = this.activeRoomId();
    if (roomId) {
      void this.threadPanel.openList(roomId);
    }
  }

  /** Pin or unpin a message from its overflow menu, resolving which by current state. */
  onTogglePin(eventId: string): void {
    if (this.pinned.isPinned(eventId)) {
      this.pinned.unpin(eventId);
    } else {
      this.pinned.pin(eventId);
    }
  }

  /**
   * Open the pinned-messages panel for the active room and, on a chosen row, jump the
   * timeline to that event. Bumping jumpRequest guarantees the list's jump effect
   * re-fires even when the same message is picked again (as in-room search does).
   */
  async openPinnedPanel(): Promise<void> {
    const eventId = await this.pinnedPanel.openPanel();
    if (!eventId) {
      return; // cancelled / already open / just closed
    }
    this.messageSearchTarget.set(eventId);
    this.jumpRequest.update((n) => n + 1);
  }

  loadOlder(): void {
    this.timeline
      .loadOlder()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  onSend({ body, mentions }: { body: string; mentions: Mention[] }): void {
    // The local echo (and its failed/retry state) surfaces the result.
    this.timeline
      .send(body, mentions)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Composer typing state → a (throttled) Matrix typing notification for the room. */
  onTyping(typing: boolean): void {
    this.timeline.setTyping(typing);
  }

  /** Cast a vote on a poll (m.poll.response). */
  onPollVote({ pollId, answerId }: { pollId: string; answerId: string }): void {
    this.runAction(
      this.timeline.votePoll(pollId, answerId),
      'Could not cast your vote.',
    );
  }

  /** Close a poll (m.poll.end). */
  onPollEnd(pollId: string): void {
    this.runAction(this.timeline.endPoll(pollId), 'Could not end the poll.');
  }

  onSendMedia({ file, caption }: { file: File; caption: string }): void {
    // The upload phase has no echo, so drive a determinate progress bar from the
    // upload fraction and surface a failure as a toast. Once the event is sent the
    // SDK echo + retry path takes over (like onSend). finalize() clears the bar on
    // success, error, or unsubscribe — runAction has no such hook, so subscribe here.
    this.uploadProgress.set(0);
    this.timeline
      .sendMedia(file, caption, (fraction) => this.uploadProgress.set(fraction))
      .pipe(
        finalize(() => this.uploadProgress.set(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: () => void this.showError('Could not upload the attachment.'),
      });
  }

  // Edit/delete/react have no visible local echo, so a failure would otherwise be
  // silent — surface it as a toast. (Send/reply produce an echo with a retry.)
  onEdit(edit: { id: string; body: string; mentions: Mention[] }): void {
    this.runAction(
      this.timeline.edit(edit.id, edit.body, edit.mentions),
      'Could not edit the message.',
    );
  }

  onDelete(messageId: string): void {
    this.runAction(
      this.timeline.redact(messageId),
      'Could not delete the message.',
    );
  }

  onReact(reaction: { id: string; key: string }): void {
    this.runAction(
      this.timeline.toggleReaction(reaction.id, reaction.key),
      'Could not update the reaction.',
    );
  }

  onReply(reply: { id: string; body: string; mentions: Mention[] }): void {
    this.timeline
      .reply(reply.id, reply.body, reply.mentions)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Run a fire-and-forget timeline action, surfacing a failure as a toast. */
  private runAction(action: Observable<void>, failureMessage: string): void {
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: () => void this.showError(failureMessage),
    });
  }

  private showError(message: string): void {
    this.toast.show(message, { duration: 4000, variant: 'destructive' });
  }

  private showSuccess(message: string): void {
    this.toast.show(message, { duration: 3000, variant: 'success' });
  }

  goToSettings(): void {
    void this.router.navigateByUrl('/settings');
  }

  /** Switch the active account (no-op when it is already active). */
  switchAccount(userId: string): void {
    if (userId === this.matrix.activeUserId()) {
      return;
    }
    this.auth
      .switchAccount(userId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Start adding another account: route to the login screen in add mode. */
  addAccount(): void {
    void this.router.navigate(['/login'], { queryParams: { add: 1 } });
  }

  /** Re-authenticate a soft-logged-out account: route to the login prefilled for it. */
  reauthAccount(userId: string): void {
    void this.router.navigate(['/login'], { queryParams: { reauth: userId } });
  }

  async logout(userId: string): Promise<void> {
    const confirmed = await this.alert.confirm({
      header: 'Sign out',
      message: 'Sign out of this account on this device?',
      confirmText: 'Sign out',
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    // Captured before the sign-out mutates the registry: signing out the last
    // account tears everything down → back to login; otherwise another account is
    // now active and we stay in the shell.
    const wasLastAccount = this.matrix.accountIds().length <= 1;
    this.auth
      .logout(userId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (wasLastAccount) {
          void this.router.navigateByUrl('/login', { replaceUrl: true });
        }
      });
  }
}
