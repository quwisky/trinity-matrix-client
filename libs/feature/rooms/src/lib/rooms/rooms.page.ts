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
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { HlmButton } from '@trinity/helm/button';
import {
  BELOW_MD_QUERY,
  BELOW_MEMBERS_QUERY,
  mediaQuerySignal,
} from '@trinity/util/ui';
import {
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';
import { TrnTooltip } from '@trinity/components/tooltip';
import { CryptoService } from '@trinity/data-access/crypto';
import {
  InvitesService,
  MixedInvitesService,
} from '@trinity/data-access/invites';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  NotificationService,
  PushService,
} from '@trinity/data-access/notifications';
import { PinnedMessagesService } from '@trinity/data-access/pinned';
import { PresenceService } from '@trinity/data-access/profile';
import {
  RoomsService,
  SpacesService,
  SpaceChildrenService,
  AccountScopeService,
  MixedRoomsService,
  MixedSpacesService,
} from '@trinity/data-access/rooms';
import {
  ThreadsService,
  TimelineActionsService,
  TimelineService,
} from '@trinity/data-access/timeline';
import { FeatureFlagsService } from '@trinity/platform-native';
import { AvatarComponent } from '@trinity/components/avatar';
import { PageHeaderComponent } from '@trinity/components/page-header';
import { ServerRailComponent } from '../server-rail/server-rail.component';
import { ChannelSidebarComponent } from '../channel-sidebar/channel-sidebar.component';
import { MemberListComponent } from '../member-list/member-list.component';
import { SimpleMessageListComponent } from '../message-list/simple-message-list/simple-message-list.component';
import { VirtualMessageListComponent } from '../message-list/virtual-message-list/virtual-message-list.component';
import { EncryptionBannerComponent } from '../encryption-banner/encryption-banner.component';
import { ConnectivityBannerComponent } from '../connectivity-banner/connectivity-banner.component';
import { TombstoneBannerComponent } from '../tombstone-banner/tombstone-banner.component';
import { RoomShellStore } from './room-shell-store';
import { ShellStatusService } from './shell-status.service';
import { RoomShellViewModel } from './room-shell-view-model';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { MemberActionsService } from './member-actions.service';
import { AccountRoutingService } from './account-routing.service';
import { InviteActionsService } from './invite-actions.service';
import { SpaceActionsService } from './space-actions.service';
import { RoomActionsService } from './room-actions.service';
import { ReadStateService } from './read-state.service';
import { MessageActionsService } from './message-actions.service';
import { ShellShortcutsService } from './shell-shortcuts.service';
import { SessionActionsService } from './session-actions.service';
import { TrnIconComponent } from '@trinity/components/icon';

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
    ReadStateService,
    MessageActionsService,
    ShellShortcutsService,
    SessionActionsService,
  ],
  templateUrl: 'rooms.page.html',
  styleUrls: ['rooms.page.scss'],
  imports: [
    PageHeaderComponent,
    HlmButton,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuTrigger,
    TrnTooltip,
    TrnIconComponent,
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
})
export class RoomsPage implements OnInit, OnDestroy {
  /**
   * The two viewport predicates the shell branches on, live for the page's lifetime.
   *
   * Fields rather than call-time reads: `mediaQuerySignal` registers a listener bound to the
   * `DestroyRef` handed to it, so creating one per call would leak one per invocation.
   */
  private readonly mobileMasterDetail = mediaQuerySignal(
    BELOW_MD_QUERY,
    inject(DestroyRef),
  );
  private readonly membersAreDrawer = mediaQuerySignal(
    BELOW_MEMBERS_QUERY,
    inject(DestroyRef),
  );

  readonly rooms = inject(RoomsService);
  readonly spaces = inject(SpacesService);
  private readonly mixedRooms = inject(MixedRoomsService);
  private readonly mixedSpaces = inject(MixedSpacesService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly mixedInvites = inject(MixedInvitesService);
  readonly invites = inject(InvitesService);
  readonly timeline = inject(TimelineService);
  readonly timelineActions = inject(TimelineActionsService);
  readonly threads = inject(ThreadsService);
  readonly pinned = inject(PinnedMessagesService);
  readonly flags = inject(FeatureFlagsService);
  private readonly matrix = inject(MatrixClientService);
  private readonly crypto = inject(CryptoService);
  private readonly presence = inject(PresenceService);
  private readonly spaceChildren = inject(SpaceChildrenService);
  private readonly push = inject(PushService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly injector = inject(Injector);
  readonly store = inject(RoomShellStore);
  readonly status = inject(ShellStatusService);
  readonly vm = inject(RoomShellViewModel);
  readonly nav = inject(RoomShellNavigationService);
  readonly memberActions = inject(MemberActionsService);
  readonly routing = inject(AccountRoutingService);
  readonly inviteActions = inject(InviteActionsService);
  readonly spaceActions = inject(SpaceActionsService);
  readonly roomActions = inject(RoomActionsService);
  readonly readState = inject(ReadStateService);
  readonly messageActions = inject(MessageActionsService);
  readonly shortcutActions = inject(ShellShortcutsService);
  readonly session = inject(SessionActionsService);

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
   * The room a notification tap asked for: `/rooms?room=<id>`, written by
   * `NotificationService`/`PushService` after they switch to the owning account.
   *
   * Read as a STREAM, not from the route snapshot. `/rooms` is normally already the
   * active route when a notification is tapped, so the router reuses this component and
   * a snapshot read would only ever see the value the page was first created with —
   * which is how every tap ended up landing on whatever room was already open.
   */
  private readonly requestedRoomId = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('room'))),
    { initialValue: null },
  );
  constructor() {
    // The service cannot read the page's viewChild refs, so hand it the focus call.
    // In the constructor, not ngOnInit: `TestBed.inject(RoomsPage)` never runs lifecycle
    // hooks, so binding there left the callback unset for all 170 unit tests.
    this.nav.bindFocus(() => this.focusActiveView());
    // Space-management failures (create/leave) have no inline echo in the shell, so
    // surface each new error as a danger toast. runWithBusy captures the message
    // into ShellStatusService.error; this reacts to that signal turning non-null.
    effect(() => {
      const message = this.status.error();
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
    // Open the room a notification tap asked for, then strip the param so Back (or a
    // reload) does not re-open it. `activeRoomId` is read untracked: this must react to
    // the URL only — tracking it would re-run on every ordinary room switch and, if the
    // strip had not landed yet, yank the user back to the notified room.
    effect(() => {
      const roomId = this.requestedRoomId();
      if (!roomId) {
        return;
      }
      if (roomId !== untracked(() => this.store.activeRoomId())) {
        this.nav.onSelectRoom(roomId);
      }
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { room: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    });
  }

  /**
   * These projections are **session-lifetime, not page-lifetime**, which is why nothing
   * here is undone in {@link ngOnDestroy}. They are root singletons whose `connect()` is
   * idempotent per client, and `projectFromClient` keys its listeners to the client
   * instance — so a re-mount rebinds nothing and a logout releases all of them at once,
   * from `reprojectOnAccountSwitch`, rather than from whichever page remembered to ask.
   */
  ngOnInit(): void {
    this.rooms.connect();
    this.spaces.connect();
    this.invites.connect();
    this.crypto.connect();
    this.presence.connect(); // live online-status for member avatars
    this.spaceChildren.connect(); // live m.space.child links for the curation surfaces
    // Register for push once the authenticated shell is live (covers both fresh
    // login and a restored session). Best-effort + native-only; no-op elsewhere.
    this.push.register().subscribe({ error: () => undefined });
    // Desktop/web OS notifications from live sync (no-op on native mobile + web
    // without permission). Listener dies with the client on logout/reset.
    this.notifications.connect();
  }

  /**
   * Global keyboard chords. Kept on the page, unlike every other workflow: a `host`
   * binding can only name a member of the component class, so this one cannot be bound
   * straight to the coordinator.
   */
  onGlobalKeydown(event: Event): void {
    this.shortcutActions.onGlobalKeydown(event);
  }

  /**
   * Only the open room's panes are torn down here.
   *
   * The seven projections `ngOnInit` connects are root-scoped and outlive this page —
   * leaving `/rooms` for settings must not blank them, and they are re-`connect()`ed
   * on the way back in. Their real teardown is the one that matters (the last account
   * signing out), and that belongs to the projections themselves rather than to
   * whichever page happened to connect them: `reproject-on-switch` disconnects them
   * when the active client goes away, and `NotificationService` drops its own listeners
   * on the empty account set. This used to disconnect `invites` alone, which was neither
   * symmetric nor load-bearing — one owner, not one and a half.
   */
  ngOnDestroy(): void {
    this.nav.closeOpenRoom();
  }

  /**
   * Mobile: leave the open conversation and return to the room-list page. Below the
   * md breakpoint the rail + sidebar and the chat are separate full-screen pages
   * (keyed off `activeRoomId`); at md+ both columns are static and this is unused.
   */
  backToList(): void {
    this.nav.closeOpenRoom();
    this.focusActiveView();
  }

  /**
   * On the mobile master-detail layout, move focus to the page that just became
   * visible (the chat when a room is open, else the room list) once it renders — the
   * other page is display:none'd, so otherwise focus falls to `<body>`. At md+ both
   * pages are always visible, so focus is left where it is.
   */
  private focusActiveView(): void {
    if (!this.mobileMasterDetail()) {
      return;
    }
    afterNextRender(
      () => {
        const view = this.store.activeRoomId()
          ? this.mainView()
          : this.listView();
        view?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  /** Show/hide the member list from the toolbar / overflow menu. */
  toggleMembers(): void {
    this.store.membersOpen.update((open) => !open);
  }

  /** Close the member list — used by the mobile drawer's backdrop. */
  closeMembers(): void {
    this.store.membersOpen.set(false);
  }

  /**
   * Escape dismisses the mobile members drawer (its backdrop is mouse-only). Scoped to
   * when the drawer is actually open so it never swallows Escape elsewhere; a member's
   * info panel is a CDK dialog that closes the drawer as it opens, so there's no clash.
   */
  onEscapeKey(): void {
    if (this.store.membersOpen() && this.membersAreDrawer()) {
      this.closeMembers();
    }
  }
}
