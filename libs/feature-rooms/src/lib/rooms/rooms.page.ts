// Installs syntax highlighting for fenced code blocks, by side effect on module eval.
// Imported HERE rather than from util-matrix's barrel on purpose: message-view.ts (which
// consumes the highlighter) is in the eager bundle, so a barrel export would put every
// grammar in the initial chunk. This route is lazily loaded, so the grammars land in the
// rooms chunk — and it evaluates before any message view is projected.
import '@trinity/util-matrix/code-highlight';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
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
import { AuthService } from '@trinity/data-access-auth';
import { CryptoService } from '@trinity/data-access-crypto';
import {
  InvitesService,
  MixedInvitesService,
  type PendingInvite,
} from '@trinity/data-access-invites';
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
  AccountScopeService,
  MixedRoomsService,
  MixedSpacesService,
  UnreadAggregatorService,
  SpaceRoomOrderService,
  comparatorFor,
  type MemberSummary,
  type RoomSortMode,
  type RoomSummary,
  type SpaceSummary,
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

/** True when the member list is currently the overlay drawer rather than the static
 * column — mirrors the `max-width: 1100px` query the drawer styling uses. Feature-detects
 * matchMedia so non-DOM contexts fall back to the static column. */
function membersShownAsDrawer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 1100px)').matches
  );
}

/** The member list is a static column above the drawer cutoff (shown by default) and an
 * overlay drawer at/below it (starts closed). Derived as the exact complement of
 * membersShownAsDrawer so the two share one boundary with no sub-pixel gap between them. */
function membersColumnDefaultsOpen(): boolean {
  return !membersShownAsDrawer();
}

/** True on the mobile master-detail layout (below md), where the room list and the
 * chat are separate full-screen pages — mirrors the `max-width: 767.98px` scss query. */
function isMobileMasterDetail(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 767.98px)').matches
  );
}

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

  readonly activeSpaceId = signal<string | null>(null);
  /**
   * Whether the Recent activity view is active — the default on launch. It lists every
   * joined DM + room (space-owned included), mixed by recency, so it overrides the
   * Home/Rooms/space scoping below. Cleared by selecting Home, Rooms, or a space.
   */
  readonly recentView = signal(true);
  /** Whether the Rooms view is active — filters the sidebar to non-DM rooms. Home (no
   * space) shows direct messages only; Recent, a space, or this view clears the others. */
  readonly roomsView = signal(false);
  readonly activeRoomId = signal<string | null>(null);

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
  readonly membersOpen = signal(membersColumnDefaultsOpen());
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
   * Used to keep space-owned rooms out of the flat Rooms view (they live in their space).
   * In mixed mode this spans every account's spaces so the global Rooms list excludes
   * space-owned rooms from all accounts, matching the single-account view. */
  private readonly spaceChildRoomIds = computed<Map<string, Set<string>>>(
    () => {
      const byAccount = new Map<string, Set<string>>();
      const spaces = this.mixedOn()
        ? this.mixedSpaces.spaces()
        : this.spaces.spaces();
      for (const space of spaces) {
        const ids = byAccount.get(space.accountId) ?? new Set<string>();
        for (const id of space.childRoomIds) ids.add(id);
        byAccount.set(space.accountId, ids);
      }
      return byAccount;
    },
  );

  /** Whether a row is filed under one of ITS OWN account's spaces. Keyed per account: a
   * room that is top-level for the account you're acting as must not vanish from the Rooms
   * view just because a different mixed account files it inside one of its spaces. */
  private isSpaceChild(room: RoomSummary): boolean {
    const byAccount = this.spaceChildRoomIds();
    return room.accountIds.some((id) => byAccount.get(id)?.has(room.id));
  }

  /**
   * Rooms shown in the channel sidebar. Home (`null`, the default) shows only direct
   * messages (`m.direct`) in recency order. The Rooms view shows every non-DM joined
   * room that does not belong to any space (space-owned rooms live under their space).
   * A selected space shows only its joined child rooms, in the ordering that space resolves
   * to — its own override, else the active account's default (recent activity out of the
   * box). All read live signals, so the list reacts to sync, membership, `m.space.child`
   * changes, and to the ordering being changed from the sidebar or Settings.
   *
   * When the global "All accounts" scope is on ({@link mixedOn}), every list — Recent,
   * Home's DMs and the Rooms view — reads the cross-account {@link MixedRoomsService}
   * instead of the active account's rooms, classifying DMs by each row's own-account
   * `m.direct` (`directUserId`) rather than the active account's `directRoomIds()`.
   */
  readonly visibleRooms = computed<RoomSummary[]>(() => {
    const mixed = this.mixedOn();
    // Recent activity: every joined DM + room, mixed by recency. In mixed mode that spans
    // every signed-in account (each row badged); otherwise the active account's `rooms()`
    // — already exactly that list, favourite-first then most-recent, used unfiltered.
    if (this.recentView()) {
      return mixed ? this.mixedRooms.rooms() : this.rooms.rooms();
    }
    const all = mixed ? this.mixedRooms.rooms() : this.rooms.rooms();
    // Rooms view: non-DM joined rooms that aren't owned by a space (overrides the space scope).
    if (this.roomsView()) {
      return all.filter(
        (room) => !this.isDirectRow(room) && !this.isSpaceChild(room),
      );
    }
    const spaceId = this.activeSpaceId();
    if (!spaceId) {
      // Home: direct messages only.
      return all.filter((room) => this.isDirectRow(room));
    }
    // While mixing, take the children from the mixed projection — the same union the space
    // pill's unread badge is summed over. Reading the active account's SpacesService here
    // would list fewer rooms than the badge counted for a space BOTH accounts have joined,
    // leaving an unread total with nothing on screen to clear it. Foreign children are safe:
    // every row opens through onSelectRoomRow, which switches accounts first.
    const byId = new Map(all.map((room) => [room.id, room] as const));
    const childIds = this.mixedOn()
      ? (this.mixedSpaces.spaces().find((s) => s.id === spaceId)
          ?.childRoomIds ?? [])
      : this.spaces.childRoomIds(spaceId);
    // `map().filter()` already allocates, so sorting in place here cannot reach the shared
    // `rooms()` array these rows came from — `sort` mutates, and the Recent branch above
    // hands that array out by identity.
    const children = childIds
      .map((id) => byId.get(id))
      .filter((room): room is RoomSummary => room !== undefined);
    return children.sort(
      comparatorFor(this.spaceOrder.effectiveFor(spaceId), childIds),
    );
  });

  /**
   * The ordering the open space's rooms are listed in — its own override, else the active
   * account's default. Drives the sidebar header menu's radio checks.
   */
  readonly spaceSortMode = computed<RoomSortMode>(() =>
    this.spaceOrder.effectiveFor(this.activeSpaceId()),
  );

  /**
   * Whether that ordering is the space's own override rather than the account default —
   * what separates a checked "Recent activity" from a checked "Use my default".
   */
  readonly spaceSortOverridden = computed(
    () => this.spaceOrder.overrideFor(this.activeSpaceId()) !== null,
  );

  /** The active account's default ordering, named in the menu's "Use my default (…)" row. */
  readonly defaultSpaceSortMode = this.spaceOrder.defaultMode;

  readonly activeSpaceName = computed(() => {
    const id = this.activeSpaceId();
    if (!id) {
      return 'Home';
    }
    return this.spaces.spaces().find((s) => s.id === id)?.name ?? 'Home';
  });

  /** Channel-sidebar header: Recent activity, the Rooms view, a selected space, else Home's DMs. */
  readonly sidebarTitle = computed(() => {
    if (this.recentView()) {
      return 'Recent activity';
    }
    if (this.roomsView()) {
      return 'Rooms';
    }
    return this.activeSpaceId() ? this.activeSpaceName() : 'Direct Messages';
  });

  /**
   * Whether a room row counts as a direct message in the current scope: in mixed mode by
   * the row's own-account `m.direct` (`directUserId`), otherwise by the active account's
   * `directRoomIds()` set. Shared by {@link visibleRooms} and the rail unread badges so the
   * badges count exactly what their view shows.
   */
  private isDirectRow(room: RoomSummary): boolean {
    return this.mixedOn()
      ? room.directUserId != null
      : this.rooms.directRoomIds().has(room.id);
  }

  /** The room list the rail badges count over — every account's in mixed mode, else the
   * active account's — so each badge matches what its view renders. */
  private railRoomSource(): RoomSummary[] {
    return this.mixedOn() ? this.mixedRooms.rooms() : this.rooms.rooms();
  }

  /** Total unread notifications across everything the Recent view lists (its rail badge). */
  readonly recentUnread = computed(() =>
    this.railRoomSource().reduce((sum, r) => sum + r.unreadCount, 0),
  );

  /** Total unread notifications across direct-message rooms (Home rail badge). */
  readonly homeUnread = computed(() =>
    this.railRoomSource().reduce(
      (sum, r) => (this.isDirectRow(r) ? sum + r.unreadCount : sum),
      0,
    ),
  );

  /** Total unread notifications across the Rooms view — non-DM rooms that don't
   * belong to any space (space unread is surfaced on the space pills). */
  readonly roomsUnread = computed(() => {
    return this.railRoomSource().reduce(
      (sum, r) =>
        this.isDirectRow(r) || this.isSpaceChild(r) ? sum : sum + r.unreadCount,
      0,
    );
  });

  /** Unread notifications summed per space, keyed by space id (space-pill badges). In mixed
   * mode this covers every account's space pills, summing over that account's child rooms. */
  readonly spaceUnread = computed<Record<string, number>>(() => {
    const mixed = this.mixedOn();
    const source = mixed ? this.mixedRooms.rooms() : this.rooms.rooms();
    const byId = new Map(source.map((r) => [r.id, r] as const));
    const spaces = mixed ? this.mixedSpaces.spaces() : this.spaces.spaces();
    const totals: Record<string, number> = {};
    for (const space of spaces) {
      const childIds = mixed
        ? space.childRoomIds
        : this.spaces.childRoomIds(space.id);
      totals[space.id] = childIds.reduce(
        (sum, id) => sum + (byId.get(id)?.unreadCount ?? 0),
        0,
      );
    }
    return totals;
  });

  /** The rail's unread badges bundled into one object input. */
  readonly railUnread = computed<RailUnread>(() => ({
    recent: this.recentUnread(),
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
    this.rooms.revision(); // re-read once the user's profile hydrates on sync
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

  /** First letter of the active account's display name, for the header chip's avatar. */
  readonly userInitial = computed(() =>
    (
      this.userName()
        .replace(/^[@#!]+/, '')
        .trim()[0] ?? '?'
    ).toUpperCase(),
  );

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

  /**
   * Space pills for the rail: every signed-in account's spaces (badged) in mixed mode,
   * else just the active account's.
   */
  readonly railSpaces = computed<SpaceSummary[]>(() =>
    this.mixedOn() ? this.mixedSpaces.spaces() : this.spaces.spaces(),
  );

  /**
   * Account-badge lookup for the sidebar rows + rail pills, shared with the quick switcher
   * so every mixed surface badges rows the same way. Empty when not mixing.
   */
  readonly accountBadges = this.accountBadgesSvc.badges;

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
    e.preventDefault();
    switch (hit.id) {
      case 'switcher.open':
        void this.openSwitcher();
        break;
      case 'room.hop.back':
        this.hopRoom('back');
        break;
      case 'room.hop.forward':
        this.hopRoom('forward');
        break;
      case 'room.walk.down':
        this.walkList('next');
        break;
      case 'room.walk.up':
        this.walkList('previous');
        break;
      case 'room.walk.unread.down':
        this.walkUnread('next');
        break;
      case 'room.walk.unread.up':
        this.walkUnread('previous');
        break;
      case 'room.jump':
        if (hit.digit) {
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
        runWithBusy(this.rooms.createDirectMessage(selection.id), {
          busy: this.spaceBusy,
          error: this.spaceError,
          destroyRef: this.destroyRef,
        }).subscribe((roomId) => this.onSelectRoom(roomId));
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

  /** Switch to the Recent activity view (all DMs + rooms, mixed); clears any space. */
  onShowRecent(): void {
    this.recentView.set(true);
    this.roomsView.set(false);
    this.activeSpaceId.set(null);
    // Home clears the space hierarchy the same way; keep the sidebar's space extras off.
    this.spaces.openSpace(null);
  }

  onSelectSpace(id: string | null): void {
    // Selecting a space (or Home) leaves the Recent + Rooms views.
    this.recentView.set(false);
    this.roomsView.set(false);
    this.activeSpaceId.set(id);
    // Load (or clear, for Home) the space's full child hierarchy so the sidebar can
    // offer not-yet-joined channels + sub-spaces. The fetch is cancelled/replaced if
    // the selection changes again before it lands.
    this.spaces.openSpace(id);
  }

  /** Switch to the Rooms view (non-DM rooms); clears Recent and any selected space. */
  onShowRooms(): void {
    this.recentView.set(false);
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

  /** Sidebar room ⋮ menu "Leave room": confirm, then leave the room entirely — on the
   * account that owns the row. Leaving is irreversible for a private room, so it must
   * never fall through to the active account just because the row belongs to another. */
  async onLeaveRoom({
    roomId,
    accountId,
  }: {
    roomId: string;
    accountId?: string;
  }): Promise<void> {
    const name =
      this.visibleRooms().find((r) => r.id === roomId)?.name ?? 'this room';
    // Leaving is per-account and irreversible, so never fan it out the way the idempotent
    // actions are — name the account instead, since a merged row represents two memberships.
    const as =
      this.mixedOn() && accountId ? ` as ${this.accountLabel(accountId)}` : '';
    const confirmed = await this.alert.confirm({
      header: 'Leave room',
      message: `Leave “${name}”${as}? You'll stop receiving its messages and need a new invite (or a public join) to come back.`,
      confirmText: 'Leave',
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    this.rooms
      .leave(roomId, accountId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // The room drops from the sidebar via sync. If it was the open one, tear the
        // room panes down (mirroring ngOnDestroy / onSelectRoom) so the timeline,
        // threads, and pinned projections stop listening on a room we just left.
        next: () => {
          if (this.activeRoomId() === roomId) {
            this.closeOpenRoom();
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
  onAcceptInvite({
    roomId,
    accountId,
  }: {
    roomId: string;
    accountId?: string;
  }): void {
    this.spaceError.set(null);
    const invite = this.knownInvites().find((i) => i.roomId === roomId);
    // Joined on the account the invite was sent to — answering one must never need an
    // account switch, and joining as the wrong account would fail or join the wrong user.
    runWithBusy(this.invites.acceptInvite(roomId, accountId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe(() => {
      // A joined room/DM lives under Home; surface it by switching there and
      // opening it. A joined space just appears in the rail (no auto-select).
      if (invite && !invite.isSpace) {
        this.onSelectSpace(null);
        this.onSelectRoomRow(roomId);
      }
    });
  }

  /** Pending invites across the mixed accounts, or the active account's when not mixing. */
  private knownInvites(): readonly PendingInvite[] {
    return this.mixedOn()
      ? this.mixedInvites.invites()
      : this.invites.pendingInvites();
  }

  /** Decline a pending invite (leave the invited room/space). */
  onDeclineInvite({
    roomId,
    accountId,
  }: {
    roomId: string;
    accountId?: string;
  }): void {
    this.spaceError.set(null);
    runWithBusy(this.invites.declineInvite(roomId, accountId), {
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

  /**
   * Open a room. `source` distinguishes a normal open (the default — records the visit,
   * committing any hop cycle) from a hop-driven one (leaves the MRU stack frozen so
   * repeated hops keep cycling deeper). Every existing caller uses the default.
   */
  /**
   * Open a room chosen from the sidebar list. In mixed-account mode the row may belong to
   * a different signed-in account — switch to that account first (so every downstream
   * action runs on its client), then open the room; otherwise open it directly.
   */
  onSelectRoomRow(id: string, source: 'user' | 'hop' = 'user'): void {
    const accountId = this.knownRooms().find((r) => r.id === id)?.accountId;
    if (accountId && accountId !== this.matrix.activeUserId()) {
      this.runOnAccount(accountId, () => this.onSelectRoom(id, source));
      return;
    }
    this.onSelectRoom(id, source);
  }

  /**
   * Select a space pill from the rail. In mixed mode a foreign account's space switches to
   * that account first; Home (`null`) and same-account spaces select directly.
   */
  onSelectSpaceRow(id: string | null): void {
    const accountId = id
      ? this.railSpaces().find((s) => s.id === id)?.accountId
      : undefined;
    if (accountId && accountId !== this.matrix.activeUserId()) {
      this.runOnAccount(accountId, () => this.onSelectSpace(id));
      return;
    }
    this.onSelectSpace(id);
  }

  /**
   * Include/exclude an account from the mixed view (the account picker's checkbox). The
   * active account is always shown, and the service ignores an attempt to drop it.
   */
  onToggleAccountShown(userId: string): void {
    this.accountScope.toggle(userId);
  }

  /**
   * Every room the shell can currently open, unfiltered by the active view. `visibleRooms()`
   * is a *filtered* projection (Home shows DMs only, a space shows its children), so an MRU
   * or hop target is routinely absent from it — resolving a row's owning account there would
   * silently miss and open the room on the wrong client.
   */
  private knownRooms(): RoomSummary[] {
    return this.mixedOn() ? this.mixedRooms.rooms() : this.rooms.rooms();
  }

  /** An account's display name for user-facing copy, falling back to its user id. */
  private accountLabel(accountId: string): string {
    return this.accountBadges().get(accountId)?.name ?? accountId;
  }

  /** Switch to `accountId`, then run `then` once the switch has landed. */
  private runOnAccount(accountId: string, then: () => void): void {
    this.closeOpenRoom();
    this.resetViewScope();
    this.auth
      .switchAccount(accountId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() =>
        // Deferred past the render that follows the switch: RoomsService/SpacesService
        // re-project onto the new client from an effect, and a space hierarchy requested
        // before that flush is wiped by it — leaving the sidebar's "More Channels" and
        // sub-space sections permanently empty until the pill is clicked a second time.
        afterNextRender(() => then(), { injector: this.injector }),
      );
  }

  onSelectRoom(id: string, source: 'user' | 'hop' = 'user'): void {
    // Drop the previous room's resolved media URLs before switching timelines.
    this.media.releaseAll();
    this.activeRoomId.set(id);
    this.timeline.open(id);
    this.threads.open(id); // project this room's thread summaries for indicators
    this.pinned.open(id); // project this room's pinned messages
    if (source === 'user') {
      this.mru.record(id);
    }
    // On mobile, setting activeRoomId switches from the room-list page to the chat.
    this.focusActiveView();
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
      // On the narrow layout the list is an overlay drawer — close it so the info
      // panel isn't stacked behind it. The wide static column stays put.
      if (membersShownAsDrawer()) {
        this.closeMembers();
      }
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
    // Against the mixed superset: while mixing, a room owned by another selected account is
    // listed and openable in the sidebar, so refusing its permalink would contradict the
    // list one column to the left.
    if (!this.knownRooms().some((r) => r.id === roomId)) {
      void this.showError("You're not in that room.");
      return;
    }
    if (roomId !== this.activeRoomId()) {
      this.onSelectRoomRow(roomId);
    }
    if (eventId) {
      // Jump to the linked event (a no-op until it's in the loaded timeline).
      this.messageSearchTarget.set(eventId);
      this.jumpRequest.update((n) => n + 1);
    }
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
        error: () => void this.showError('Could not update notifications.'),
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
        error: () => void this.showError('Could not mark the room read.'),
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
    forkJoin(unread.map((room) => this.rooms.markRead(room.id, room.accountId)))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => void this.showError('Could not mark rooms read.'),
      });
  }

  /**
   * Sidebar header sort menu: order the open space's rooms. `null` is "use my default", and
   * *drops* the override rather than storing today's default — so the space keeps following
   * that default if it is later changed in Settings.
   */
  onSetSpaceSort(mode: RoomSortMode | null): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) {
      return; // the control is space-only, but the handler shouldn't assume it
    }
    if (mode) {
      this.spaceOrder.setForSpace(spaceId, mode);
    } else {
      this.spaceOrder.clearForSpace(spaceId);
    }
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
      ariaLabel: 'Room settings',
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
    const pinning = !this.pinned.isPinned(eventId);
    const action = pinning
      ? this.pinned.pin(eventId)
      : this.pinned.unpin(eventId);
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () =>
        this.showSuccess(pinning ? 'Message pinned.' : 'Message unpinned.'),
      error: () =>
        void this.showError(
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

  /**
   * Drop the space/Rooms scope back to Recent before an account switch. `activeSpaceId`
   * names a space on the OUTGOING account: SpacesService re-projects onto the new client and
   * wipes it, leaving the sidebar empty, the header falling back to "Home", and the
   * space-only actions (leave / invite / create channel) aimed at a space the now-active
   * account isn't in. A selection that wants a different scope — selecting a foreign space —
   * sets its own afterwards.
   */
  private resetViewScope(): void {
    // Only the SPACE scope is account-bound. Recent / Direct Messages / Rooms are filters
    // over whatever the new account has, so preserve the user's choice — resetting it too
    // silently dumped them in Recent mid-task. Fall back to Recent only when a space was
    // open, since that space belongs to the outgoing account.
    if (this.activeSpaceId() !== null) {
      this.recentView.set(true);
      this.roomsView.set(false);
      this.activeSpaceId.set(null);
    }
    this.spaces.openSpace(null);
  }

  /**
   * Tear down the open room's panes and forget it. The single definition of "close the
   * open room" — leaving a room, switching account, and destroying the page all need
   * exactly this, and when it was inlined at each site they drifted (one forgot
   * `closeThread()`, leaving an open thread projecting a room the user had left).
   */
  private closeOpenRoom(): void {
    // On mobile the member list is an overlay drawer; don't carry an open one over
    // to the next room (it would slide in unrequested). The wide static column keeps
    // its persisted open/closed state.
    if (membersShownAsDrawer()) {
      this.membersOpen.set(false);
    }
    this.activeRoomId.set(null);
    this.timeline.close();
    this.threads.close();
    this.threads.closeThread();
    this.pinned.close();
    this.media.releaseAll();
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
