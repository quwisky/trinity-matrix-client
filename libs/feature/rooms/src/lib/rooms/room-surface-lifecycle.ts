import {
  DestroyRef,
  Injectable,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import {
  WorkspaceBackService,
  WorkspaceNavigationService,
  sameWorkspacePanel,
  type WorkspaceDismissResult,
  type WorkspacePanel,
  type WorkspaceRoomSurface,
  type WorkspaceSurface,
} from '@trinity/application/workspace';
import {
  BELOW_MD_QUERY,
  BELOW_MEMBERS_QUERY,
  type LatestToken,
  latestGuard,
  matchesQuery,
  mediaQuerySignal,
} from '@trinity/util/ui';
import { Observable, defer, map, of } from 'rxjs';
import type { ExactRoomSelection } from '../shared/exact-selection';

/** Member info is not here: it opens as a modal surface over the roster. */
type TemporaryRoomSurface = Extract<
  WorkspaceRoomSurface,
  { readonly kind: 'threads' | 'thread' | 'pinned' | 'search' }
>;
type MembersRoomSurface = { readonly kind: 'members' };
type ThreadRoomSurface = Extract<TemporaryRoomSurface, { kind: 'thread' }>;

export type RenderedRoomSurface = TemporaryRoomSurface | MembersRoomSurface;

interface RoomSurfaceState {
  readonly conversation: ExactRoomSelection;
  /** A reveal waiting for the panel's close to commit. */
  readonly pendingReveal: {
    readonly eventId: string;
    readonly token: LatestToken;
  } | null;
  readonly jumpTarget: string | null;
  readonly jumpRevision: number;
}

export type RoomSurfaceTransition =
  | { readonly kind: 'open-threads' }
  | {
      readonly kind: 'open-thread';
      readonly rootEventId: string;
      readonly revealEventId?: string;
    }
  | { readonly kind: 'open-pinned' }
  | { readonly kind: 'open-search' }
  | { readonly kind: 'open-members' }
  | { readonly kind: 'toggle-members' }
  | { readonly kind: 'dismiss' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'reveal-message'; readonly eventId: string };

export type RoomSurfaceTransitionOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'rejected';
      readonly reason: 'no-active-conversation';
    };

/** One object per kind, so a re-committed URL keeps the rendered surface's identity. */
const SURFACES = {
  members: { kind: 'members' },
  threads: { kind: 'threads' },
  pinned: { kind: 'pinned' },
  search: { kind: 'search' },
} as const satisfies Record<
  Exclude<RenderedRoomSurface['kind'], 'thread'>,
  RenderedRoomSurface
>;

/**
 * Page-scoped lifecycle for the one surface slot beside an exact Conversation. The open
 * panel is the Workspace destination's: a transition asks Workspace to open or close it, and
 * the slot follows once the URL commits.
 */
@Injectable()
export class RoomSurfaceLifecycle {
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reveal = latestGuard();
  private readonly compactConversation = mediaQuerySignal(
    BELOW_MD_QUERY,
    this.destroyRef,
  );

  private readonly activeConversation = computed<ExactRoomSelection | null>(
    () => {
      const accountId = this.workspace.activeAccountId();
      const roomId = this.workspace.activeRoomId();
      return accountId && roomId && this.workspace.pane() === 'conversation'
        ? { accountId, roomId }
        : null;
    },
  );

  private readonly writableState = linkedSignal<
    ExactRoomSelection | null,
    RoomSurfaceState | null
  >({
    source: this.activeConversation,
    computation: (conversation) =>
      conversation
        ? {
            conversation,
            pendingReveal: null,
            jumpTarget: null,
            jumpRevision: 0,
          }
        : null,
  });

  private readonly panel = computed(() =>
    this.activeConversation() ? this.workspace.panel() : null,
  );

  /**
   * The thread the slot may show: one opened here, or a URL's root once it has loaded. It
   * carries the message to reveal, and is dropped once the panel names another root.
   */
  private readonly openedThread = linkedSignal<
    WorkspacePanel | null,
    ThreadRoomSurface | null
  >({
    source: this.panel,
    computation: (panel, previous) =>
      panel?.kind === 'thread' && previous?.value?.rootEventId === panel.root
        ? previous.value
        : null,
  });

  /** The roster was open when the temporary panel now open replaced it. */
  private readonly membersBelow = signal(false);

  readonly membersAreDrawer = mediaQuerySignal(
    BELOW_MEMBERS_QUERY,
    this.destroyRef,
  );
  readonly jumpTarget = computed(
    () => this.writableState()?.jumpTarget ?? null,
  );
  readonly jumpRevision = computed(
    () => this.writableState()?.jumpRevision ?? 0,
  );
  /** A thread the URL names renders once its root has loaded. */
  readonly renderedSurface = computed<RenderedRoomSurface | null>(() => {
    const panel = this.panel();
    if (!panel) return null;
    if (panel.kind !== 'thread') return SURFACES[panel.kind];
    return this.openedThread();
  });
  /** The roster is visible, not merely remembered behind a temporary surface. */
  readonly membersVisible = computed(
    () => this.renderedSurface()?.kind === 'members',
  );

  constructor() {
    // Any way the panel closes, Back included, ends what lay below it.
    effect(() => {
      if (!this.panel()) untracked(() => this.membersBelow.set(false));
    });
    // Reveal once the panel's close has committed, so the row is measured without it.
    effect(() => {
      const state = this.writableState();
      if (!state?.pendingReveal || this.panel()) return;
      const { eventId, token } = state.pendingReveal;
      untracked(() => {
        this.writableState.set({ ...state, pendingReveal: null });
        this.scheduleReveal(state.conversation, eventId, token);
      });
    });

    this.manageFocus();

    const unregister = inject(WorkspaceBackService).register({
      surface: () => this.activeWorkspaceSurface(),
      dismiss: (surface) => this.dismissWorkspaceSurface(surface),
    });
    this.destroyRef.onDestroy(unregister);
  }

  /** Apply one synchronous presentation intent to the active Conversation. */
  transition(intent: RoomSurfaceTransition): RoomSurfaceTransitionOutcome {
    const state = this.writableState();
    if (!state) {
      return { kind: 'rejected', reason: 'no-active-conversation' };
    }
    if (intent.kind !== 'reveal-message') this.reveal.invalidate();

    switch (intent.kind) {
      case 'open-threads':
      case 'open-pinned':
      case 'open-search':
      case 'open-members':
        return this.open({ kind: OPENED_KIND[intent.kind] });

      case 'open-thread':
        this.openedThread.set({
          kind: 'thread',
          rootEventId: intent.rootEventId,
          revealEventId: intent.revealEventId,
        });
        return this.open({ kind: 'thread', root: intent.rootEventId });

      case 'toggle-members':
        if (this.membersVisible()) {
          this.workspace.closePanel();
          return { kind: 'applied' };
        }
        return this.open({ kind: 'members' });

      case 'dismiss':
        return this.dismiss();

      case 'clear':
        if (!this.panel()) return { kind: 'unchanged' };
        this.workspace.closePanel();
        return { kind: 'applied' };

      case 'escape':
        if (this.membersVisible() && !this.membersAreDrawer()) {
          return { kind: 'unchanged' };
        }
        return this.dismiss();

      case 'reveal-message':
        if (this.panel()) this.workspace.closePanel();
        this.writableState.set({
          ...state,
          pendingReveal: { eventId: intent.eventId, token: this.reveal.next() },
        });
        return { kind: 'applied' };
    }
  }

  private open(panel: WorkspacePanel): RoomSurfaceTransitionOutcome {
    const current = this.panel();
    this.membersBelow.set(
      panel.kind !== 'members' &&
        (current?.kind === 'members' ||
          (current !== null && this.membersBelow())),
    );
    if (!sameWorkspacePanel(current, panel)) {
      this.workspace.openPanel(panel);
    }
    return { kind: 'applied' };
  }

  /** Close a temporary panel back to the roster it replaced, or close the roster. */
  private dismiss(): RoomSurfaceTransitionOutcome {
    const panel = this.panel();
    if (!panel) return { kind: 'unchanged' };
    if (panel.kind !== 'members' && this.membersBelow()) {
      this.workspace.openPanel({ kind: 'members' });
    } else {
      this.workspace.closePanel();
    }
    return { kind: 'applied' };
  }

  private scheduleReveal(
    conversation: ExactRoomSelection,
    eventId: string,
    token: LatestToken,
  ): void {
    afterNextRender(
      () => {
        const current = this.writableState();
        if (
          current?.conversation !== conversation ||
          this.panel() ||
          !this.reveal.isCurrent(token)
        ) {
          return;
        }
        this.writableState.set({
          ...current,
          jumpTarget: eventId,
          jumpRevision: current.jumpRevision + 1,
        });
      },
      { injector: this.injector },
    );
  }

  /** Own focus for the slot without overriding focus claimed by a newer interaction. */
  private manageFocus(): void {
    if (typeof document === 'undefined') return;
    let trigger: HTMLElement | null = null;
    let previous: RenderedRoomSurface | null = null;
    effect(() => {
      const panel = this.renderedSurface();
      const isDrawer = this.membersAreDrawer();
      untracked(() => {
        const oldPanel = previous;
        previous = panel;
        if (panel) {
          trigger ??= this.activeElementOutsidePanel();
          if (oldPanel) {
            this.focusPanelAfterRender(panel);
          } else if (panel.kind === 'members' && isDrawer) {
            this.focusPanelAfterRender(panel, trigger);
          }
          return;
        }
        const target = trigger;
        trigger = null;
        if (!target) return;
        afterNextRender(
          () => {
            if (
              this.renderedSurface() === null &&
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

  private focusPanelAfterRender(
    panel: RenderedRoomSurface,
    openingTrigger: HTMLElement | null = null,
  ): void {
    afterNextRender(
      () => {
        const current = this.renderedSurface();
        if (
          !current ||
          !sameRenderedSurface(current, panel) ||
          (document.activeElement !== document.body &&
            document.activeElement !== openingTrigger)
        ) {
          return;
        }
        const target = document.querySelector<HTMLElement>(
          '[data-right-panel-slot] [data-right-panel-focus]',
        );
        if (target?.isConnected) target.focus();
      },
      { injector: this.injector },
    );
  }

  private activeElementOutsidePanel(): HTMLElement | null {
    const active = document.activeElement;
    return active instanceof HTMLElement &&
      active !== document.body &&
      !active.closest('[data-right-panel-surface]')
      ? active
      : null;
  }

  private activeWorkspaceSurface(): WorkspaceSurface | null {
    const panel = this.renderedSurface();
    if (panel) {
      return { layer: 'room', surface: panel };
    }
    const accountId = this.workspace.activeAccountId();
    const roomId = this.workspace.activeRoomId();
    // The signal keeps this reactive; the live query covers the gap before its `change`
    // event, when a busy main thread can deliver Back for a viewport that is already wide.
    return this.compactConversation() &&
      matchesQuery(BELOW_MD_QUERY) &&
      this.workspace.pane() === 'conversation' &&
      accountId &&
      roomId
      ? {
          layer: 'conversation',
          surface: { kind: 'conversation', accountId, roomId },
        }
      : null;
  }

  private dismissWorkspaceSurface(
    surface: WorkspaceSurface,
  ): Observable<WorkspaceDismissResult> {
    return defer(() => {
      const active = this.activeWorkspaceSurface();
      if (!active || !sameWorkspaceSurface(active, surface)) {
        return of('blocked' as const);
      }
      if (surface.layer === 'room') {
        this.transition({ kind: 'dismiss' });
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
}

const OPENED_KIND = {
  'open-threads': 'threads',
  'open-pinned': 'pinned',
  'open-search': 'search',
  'open-members': 'members',
} as const;

function sameRenderedSurface(
  left: RenderedRoomSurface,
  right: RenderedRoomSurface,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'thread' && right.kind === 'thread') {
    return left.rootEventId === right.rootEventId;
  }
  return true;
}

function sameWorkspaceSurface(
  left: WorkspaceSurface,
  right: WorkspaceSurface,
): boolean {
  if (left.layer !== right.layer) return false;
  if (left.layer === 'conversation' && right.layer === 'conversation') {
    return (
      left.surface.accountId === right.surface.accountId &&
      left.surface.roomId === right.surface.roomId
    );
  }
  if (left.layer !== 'room' || right.layer !== 'room') return false;
  if (left.surface.kind !== right.surface.kind) return false;
  if (left.surface.kind === 'thread' && right.surface.kind === 'thread') {
    return left.surface.rootEventId === right.surface.rootEventId;
  }
  return true;
}
