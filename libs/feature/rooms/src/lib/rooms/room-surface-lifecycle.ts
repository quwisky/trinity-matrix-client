import {
  DestroyRef,
  Injectable,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  untracked,
} from '@angular/core';
import {
  WorkspaceBackService,
  WorkspaceNavigationService,
  type WorkspaceDismissResult,
  type WorkspaceRoomSurface,
  type WorkspaceSurface,
} from '@trinity/application/workspace';
import { Observable, of } from 'rxjs';
import type { ExactRoomSelection } from '../shared/exact-selection';
import { RoomShellStore, type LegacyMemberSurface } from './room-shell-store';

export type MessageRoomSurface = Extract<
  WorkspaceRoomSurface,
  { readonly kind: 'threads' | 'thread' | 'pinned' | 'search' }
>;

export type RenderedRoomSurface =
  MessageRoomSurface | Exclude<LegacyMemberSurface, null>;

export interface RoomSurfaceState {
  readonly conversation: ExactRoomSelection;
  readonly surface: MessageRoomSurface | null;
  readonly jumpTarget: string | null;
  readonly jumpRevision: number;
}

export type RoomSurfaceTransition =
  | { readonly kind: 'open'; readonly surface: MessageRoomSurface }
  | { readonly kind: 'dismiss' }
  | { readonly kind: 'reveal-message'; readonly eventId: string };

export type RoomSurfaceTransitionOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'rejected';
      readonly reason: 'no-active-conversation';
    };

/** Page-scoped state machine for message-related surfaces in one exact Conversation. */
@Injectable()
export class RoomSurfaceLifecycle {
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly legacyStore = inject(RoomShellStore);
  private readonly injector = inject(Injector);

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
            jumpTarget: null,
            jumpRevision: 0,
          }
        : null,
  });

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
  readonly renderedSurface = computed<RenderedRoomSurface | null>(
    () => this.surface() ?? this.legacyStore.rightPanel(),
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
    const unregister = inject(WorkspaceBackService).register({
      surface: () => {
        const surface = this.surface();
        return surface ? { layer: 'room', surface } : null;
      },
      dismiss: (surface) => this.dismissWorkspaceSurface(surface),
    });
    inject(DestroyRef).onDestroy(unregister);
  }

  /** Apply one synchronous message-surface intent to the active Conversation. */
  transition(intent: RoomSurfaceTransition): RoomSurfaceTransitionOutcome {
    const state = this.writableState();
    if (!state) {
      return { kind: 'rejected', reason: 'no-active-conversation' };
    }

    if (intent.kind === 'open') {
      this.legacyStore.rightPanel.set(null);
      this.writableState.set({ ...state, surface: intent.surface });
      return { kind: 'applied' };
    }

    if (intent.kind === 'dismiss') {
      if (!state.surface) return { kind: 'unchanged' };
      this.writableState.set({ ...state, surface: null });
      return { kind: 'applied' };
    }

    this.legacyStore.rightPanel.set(null);
    this.writableState.set({ ...state, surface: null });
    const conversation = state.conversation;
    afterNextRender(
      () => {
        const current = this.writableState();
        if (
          current?.conversation !== conversation ||
          current.surface ||
          this.legacyStore.rightPanel()
        ) {
          return;
        }
        this.writableState.set({
          ...current,
          jumpTarget: intent.eventId,
          jumpRevision: current.jumpRevision + 1,
        });
      },
      { injector: this.injector },
    );
    return { kind: 'applied' };
  }

  private dismissWorkspaceSurface(
    surface: WorkspaceSurface,
  ): Observable<WorkspaceDismissResult> {
    const active = this.surface();
    if (
      surface.layer !== 'room' ||
      !active ||
      !sameMessageSurface(active, surface.surface)
    ) {
      return of('blocked');
    }
    this.transition({ kind: 'dismiss' });
    return of('dismissed');
  }
}

function sameMessageSurface(
  left: MessageRoomSurface,
  right: WorkspaceRoomSurface,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'thread' && right.kind === 'thread'
    ? left.rootEventId === right.rootEventId
    : true;
}
