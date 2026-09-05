// Installs syntax highlighting for fenced code blocks, by side effect on module eval.
// Imported HERE rather than from util-matrix's barrel on purpose: message-view.ts (which
// consumes the highlighter) is in the eager bundle, so a barrel export would put every
// grammar in the initial chunk. This route is lazily loaded, so the grammars land in the
// rooms chunk — and it evaluates before any message view is projected.
import '../message-presentation/code-highlight';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  ElementRef,
  Injector,
  OnDestroy,
  afterNextRender,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  WorkspaceBackService,
  WorkspaceNavigationService,
  type WorkspaceDismissResult,
  type WorkspaceSurface,
} from '@trinity/application/workspace';
import { TrnActionAvailability, TrnButton } from '@trinity/components/controls';
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
import { EmptyStateComponent } from '@trinity/components/generic-content';
import { TrnTooltip } from '@trinity/components/generic-content';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ImagePackService } from '@trinity/data-access/media';
import { SelectedRoomLibraryService } from '@trinity/data-access/room-library';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import {
  HapticsService,
  MessageGestureSettingsService,
  isMobileOs,
  FeatureFlagsService,
  ShellLayoutService,
} from '@trinity/platform-native';
import { Observable, defer, map, of } from 'rxjs';
import { AvatarComponent } from '@trinity/components/generic-content';
import { PageHeaderComponent } from '@trinity/components/navigation-layout';
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
import { TrnIconComponent } from '@trinity/components/foundations';

/**
 * Discord-style authenticated shell: server rail + channel sidebar (in a
 * responsive Tailwind drawer — static column at md+, slide-in below), the read
 * timeline, and a member list.
 * Wired to live synced rooms via `RoomLibraryService` + `ConversationRuntime`.
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
    TrnActionAvailability,
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
export class RoomsPage implements OnDestroy {
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

  /** Offer Room and compact-Conversation surfaces to Workspace's fixed Back order. */
  private readonly backRegistration = inject(WorkspaceBackService).register({
    surface: () => this.activeWorkspaceSurface(),
    dismiss: (surface) => this.dismissWorkspaceSurface(surface),
  });

  private readonly selectedLibrary = inject(SelectedRoomLibraryService);
  private readonly conversations = inject(ConversationRuntime);
  readonly timeline = this.conversations.timeline;
  readonly threads = this.conversations.threads;
  readonly pinned = this.conversations.pins;
  private readonly imagePackService = inject(ImagePackService);
  readonly flags = inject(FeatureFlagsService);
  private readonly matrix = inject(MatrixClientService);
  private readonly accountPicker = inject(AccountPickerService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  readonly store = inject(RoomShellStore);
  private readonly workspace = inject(WorkspaceNavigationService);
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
    this.accountPicker.open({
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
  readonly shownAccountIds = computed(
    () => this.selectedLibrary.view().accountIds,
  );
  /** Whether the cross-account projection is active (more than one account selected). */
  readonly mixedOn = computed(
    () => this.selectedLibrary.view().mode === 'mixed',
  );

  // The two mobile pages (the rail/room-list and the chat), focused on a view switch
  // so keyboard/screen-reader focus follows to the newly-shown page (see focusActiveView).
  private readonly listView = viewChild<ElementRef<HTMLElement>>('listView');
  private readonly mainView = viewChild<ElementRef<HTMLElement>>('mainView');

  constructor() {
    // The service cannot read the page's viewChild refs, so hand it the focus call.
    // In the constructor, not ngOnInit: `TestBed.inject(RoomsPage)` never runs lifecycle
    // hooks, so binding there left the callback unset for all 170 unit tests.
    this.nav.bindFocus(() => this.focusActiveView());
    effect(() => {
      const target = this.workspace.eventTarget();
      if (!target) return;
      this.store.messageSearchTarget.set(target.eventId);
      this.store.jumpRequest.update((revision) => revision + 1);
    });
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
   * Session projections are retained by Application Runtime; this route owns only its open panes.
   */
  ngOnDestroy(): void {
    this.backRegistration();
  }

  /**
   * Mobile: leave the open conversation and return to the room-list page. Below the
   * md breakpoint the rail + sidebar and the chat are separate full-screen pages
   * (keyed off Workspace pane); at md+ both columns are static and this is unused.
   */
  backToList(): void {
    // Focus is not handed off here: closing navigates, and `projectOpenRoom` focuses the
    // pane that became visible once the URL lands. Doing it here as well would schedule a
    // second `afterNextRender` against the page we are leaving.
    this.nav.closeOpenRoom();
  }

  /**
   * On the mobile master-detail layout, move focus to the page that just became
   * visible (the chat for the Conversation pane, else the room list) once it renders — the
   * other page is display:none'd, so otherwise focus falls to `<body>`. At md+ both
   * pages are always visible, so focus is left where it is.
   */
  private focusActiveView(): void {
    if (!this.mobileMasterDetail()) {
      return;
    }
    afterNextRender(
      () => {
        const view =
          this.store.pane() === 'conversation'
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

  /** Current semantic Room surface, then the compact Conversation beneath it. */
  private activeWorkspaceSurface(): WorkspaceSurface | null {
    const panel = this.store.rightPanel();
    if (panel) {
      return {
        layer: 'room',
        surface:
          panel.kind === 'member'
            ? { kind: 'member', userId: panel.member.userId }
            : panel,
      };
    }
    const accountId = this.store.activeAccountId();
    const roomId = this.store.activeRoomId();
    return this.mobileMasterDetail() &&
      this.store.pane() === 'conversation' &&
      accountId &&
      roomId
      ? {
          layer: 'conversation',
          surface: { kind: 'conversation', accountId, roomId },
        }
      : null;
  }

  /** Cold adapter from Workspace's semantic claim to this page's presentation. */
  private dismissWorkspaceSurface(
    surface: WorkspaceSurface,
  ): Observable<WorkspaceDismissResult> {
    return defer(() => {
      if (surface.layer === 'room') {
        this.dismissRightPanel();
        return of('dismissed' as const);
      }
      if (surface.layer !== 'conversation') return of('blocked' as const);
      return this.workspace
        .navigate({ kind: 'list', origin: 'workspace-back' })
        .pipe(
          map((outcome) =>
            outcome.kind === 'ready'
              ? ('dismissed' as const)
              : ('blocked' as const),
          ),
        );
    });
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
