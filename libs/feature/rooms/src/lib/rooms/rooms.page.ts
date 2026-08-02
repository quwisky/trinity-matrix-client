// Installs syntax highlighting for fenced code blocks, by side effect on module eval.
// Imported HERE rather than from util-matrix's barrel on purpose: message-view.ts (which
// consumes the highlighter) is in the eager bundle, so a barrel export would put every
// grammar in the initial chunk. This route is lazily loaded, so the grammars land in the
// rooms chunk — and it evaluates before any message view is projected.
import '@trinity/util/matrix/code-highlight';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  OnDestroy,
  OnInit,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Observable, finalize, forkJoin } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideEllipsisVertical,
  lucideLock,
  lucideMessagesSquare,
  lucidePin,
  lucideSearch,
  lucideSettings,
  lucideUserPlus,
  lucideUsers,
} from '@ng-icons/lucide';
import { HlmButton } from '@trinity/helm/button';
import {
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';
import { HlmTooltip } from '@trinity/helm/tooltip';
import {
  TrnActionSheetService,
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/helm/overlay';
import { AuthService } from '@trinity/data-access/auth';
import { CryptoService } from '@trinity/data-access/crypto';
import {
  InvitesService,
  MixedInvitesService,
  type PendingInvite,
} from '@trinity/data-access/invites';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MediaService } from '@trinity/data-access/media';
import {
  NotificationService,
  PushService,
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access/notifications';
import { PinnedMessagesService } from '@trinity/data-access/pinned';
import { PresenceService } from '@trinity/data-access/profile';
import {
  RoomsService,
  RoomSettingsService,
  RoomModerationService,
  RoomAliasesService,
  PublicRoomsService,
  SpaceChildrenService,
  SpacesService,
  AccountScopeService,
  MixedRoomsService,
  MixedSpacesService,
  UnreadAggregatorService,
  SpaceRoomOrderService,
  type MemberSummary,
  type RoomSortMode,
  type RoomSummary,
  type SpaceChildRoom,
} from '@trinity/data-access/rooms';
import { MemberInfoService } from '../member-info/member-info.service';
import { type SwitcherSelection } from '@trinity/data-access/search';
import { ThreadsService, TimelineService } from '@trinity/data-access/timeline';
import { type MatrixLinkTarget, type Mention } from '@trinity/util/matrix';
import {
  FeatureFlagsService,
  KeyboardShortcutsService,
} from '@trinity/platform-native';
import { AvatarComponent, PageHeaderComponent, runWithBusy } from '@trinity/ui';
import { AccountBadgesService } from '../shared/account-badges.service';
import { UserPickerService } from '../user-picker/user-picker.service';
import { UserCardService } from '../user-card/user-card.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { MruRoomsService } from '../shortcuts/mru-rooms.service';
import { stepList, stepUnread } from '../shortcuts/room-navigation';
import { MessageSearchService } from '../message-search/message-search.service';
import { ServerRailComponent } from '../server-rail/server-rail.component';
import { ChannelSidebarComponent } from '../channel-sidebar/channel-sidebar.component';
import { MemberListComponent } from '../member-list/member-list.component';
import { SimpleMessageListComponent } from '../message-list/simple-message-list/simple-message-list.component';
import { VirtualMessageListComponent } from '../message-list/virtual-message-list/virtual-message-list.component';
import { EncryptionBannerComponent } from '../encryption-banner/encryption-banner.component';
import { ConnectivityBannerComponent } from '../connectivity-banner/connectivity-banner.component';
import { TombstoneBannerComponent } from '../tombstone-banner/tombstone-banner.component';
import { ThreadPanelService } from '../thread/thread-panel.service';
import { PinnedPanelService } from '../pinned/pinned-panel.service';
import { RoomShellStore } from './room-shell-store';
import { ShellStatusService } from './shell-status.service';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { MemberActionsService } from './member-actions.service';
import { AccountRoutingService } from './account-routing.service';
import { InviteActionsService } from './invite-actions.service';
import { SpaceActionsService } from './space-actions.service';
import { RoomActionsService } from './room-actions.service';
import { isMobileMasterDetail, membersShownAsDrawer } from './shell-layout';

/**
 * Discord-style authenticated shell: server rail + channel sidebar (in a
 * responsive Tailwind drawer — static column at md+, slide-in below), the read
 * timeline, and a member list.
 * Wired to live synced rooms via `RoomsService` + `TimelineService`.
 */
@Component({
  selector: 'trn-rooms',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Page-scoped, not root: these share the page's lifetime and its DestroyRef, which is
  // what every runWithBusy subscription is tied to. See shell-invariants.spec.ts.
  providers: [
    RoomShellStore,
    ShellStatusService,
    RoomShellViewModel,
    RoomShellNavigationService,
    MemberActionsService,
    AccountRoutingService,
    InviteActionsService,
    SpaceActionsService,
    RoomActionsService,
  ],
  templateUrl: 'rooms.page.html',
  styleUrls: ['rooms.page.scss'],
  imports: [
    PageHeaderComponent,
    HlmButton,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuTrigger,
    HlmTooltip,
    NgIcon,
    AvatarComponent,
    ServerRailComponent,
    ChannelSidebarComponent,
    MemberListComponent,
    SimpleMessageListComponent,
    VirtualMessageListComponent,
    EncryptionBannerComponent,
    ConnectivityBannerComponent,
    TombstoneBannerComponent,
  ],
  host: {
    // One delegating listener for every global shortcut: the quick switcher and the
    // room-switching keys all resolve through KeyboardShortcutsService, so a binding is
    // defined (and configurable) in one place. It bails on the first line unless a
    // modifier is held, so plain typing pays almost nothing. Escape stays a dedicated
    // binding — it's a contextual dismiss, not a configurable navigation shortcut.
    '(document:keydown)': 'onGlobalKeydown($event)',
    '(document:keydown.escape)': 'onEscapeKey()',
  },
  viewProviders: [
    provideIcons({
      lucideArrowLeft,
      lucideEllipsisVertical,
      lucideLock,
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
  private readonly spaceChildren = inject(SpaceChildrenService);
  private readonly mixedRooms = inject(MixedRoomsService);
  private readonly mixedSpaces = inject(MixedSpacesService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly spaceOrder = inject(SpaceRoomOrderService);
  private readonly mixedInvites = inject(MixedInvitesService);
  private readonly accountBadgesSvc = inject(AccountBadgesService);
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
  private readonly mru = inject(MruRoomsService);
  private readonly shortcuts = inject(KeyboardShortcutsService);
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
  private readonly injector = inject(Injector);
  private readonly store = inject(RoomShellStore);
  private readonly status = inject(ShellStatusService);
  private readonly vm = inject(RoomShellViewModel);
  private readonly nav = inject(RoomShellNavigationService);
  private readonly members_ = inject(MemberActionsService);
  private readonly routing = inject(AccountRoutingService);
  private readonly inviteActions = inject(InviteActionsService);
  private readonly spaceActions = inject(SpaceActionsService);
  private readonly roomActions = inject(RoomActionsService);

  readonly activeSpaceId = this.store.activeSpaceId;
  /**
   * Whether the Recent activity view is active — the default on launch. It lists every
   * joined DM + room (space-owned included), mixed by recency, so it overrides the
   * Home/Rooms/space scoping below. Cleared by selecting Home, Rooms, or a space.
   */
  readonly recentView = this.store.recentView;
  /** Whether the Rooms view is active — filters the sidebar to non-DM rooms. Home (no
   * space) shows direct messages only; Recent, a space, or this view clears the others. */
  readonly roomsView = this.store.roomsView;
  readonly activeRoomId = this.store.activeRoomId;

  /**
   * The accounts the view draws from — the user's picker selection, persisted and always
   * including the active account. When it names more than one, mixed mode governs **every**
   * surface: the Recent list, Home's DMs, the Rooms list, and the rail's space pills.
   */
  readonly shownAccountIds = this.accountScope.selected;
  /** Whether the cross-account projection is active (more than one account selected). */
  readonly mixedOn = this.accountScope.mixing;

  // The two mobile pages (the rail/room-list and the chat), focused on a view switch
  // so keyboard/screen-reader focus follows to the newly-shown page (see focusActiveView).
  private readonly listView = viewChild<ElementRef<HTMLElement>>('listView');
  private readonly mainView = viewChild<ElementRef<HTMLElement>>('mainView');
  /**
   * Whether the member list is shown. At the wide (≥1100px) layout it's the static
   * right column, shown by default; below that it's an overlay drawer that must start
   * closed. Seeded from the viewport so the drawer doesn't render open on a mobile
   * load, while the wide layout keeps the column visible by default.
   */
  readonly membersOpen = this.store.membersOpen;
  /**
   * Event id the message list should scroll to, set by in-room search, a reply
   * preview, or the pinned panel. Bound to the list's `jumpToId`, paired with
   * {@link jumpRequest} so re-selecting the SAME message still re-triggers the jump.
   */
  readonly messageSearchTarget = this.store.messageSearchTarget;
  /** Bumped on every jump request so the list re-jumps even to an unchanged target. */
  readonly jumpRequest = this.store.jumpRequest;
  /** Attachment upload fraction in [0, 1] while a send is uploading, else null. */
  readonly uploadProgress = signal<number | null>(null);

  /** A create-space / create-channel / leave-space action is in flight. */
  readonly spaceBusy = this.status.busy;
  /** Last space-management failure (surfaced as a toast); null when clear. */
  readonly spaceError = this.status.error;

  /**
   * Derived shell state. Each field is the SAME signal object the view model exposes,
   * aliased here so the template and the spec keep reading it off the page.
   */
  readonly visibleRooms = this.vm.visibleRooms;
  readonly spaceSortMode = this.vm.spaceSortMode;
  readonly spaceSortOverridden = this.vm.spaceSortOverridden;
  readonly defaultSpaceSortMode = this.vm.defaultSpaceSortMode;
  readonly activeSpaceName = this.vm.activeSpaceName;
  readonly sidebarTitle = this.vm.sidebarTitle;
  readonly recentUnread = this.vm.recentUnread;
  readonly homeUnread = this.vm.homeUnread;
  readonly roomsUnread = this.vm.roomsUnread;
  readonly spaceUnread = this.vm.spaceUnread;
  readonly railUnread = this.vm.railUnread;
  readonly activeRoom = this.vm.activeRoom;
  readonly members = this.vm.members;
  readonly activeRoomIsDirect = this.vm.activeRoomIsDirect;
  readonly userId = this.vm.userId;
  readonly userName = this.vm.userName;
  readonly userAvatarMxc = this.vm.userAvatarMxc;
  readonly userInitial = this.vm.userInitial;
  readonly userProfile = this.vm.userProfile;
  readonly accounts = this.vm.accounts;
  readonly activeAccountId = this.vm.activeAccountId;
  readonly railSpaces = this.vm.railSpaces;
  readonly canCurateSpace = this.vm.canCurateSpace;
  readonly canConfigureSpace = this.vm.canConfigureSpace;
  readonly accountBadges = this.vm.accountBadges;
  readonly reauthAccounts = this.vm.reauthAccounts;
  readonly syncLabel = this.vm.syncLabel;

  constructor() {
    // Space-management failures (create/leave) have no inline echo in the shell, so
    // surface each new error as a danger toast. runWithBusy captures the message
    // into spaceError; this reacts to that signal turning non-null.
    effect(() => {
      const message = this.spaceError();
      if (message) {
        void this.status.showError(message);
      }
    });
    // If every account is gone (e.g. a server-side soft-logout of the last one), the
    // shell has nothing to show — return to login instead of leaving it broken.
    effect(() => {
      if (!this.matrix.activeUserId()) {
        void this.router.navigateByUrl('/login', { replaceUrl: true });
      }
    });
    // Point the cross-account projections at the selected accounts. They attach listeners
    // only for those accounts (and none at all below two), so an unmixed session costs
    // nothing. `selected` is set-equal-compared, so this doesn't churn on every sync tick.
    effect(() => {
      const accounts = this.shownAccountIds();
      this.mixedRooms.setAccounts(accounts);
      this.mixedSpaces.setAccounts(accounts);
      this.mixedInvites.setAccounts(accounts);
    });
  }

  ngOnInit(): void {
    // The service cannot read the page's viewChild refs, so hand it the focus call.
    this.nav.bindFocus(() => this.focusActiveView());
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
    this.closeOpenRoom();
    this.invites.disconnect();
  }

  /**
   * Global keyboard shortcuts (issues #12/#13). One listener rather than many host
   * bindings: it bails unless a modifier is held (so plain typing is untouched) and no
   * overlay owns the screen (mirrors {@link openSwitcher}'s guard), then asks
   * {@link KeyboardShortcutsService} which shortcut the chord triggers — honouring the
   * user's custom bindings and the desktop-only gate — and dispatches it. The bindings
   * themselves live in the registry (and the settings page); this only maps an id to its
   * action.
   */
  onGlobalKeydown(event: Event): void {
    const e = event as KeyboardEvent;
    if ((!e.ctrlKey && !e.metaKey && !e.altKey) || this.dialog.hasOpen()) {
      return;
    }
    const hit = this.shortcuts.resolve(e);
    if (!hit) {
      return;
    }
    // preventDefault belongs to the branches that act, NOT to "the catalogue matched". The
    // catalogue also holds the composer's formatting shortcuts, which this handler knows
    // nothing about — blocking those here would swallow Ctrl+B app-wide and do nothing with
    // it. An id we do not handle must fall through to the browser untouched.
    switch (hit.id) {
      case 'switcher.open':
        e.preventDefault();
        void this.openSwitcher();
        break;
      case 'room.hop.back':
        e.preventDefault();
        this.hopRoom('back');
        break;
      case 'room.hop.forward':
        e.preventDefault();
        this.hopRoom('forward');
        break;
      case 'room.walk.down':
        e.preventDefault();
        this.walkList('next');
        break;
      case 'room.walk.up':
        e.preventDefault();
        this.walkList('previous');
        break;
      case 'room.walk.unread.down':
        e.preventDefault();
        this.walkUnread('next');
        break;
      case 'room.walk.unread.up':
        e.preventDefault();
        this.walkUnread('previous');
        break;
      case 'room.jump':
        if (hit.digit) {
          e.preventDefault();
          this.openShortcutTarget(
            this.mru.nth(hit.digit, this.activeRoomId()),
            'user',
          );
        }
        break;
    }
  }

  private hopRoom(direction: 'back' | 'forward'): void {
    // Across every mixed account, not just the active one — otherwise hopping back to a
    // room you opened on another account silently does nothing.
    const known = new Set(this.knownRooms().map((room) => room.id));
    this.openShortcutTarget(
      this.mru.hop(direction, this.activeRoomId(), known),
      'hop',
    );
  }

  private walkList(direction: 'next' | 'previous'): void {
    this.openShortcutTarget(
      stepList(
        this.visibleRooms().map((room) => room.id),
        this.activeRoomId(),
        direction,
      ),
      'user',
    );
  }

  private walkUnread(direction: 'next' | 'previous'): void {
    this.openShortcutTarget(
      stepUnread(this.visibleRooms(), this.activeRoomId(), direction),
      'user',
    );
  }

  /**
   * Open a shortcut's resolved target when there is one and it isn't already open. The MRU
   * remembers rooms across account switches, so a target can name a room no account in the
   * current scope holds (it was unticked, or signed out) — opening that would tear down the
   * timeline and leave a blank chat pane, so drop it instead.
   */
  private openShortcutTarget(
    roomId: string | null,
    source: 'user' | 'hop',
  ): void {
    if (!roomId || roomId === this.activeRoomId()) {
      return;
    }
    if (!this.knownRooms().some((room) => room.id === roomId)) {
      return;
    }
    this.onSelectRoomRow(roomId, source);
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
        // Via the row path, so picking a mixed-in account's room switches to that account
        // before opening it — otherwise the jump would land on the wrong client.
        this.onSelectRoomRow(selection.id);
        break;
      case 'space':
        this.onSelectSpaceRow(selection.id);
        break;
      case 'user':
        this.spaceError.set(null);
        runWithBusy(
          this.rooms.createDirectMessage(selection.id),
          this.status,
        ).subscribe((roomId) => this.onSelectRoom(roomId));
        break;
      case 'invite':
        this.onAcceptInvite({ roomId: selection.id });
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

  /** Show the Recent activity view. */
  onShowRecent(): void {
    this.nav.onShowRecent();
  }

  /** Select a space (or Home when null). */
  onSelectSpace(id: string | null): void {
    this.nav.onSelectSpace(id);
  }

  /** Show the flat Rooms view. */
  onShowRooms(): void {
    this.nav.onShowRooms();
  }

  onCreateSpace(): Promise<void> {
    return this.spaceActions.onCreateSpace();
  }

  onCreateSubspace(): Promise<void> {
    return this.spaceActions.onCreateSubspace();
  }

  onCreateChannel(): Promise<void> {
    return this.spaceActions.onCreateChannel();
  }

  onLeaveSpace(): Promise<void> {
    return this.spaceActions.onLeaveSpace();
  }

  /** Join a suggested/known child room of the open space. */
  onJoinChild(child: SpaceChildRoom): void {
    this.spaceActions.onJoinChild(child);
  }

  onRemoveFromSpace(roomId: string): Promise<void> {
    return this.spaceActions.onRemoveFromSpace(roomId);
  }

  /** Leave a room after confirmation; may belong to another account. */
  onLeaveRoom(target: { roomId: string; accountId?: string }): Promise<void> {
    return this.roomActions.onLeaveRoom(target);
  }

  /** The composer-adjacent "new chat" action sheet. */
  onNewChat(): void {
    this.roomActions.onNewChat();
  }

  onExploreRooms(): Promise<void> {
    return this.roomActions.onExploreRooms();
  }

  /** Follow a tombstone to the room that replaced this one. */
  onGoToUpgradedRoom(roomId: string): void {
    this.roomActions.onGoToUpgradedRoom(roomId);
  }

  onCreateRoom(): Promise<void> {
    return this.roomActions.onCreateRoom();
  }

  onStartDm(): Promise<void> {
    return this.roomActions.onStartDm();
  }

  onInviteToRoom(): Promise<void> {
    return this.roomActions.onInviteToRoom();
  }

  onInviteToSpace(): Promise<void> {
    return this.roomActions.onInviteToSpace();
  }

  /** Accept an invite and open the room, switching account if it is not the active one. */
  onAcceptInvite(invite: { roomId: string; accountId?: string }): void {
    this.inviteActions.onAcceptInvite(invite);
  }

  private knownInvites(): readonly PendingInvite[] {
    return this.inviteActions.knownInvites();
  }

  /** Decline an invite. */
  onDeclineInvite(invite: { roomId: string; accountId?: string }): void {
    this.inviteActions.onDeclineInvite(invite);
  }

  /** A sidebar room row was picked; may belong to another account. */
  onSelectRoomRow(id: string, source: 'user' | 'hop' = 'user'): void {
    this.routing.onSelectRoomRow(id, source);
  }

  /** A rail space pill was picked; may belong to another account. */
  onSelectSpaceRow(id: string | null): void {
    this.routing.onSelectSpaceRow(id);
  }

  /** Toggle whether an account contributes to the mixed view. */
  onToggleAccountShown(userId: string): void {
    this.routing.onToggleAccountShown(userId);
  }

  private knownRooms(): RoomSummary[] {
    return this.nav.knownRooms();
  }

  private accountLabel(accountId: string): string {
    return this.routing.accountLabel(accountId);
  }

  private runOnAccount(accountId: string, then: () => void): void {
    this.routing.runOnAccount(accountId, then);
  }

  /** Open a room. `source` distinguishes a user click from a keyboard hop. */
  onSelectRoom(id: string, source: 'user' | 'hop' = 'user'): void {
    this.nav.onSelectRoom(id, source);
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
        error: () => void this.status.showError('Could not open that room.'),
      });
  }

  private openUserCard(userId: string): Promise<void> {
    return this.members_.openUserCard(userId);
  }

  /** A member row was picked in the list. */
  onSelectMember(member: MemberSummary): void {
    this.members_.onSelectMember(member);
  }

  private openMemberInfo(member: MemberSummary, roomId: string): Promise<void> {
    return this.members_.openMemberInfo(member, roomId);
  }

  private startDirectMessage(userId: string): void {
    this.members_.startDirectMessage(userId);
  }

  private openLinkedRoom(roomId: string, eventId?: string): void {
    this.routing.openLinkedRoom(roomId, eventId);
  }

  /**
   * Mobile: leave the open conversation and return to the room-list page. Below the
   * md breakpoint the rail + sidebar and the chat are separate full-screen pages
   * (keyed off `activeRoomId`); at md+ both columns are static and this is unused.
   */
  backToList(): void {
    this.closeOpenRoom();
    this.focusActiveView();
  }

  /**
   * On the mobile master-detail layout, move focus to the page that just became
   * visible (the chat when a room is open, else the room list) once it renders — the
   * other page is display:none'd, so otherwise focus falls to `<body>`. At md+ both
   * pages are always visible, so focus is left where it is.
   */
  private focusActiveView(): void {
    if (!isMobileMasterDetail()) {
      return;
    }
    afterNextRender(
      () => {
        const view = this.activeRoomId() ? this.mainView() : this.listView();
        view?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  /** Show/hide the member list from the toolbar / overflow menu. */
  toggleMembers(): void {
    this.membersOpen.update((open) => !open);
  }

  /** Close the member list — used by the mobile drawer's backdrop. */
  closeMembers(): void {
    this.membersOpen.set(false);
  }

  /**
   * Escape dismisses the mobile members drawer (its backdrop is mouse-only). Scoped to
   * when the drawer is actually open so it never swallows Escape elsewhere; a member's
   * info panel is a CDK dialog that closes the drawer as it opens, so there's no clash.
   */
  onEscapeKey(): void {
    if (this.membersOpen() && membersShownAsDrawer()) {
      this.closeMembers();
    }
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
    accountIds,
  }: {
    roomId: string;
    mode: RoomNotifyMode;
    accountIds?: readonly string[];
  }): void {
    this.setNotifyMode(roomId, mode, accountIds);
  }

  /** Apply a notification level on every account joined to the row — a merged row shows one
   * menu, so muting it must actually mute the room everywhere it is contributing. */
  private setNotifyMode(
    roomId: string,
    mode: RoomNotifyMode,
    accountIds?: readonly string[],
  ): void {
    const targets = accountIds?.length ? accountIds : [undefined];
    forkJoin(
      targets.map((accountId) =>
        this.roomNotifications.setMode(roomId, mode, accountId),
      ),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () =>
          void this.status.showError('Could not update notifications.'),
      });
  }

  /** Mark a single room read (from its ⋮ menu); the badge clears via sync. Acked on the
   * row's own account, which in the mixed view need not be the active one. */
  onMarkRead({
    roomId,
    accountIds,
  }: {
    roomId: string;
    accountIds?: readonly string[];
  }): void {
    this.ackRead(roomId, accountIds)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () =>
          void this.status.showError('Could not mark the room read.'),
      });
  }

  /**
   * Flag a room to come back to. Written on every account joined to the row for the same
   * reason {@link onMarkRead} acks all of them: a merged mixed-account row would otherwise
   * be flagged on one account and not the other, and the two would disagree.
   */
  onMarkUnread({
    roomId,
    accountIds,
  }: {
    roomId: string;
    accountIds?: readonly string[];
  }): void {
    const targets = accountIds?.length ? accountIds : [undefined];
    forkJoin(
      targets.map((accountId) =>
        this.rooms.setMarkedUnread(roomId, true, accountId),
      ),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () =>
          void this.status.showError('Could not mark the room unread.'),
      });
  }

  /**
   * Ack a room on every account joined to it. A room both mixed accounts are in is ONE row
   * carrying the loudest unread of the two, so acking only one leaves a badge the user has
   * no way to clear.
   */
  private ackRead(
    roomId: string,
    accountIds?: readonly string[],
  ): Observable<unknown> {
    const targets = accountIds?.length ? accountIds : [undefined];
    return forkJoin(
      targets.map((accountId) => this.rooms.markRead(roomId, accountId)),
    );
  }

  /**
   * Mark the currently-visible unread rooms read (header action). Scoped to the sidebar's
   * rooms so it matches the button, which is gated on their unread state — and acked per
   * owning account, since in the mixed view the button is offered for rooms belonging to
   * accounts other than the active one (acking those through the active client would
   * silently do nothing).
   */
  onMarkAllRead(): void {
    const unread = this.visibleRooms().filter((room) => room.hasUnread);
    if (unread.length === 0) {
      return;
    }
    // Acked on every account joined to the row, exactly as the ⋮ path does: a merged
    // mixed-account row can be flagged on the account that did NOT win the merge, and
    // acking only the winner leaves the row unread with the button still offering to
    // clear it.
    forkJoin(unread.map((room) => this.ackRead(room.id, room.accountIds)))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => void this.status.showError('Could not mark rooms read.'),
      });
  }

  /** Set this space's room order, or clear back to the account default. */
  onSetSpaceSort(mode: RoomSortMode | null): void {
    this.spaceActions.onSetSpaceSort(mode);
  }

  onOpenRoomSettings(): void {
    this.roomActions.onOpenRoomSettings();
  }

  onOpenSpaceSettings(): void {
    this.spaceActions.onOpenSpaceSettings();
  }

  onAddToSpace(): void {
    this.spaceActions.onAddToSpace();
  }

  onManageSpaceRooms(): void {
    this.spaceActions.onManageSpaceRooms();
  }

  onOpenSpaceMembers(): void {
    this.spaceActions.onOpenSpaceMembers();
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
    const pinning = !this.pinned.isPinned(eventId);
    const action = pinning
      ? this.pinned.pin(eventId)
      : this.pinned.unpin(eventId);
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () =>
        this.status.showSuccess(
          pinning ? 'Message pinned.' : 'Message unpinned.',
        ),
      error: () =>
        void this.status.showError(
          pinning
            ? 'Could not pin the message.'
            : 'Could not unpin the message.',
        ),
    });
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
        error: () =>
          void this.status.showError('Could not upload the attachment.'),
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
      error: () => void this.status.showError(failureMessage),
    });
  }

  goToSettings(): void {
    void this.router.navigateByUrl('/settings');
  }

  /** Switch the active account (no-op when it is already active). */
  switchAccount(userId: string): void {
    if (userId === this.matrix.activeUserId()) {
      return;
    }
    // Close the open room FIRST. Its panes are bound to this account's client and Room
    // objects, and timeline/threads/pinned all early-return on `open(sameRoomId)` — so
    // leaving it open would keep projecting the outgoing account's data (including its
    // decryption) with no way to re-bind short of a reload. The user re-picks a room on
    // the new account, which opens it cleanly.
    this.closeOpenRoom();
    this.resetViewScope();
    this.auth
      .switchAccount(userId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  private resetViewScope(): void {
    this.nav.resetViewScope();
  }

  private closeOpenRoom(): void {
    this.nav.closeOpenRoom();
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
