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
  type WorkspaceDismissResult,
  type WorkspaceRoomSurface,
  type WorkspaceSurface,
} from '@trinity/application/workspace';
import type { MemberSummary } from '@trinity/data-access/room-administration';
import {
  BELOW_MD_QUERY,
  BELOW_MEMBERS_QUERY,
  mediaQuerySignal,
} from '@trinity/util/ui';
import { Observable, defer, map, of } from 'rxjs';
import type { ExactRoomSelection } from '../shared/exact-selection';

export type MessageRoomSurface = Extract<
  WorkspaceRoomSurface,
  { readonly kind: 'threads' | 'thread' | 'pinned' | 'search' }
>;

export interface MemberRoomSurface {
  readonly kind: 'member';
  readonly member: MemberSummary;
  readonly direct: boolean;
}

type TemporaryRoomSurface = MessageRoomSurface | MemberRoomSurface;
type MembersRoomSurface = { readonly kind: 'members' };
type MemberReturnSurface = MessageRoomSurface | MembersRoomSurface | null;

export type RenderedRoomSurface = TemporaryRoomSurface | MembersRoomSurface;

export interface RoomSurfaceState {
  readonly conversation: ExactRoomSelection;
  readonly surface: TemporaryRoomSurface | null;
  readonly memberReturnSurface: MemberReturnSurface;
  readonly jumpTarget: string | null;
  readonly jumpRevision: number;
}

export type RoomSurfaceTransition =
  | { readonly kind: 'open'; readonly surface: MessageRoomSurface }
  | {
      readonly kind: 'open-member';
      readonly member: MemberSummary;
      readonly direct: boolean;
    }
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

const MEMBERS_SURFACE: MembersRoomSurface = { kind: 'members' };

/** Page-scoped lifecycle for the one surface slot beside an exact Conversation. */
@Injectable()
export class RoomSurfaceLifecycle {
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly membersRequested = signal(false);
  private revealGeneration = 0;
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
            surface: null,
            memberReturnSurface: null,
            jumpTarget: null,
            jumpRevision: 0,
          }
        : null,
  });

  readonly membersAreDrawer = mediaQuerySignal(
    BELOW_MEMBERS_QUERY,
    this.destroyRef,
  );
  readonly state = computed(() => this.writableState());
  readonly conversation = computed(
    () => this.writableState()?.conversation ?? null,
  );
  readonly surface = computed(() => this.writableState()?.surface ?? null);
  readonly jumpTarget = computed(
    () => this.writableState()?.jumpTarget ?? null,
  );
  readonly jumpRevision = computed(
    () => this.writableState()?.jumpRevision ?? 0,
  );
  readonly renderedSurface = computed<RenderedRoomSurface | null>(() => {
    const state = this.writableState();
    if (!state) return null;
    return state.surface ?? (this.membersRequested() ? MEMBERS_SURFACE : null);
  });
  /** The roster is visible, not merely remembered behind a temporary surface. */
  readonly membersVisible = computed(
    () => this.renderedSurface()?.kind === 'members',
  );

  constructor() {
    effect(() => {
      const target = this.workspace.eventTarget();
      if (!target) return;
      untracked(() =>
        this.transition({
          kind: 'reveal-message',
          eventId: target.eventId,
        }),
      );
    });

    let wasDrawer = this.membersAreDrawer();
    effect(() => {
      const isDrawer = this.membersAreDrawer();
      if (isDrawer && !wasDrawer) {
        untracked(() => this.clearRememberedMembers());
      }
      wasDrawer = isDrawer;
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
    if (intent.kind !== 'reveal-message') this.revealGeneration += 1;

    switch (intent.kind) {
      case 'open':
        this.writableState.set({
          ...state,
          surface: intent.surface,
          memberReturnSurface: null,
        });
        return { kind: 'applied' };

      case 'open-member': {
        const memberReturnSurface =
          state.surface?.kind === 'member'
            ? state.memberReturnSurface
            : (state.surface ??
              (this.membersRequested() ? MEMBERS_SURFACE : null));
        this.writableState.set({
          ...state,
          surface: {
            kind: 'member',
            member: intent.member,
            direct: intent.direct,
          },
          memberReturnSurface,
        });
        return { kind: 'applied' };
      }

      case 'open-members':
        this.membersRequested.set(true);
        this.writableState.set({
          ...state,
          surface: null,
          memberReturnSurface: null,
        });
        return { kind: 'applied' };

      case 'toggle-members':
        if (this.membersVisible()) {
          this.membersRequested.set(false);
          return { kind: 'applied' };
        }
        return this.transition({ kind: 'open-members' });

      case 'dismiss':
        return this.dismiss(state);

      case 'clear':
        if (!state.surface && !this.membersRequested()) {
          return { kind: 'unchanged' };
        }
        this.membersRequested.set(false);
        this.writableState.set({
          ...state,
          surface: null,
          memberReturnSurface: null,
        });
        return { kind: 'applied' };

      case 'escape':
        if (this.membersVisible() && !this.membersAreDrawer()) {
          return { kind: 'unchanged' };
        }
        return this.dismiss(state);

      case 'reveal-message':
        this.revealGeneration += 1;
        this.writableState.set({
          ...state,
          surface: null,
          memberReturnSurface: null,
        });
        this.scheduleReveal(
          state.conversation,
          intent.eventId,
          this.revealGeneration,
        );
        return { kind: 'applied' };
    }
  }

  private dismiss(state: RoomSurfaceState): RoomSurfaceTransitionOutcome {
    const surface = state.surface;
    if (surface?.kind === 'member') {
      const returnSurface = state.memberReturnSurface;
      if (returnSurface?.kind === 'members') {
        this.membersRequested.set(true);
        this.writableState.set({
          ...state,
          surface: null,
          memberReturnSurface: null,
        });
      } else {
        this.writableState.set({
          ...state,
          surface: returnSurface,
          memberReturnSurface: null,
        });
      }
      return { kind: 'applied' };
    }
    if (surface) {
      this.writableState.set({
        ...state,
        surface: null,
        memberReturnSurface: null,
      });
      return { kind: 'applied' };
    }
    if (this.membersRequested()) {
      this.membersRequested.set(false);
      return { kind: 'applied' };
    }
    return { kind: 'unchanged' };
  }

  private clearRememberedMembers(): void {
    if (!this.membersRequested()) return;
    this.membersRequested.set(false);
    const state = this.writableState();
    if (state?.memberReturnSurface?.kind === 'members') {
      this.writableState.set({ ...state, memberReturnSurface: null });
    }
  }

  private scheduleReveal(
    conversation: ExactRoomSelection,
    eventId: string,
    generation: number,
  ): void {
    afterNextRender(
      () => {
        const current = this.writableState();
        if (
          current?.conversation !== conversation ||
          current.surface ||
          generation !== this.revealGeneration
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
      return {
        layer: 'room',
        surface:
          panel.kind === 'member'
            ? { kind: 'member', userId: panel.member.userId }
            : panel,
      };
    }
    const accountId = this.workspace.activeAccountId();
    const roomId = this.workspace.activeRoomId();
    return this.compactConversation() &&
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

function sameRenderedSurface(
  left: RenderedRoomSurface,
  right: RenderedRoomSurface,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'thread' && right.kind === 'thread') {
    return left.rootEventId === right.rootEventId;
  }
  if (left.kind === 'member' && right.kind === 'member') {
    return left.member.userId === right.member.userId;
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
  if (left.surface.kind === 'member' && right.surface.kind === 'member') {
    return left.surface.userId === right.surface.userId;
  }
  return true;
}
