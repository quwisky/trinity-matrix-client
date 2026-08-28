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
  computed,
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
import { Router } from '@angular/router';
import { TrnButton } from '@trinity/components/button';
import {
  BELOW_MD_QUERY,
  BELOW_MEMBERS_QUERY,
  mediaQuerySignal,
} from '@trinity/util/ui';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuTrigger,
} from '@trinity/components/overlay';
import { EmptyStateComponent } from '@trinity/components/empty-state';
import { TrnTooltip } from '@trinity/components/tooltip';
import { CryptoService } from '@trinity/data-access/crypto';
import {
  InvitesService,
  MixedInvitesService,
} from '@trinity/data-access/invites';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ImagePackService } from '@trinity/data-access/media';
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
import {
  HapticsService,
  MessageGestureSettingsService,
  isMobileOs,
  BackInterceptorService,
  FeatureFlagsService,
  ShellLayoutService,
} from '@trinity/platform-native';
import { AvatarComponent } from '@trinity/components/avatar';
import { PageHeaderComponent } from '@trinity/components/page-header';
import { ServerRailComponent } from '../server-rail/server-rail.component';
import { ChannelSidebarComponent } from '../channel-sidebar/channel-sidebar.component';
import { SidebarUserPanelComponent } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';
import { AccountPickerService } from '../account-picker/account-picker.service';
import { MemberListComponent } from '../member-list/member-list.component';
import { ThreadsListComponent } from '../thread/threads-list.component';
import { ThreadViewComponent } from '../thread/thread-view.component';
import { PinnedMessagesPanelComponent } from '../pinned/pinned-messages-panel.component';
import { MessageSearchComponent } from '../message-search/message-search.component';
import { MemberInfoComponent } from '../member-info/member-info.component';
import { PaneHandleComponent } from './pane-handle.component';
import { DrawerSwipeDirective } from './drawer-swipe.directive';
import { SimpleMessageListComponent } from '../message-list/simple-message-list/simple-message-list.component';
import { VirtualMessageListComponent } from '../message-list/virtual-message-list/virtual-message-list.component';
import { EncryptionBannerComponent } from '../encryption-banner/encryption-banner.component';
import { ConnectivityBannerComponent } from '../connectivity-banner/connectivity-banner.component';
import { TombstoneBannerComponent } from '../tombstone-banner/tombstone-banner.component';
import { type SwipeDirection } from '../message-row/message-row.component';
import { RoomShellStore, type RightPanel } from './room-shell-store';
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
/**
 * The drawer widths at the `members` breakpoint, mirroring `rooms.page.scss`.
 *
 * Duplicated rather than read from CSS because a gesture threshold has to exist before the
 * drawer does — the opening swipe is measured while there is nothing on screen to measure.
 * The stylesheet is the one that renders them, so these two must not drift from it.
 */
const MEMBERS_DRAWER_PX = 240;
const PANEL_DRAWER_PX = 480;

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
    EmptyStateComponent,
    PageHeaderComponent,
    TrnButton,
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuTrigger,
    TrnTooltip,
    TrnIconComponent,
    AvatarComponent,
    ServerRailComponent,
    ChannelSidebarComponent,
    SidebarUserPanelComponent,
    MemberListComponent,
    // The five surfaces the right-hand slot can show. Imported by the page rather than
    // opened by a service, which is the whole of this change: presentation is the shell's
    // decision, and each panel just announces what the user did.
    ThreadsListComponent,
    ThreadViewComponent,
    PinnedMessagesPanelComponent,
    MessageSearchComponent,
    MemberInfoComponent,
    PaneHandleComponent,
    DrawerSwipeDirective,
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
  protected readonly mobileMasterDetail = mediaQuerySignal(
    BELOW_MD_QUERY,
    inject(DestroyRef),
  );
  /**
   * Whether the slot is currently the overlay drawer rather than a column.
   *
   * `protected` rather than private: the template reads it to tell `DrawerSwipeDirective`
   * whether there is a drawer to swipe at all.
   */
  protected readonly membersAreDrawer = mediaQuerySignal(
    BELOW_MEMBERS_QUERY,
    inject(DestroyRef),
  );

  /**
   * Which way a message row is dragged to act on it, HERE and not in the list.
   *
   * The preference is only half the answer, and this page is the only place that knows the
   * other halves — which is why it resolves the direction rather than passing the preference
   * through.
   *
   * `store.rightPanel()` is the literal expression `[drawerOpen]` is bound to below, so the
   * two cannot drift. It is NOT what stops the row gesture competing with the drawer: while
   * a panel is open a `fixed inset-0` backdrop covers the viewport, so no `pointerdown`
   * reaches a timeline row in that state at all. This clause is a mirror of the drawer's own
   * arming condition, kept because a gesture that is off should be off for a stated reason
   * rather than by a side effect of somebody else's markup.
   *
   * The thread panel is the deliberate exception and is handled at the row: it only EXISTS
   * while the drawer is open, so this rule would make the gesture permanently dead there. It
   * stops the `pointerdown` from reaching the drawer instead — see `armSwipe`.
   *
   * Phones only. `swipe-through` claims the horizontal axis on `.scroll` only under
   * `max-width: 1099.98px`; above it the scroller claims nothing and the browser eats the
   * drag after one `pointermove`. `isMobileOs()` alone would not do — it is true for Android
   * tablets and iPads, which run wider than that in landscape.
   */
  protected readonly messageSwipeDirection = computed<SwipeDirection>(() => {
    if (!this.membersAreDrawer() || !isMobileOs()) {
      return 'off';
    }
    if (this.store.rightPanel()) {
      return 'off';
    }
    return this.gestures.messageSwipe();
  });

  /** Which way a message row is dragged, as the reader set it. */
  private readonly gestures = inject(MessageGestureSettingsService);

  /** Persisted pane widths, bound into the shell's CSS custom properties. */
  readonly layout = inject(ShellLayoutService);

  /** A tick when a drag lands, on a phone. Silent everywhere else. */
  private readonly haptics = inject(HapticsService);

  /**
   * How wide the drawer actually is at the drawer breakpoint, for the swipe's threshold.
   *
   * NOT `layout.rightPanelWidth()`, which is the width the pane handle drags on a DESKTOP and
   * which `rooms.page.scss` deliberately ignores below the `members` breakpoint. Passing it
   * made the gesture measure a 240px roster against a 480px default — 80% of its travel to
   * commit, where the rule is 40% — and a user who had dragged the panel to its 720px maximum
   * made the distance threshold unreachable on a phone, leaving only the flick.
   *
   * A method rather than a computed: it reads `innerWidth`, which is not a signal, and a
   * template call is re-evaluated each pass so a rotation is picked up.
   */
  protected drawerWidth(): number {
    const panel = this.store.rightPanel();
    if (!panel || panel.kind === 'members') {
      return MEMBERS_DRAWER_PX;
    }
    // The panels are `width: 480px; max-width: 100%` at this breakpoint, so on a phone the
    // viewport is what they actually get.
    return Math.min(PANEL_DRAWER_PX, window.innerWidth);
  }

  /**
   * Native Back closes the right-hand panel before it leaves the room.
   *
   * Registered rather than reached for: `AppComponent` owns the Back chain and cannot import
   * this feature, and the panel is an inline block rather than a CDK dialog, so the chain's
   * `dialog.hasOpen()` check has never seen it. Only claims the press when something is
   * actually open, so Back still leaves the room when the slot is empty.
   */
  private readonly backRegistration = inject(BackInterceptorService).register({
    active: () => this.store.rightPanel() !== null,
    dismiss: () => this.closeRightPanel(),
  });

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
  private readonly imagePackService = inject(ImagePackService);
  readonly flags = inject(FeatureFlagsService);
  private readonly matrix = inject(MatrixClientService);
  private readonly crypto = inject(CryptoService);
  private readonly presence = inject(PresenceService);
  private readonly spaceChildren = inject(SpaceChildrenService);
  private readonly push = inject(PushService);
  private readonly notifications = inject(NotificationService);
  private readonly accountPicker = inject(AccountPickerService);
  private readonly router = inject(Router);
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

  /** Phones use a dialog because the narrow navigation has no room for the desktop submenu. */
  protected onOpenAccountPicker(): void {
    void this.accountPicker.open({
      accounts: this.vm.accounts(),
      activeUserId: this.vm.activeAccountId(),
    });
  }

  readonly imagePacks = computed(() => {
    const roomId = this.store.activeRoomId();
    return roomId ? this.imagePackService.packsFor(roomId)() : [];
  });

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

  constructor() {
    // The service cannot read the page's viewChild refs, so hand it the focus call.
    // In the constructor, not ngOnInit: `TestBed.inject(RoomsPage)` never runs lifecycle
    // hooks, so binding there left the callback unset for all 170 unit tests.
    this.nav.bindFocus(() => this.focusActiveView());
    // ShellStatusService presents runWithBusy failures directly. In the zoneless app,
    // a component effect that only reads the error signal is not a reliable render
    // trigger when the failed action changes no template-read state.
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
    effect((onCleanup) => {
      const roomId = this.store.activeRoomId();
      if (!roomId) return;
      this.imagePackService.connect(roomId);
      onCleanup(() => this.imagePackService.disconnect(roomId));
    });
    // The `?room=` deep link is gone. A notification tap now navigates to `/rooms/:roomId`
    // like everything else, so the room it asked for arrives through `paramMap` and needs no
    // handling here — and none of the strip-the-param-afterwards dance that went with it.
    this.manageRightPanelFocus();
  }

  /**
   * Hand focus into an inline replacement, or back to the trigger when the slot closes.
   *
   * CDK did this for the four dialogs these panels replaced. Without it a keyboard user who
   * presses "Threads", reads the list and closes it lands on `<body>` and has to tab in from
   * the top of the document again — and in-room search makes it worse, because it
   * deliberately takes focus when it opens.
   *
   * Opening remembers the external trigger without moving focus: a destination such as
   * search may already own autofocus. Replacing one inline panel with another preserves that
   * trigger and focuses the destination's marked control after render. Emptying the slot
   * restores the original trigger and ends the sequence.
   *
   * Both deferred paths only act when removal actually orphaned focus. Anything that has
   * claimed it since (another panel's own autofocus, the room-change handoff, a DM the panel
   * just opened) has a better idea than this effect does.
   */
  private manageRightPanelFocus(): void {
    let trigger: HTMLElement | null = null;
    let previousPanel: RightPanel = null;
    effect(() => {
      const panel = this.store.rightPanel();
      untracked(() => {
        const previous = previousPanel;
        previousPanel = panel;
        if (panel) {
          trigger ??= this.activeElementOutsideRightPanel();
          if (previous) {
            this.focusRightPanelAfterSwap(panel);
          }
          return;
        }
        const target = trigger;
        trigger = null;
        if (!target) {
          return;
        }
        // After the render that removes the panel, or the element is still in the way.
        afterNextRender(
          () => {
            if (
              this.store.rightPanel() === null &&
              target.isConnected &&
              document.activeElement === document.body
            ) {
              target.focus();
            }
          },
          { injector: this.injector },
        );
      });
    });
  }

  /** Focus the destination of a panel-to-panel replacement after its template exists. */
  private focusRightPanelAfterSwap(panel: Exclude<RightPanel, null>): void {
    afterNextRender(
      () => {
        if (
          this.store.rightPanel() !== panel ||
          document.activeElement !== document.body
        ) {
          return;
        }
        const target = document.querySelector<HTMLElement>(
          '[data-right-panel-slot] [data-right-panel-focus]',
        );
        if (target?.isConnected) {
          target.focus();
        }
      },
      { injector: this.injector },
    );
  }

  /** Return the current focus only when it can meaningfully reopen this panel sequence. */
  private activeElementOutsideRightPanel(): HTMLElement | null {
    const active = document.activeElement;
    return active instanceof HTMLElement &&
      active !== document.body &&
      !active.closest('[data-right-panel-surface]')
      ? active
      : null;
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
    this.backRegistration();
    // `releaseOpenRoom`, not `closeOpenRoom`: closing NAVIGATES now, and the router is
    // already on its way to wherever the user actually went. This only has to stop the
    // root-scoped projections following a room nobody is looking at.
    this.nav.releaseOpenRoom();
  }

  /**
   * Mobile: leave the open conversation and return to the room-list page. Below the
   * md breakpoint the rail + sidebar and the chat are separate full-screen pages
   * (keyed off `activeRoomId`); at md+ both columns are static and this is unused.
   */
  backToList(): void {
    // Focus is not handed off here: closing navigates, and `projectOpenRoom` focuses the
    // pane that became visible once the URL lands. Doing it here as well would schedule a
    // second `afterNextRender` against the page we are leaving.
    this.nav.closeOpenRoom();
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
    // Toggling OFF only when the member list is what is showing. With one slot, pressing
    // "Members" while a thread is open means "show me members instead", not "close the
    // thread" — the button is a destination, not a switch.
    this.store.rightPanel.update((panel) =>
      panel?.kind === 'members' ? null : { kind: 'members' },
    );
  }

  /** Empty the slot — the mobile drawer's backdrop, and every panel's own close button. */
  closeRightPanel(): void {
    this.store.rightPanel.set(null);
  }

  /**
   * A swipe in from the right edge opens the member list.
   *
   * The roster and not, say, threads, because the gesture has to mean ONE thing and this is
   * what the toolbar's own button opens — a gesture that guessed differently from the button
   * beside it would be a gesture nobody could predict.
   */
  onDrawerSwipedOpen(): void {
    if (!this.store.activeRoomId()) {
      return; // no room, no roster to show — the slot's template is gated on one
    }
    this.store.rightPanel.set({ kind: 'members' });
    this.haptics.gestureCommitted();
  }

  /** A swipe away dismisses whatever the slot was showing. */
  onDrawerSwipedClosed(): void {
    this.closeRightPanel();
    this.haptics.gestureCommitted();
  }

  /**
   * Do what the current surface's own close button does.
   *
   * Not the same as {@link closeRightPanel} for member info, which goes BACK to the roster
   * it replaced rather than to an empty slot. Escape is the keyboard spelling of pressing
   * that button, so it has to land in the same place; the mobile backdrop is the one
   * gesture that genuinely means "get this overlay off my screen" and keeps emptying it.
   */
  dismissRightPanel(): void {
    if (this.store.rightPanel()?.kind === 'member') {
      this.memberActions.onMemberPanelDismissed();
      return;
    }
    this.closeRightPanel();
  }

  /**
   * Escape dismisses whatever the slot is showing — the panels are plain components now, so
   * nothing else offers the Escape that CDK gave them for free as dialogs.
   *
   * The roster is the exception, and only at the wide layout, where it is a persistent
   * column rather than an overlay: this is a DOCUMENT listener, so an unguarded Escape there
   * would close the member list every time someone pressed Escape to cancel an edit in the
   * composer. As the narrow drawer it is an overlay like the rest and goes with them.
   */
  onEscapeKey(): void {
    const panel = this.store.rightPanel();
    if (!panel || (panel.kind === 'members' && !this.membersAreDrawer())) {
      return;
    }
    this.dismissRightPanel();
  }
}
