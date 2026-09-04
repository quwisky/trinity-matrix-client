import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  InvitesService,
  RoomLibraryService,
  RoomReadinessService,
  SpacesService,
} from '@trinity/data-access/room-library';
import {
  type WorkspaceEventTarget,
  WorkspaceNavigationIntent,
  WorkspaceNavigationOutcome,
  type WorkspaceTransitionMetrics,
  type WorkspaceView,
} from './workspace-navigation.models';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { BELOW_MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import {
  Observable,
  type Subscription,
  concatMap,
  defer,
  filter,
  last,
  map,
  of,
  switchMap,
} from 'rxjs';
import { WorkspaceVisitHistoryService } from './workspace-visit-history.service';
import {
  RECENT_WORKSPACE_SCOPE,
  sameWorkspaceDestination,
  type WorkspaceDestination,
  type WorkspaceOpenOptions,
  type WorkspaceOpenOutcome,
  workspaceViewOf,
} from './workspace.models';
import { WorkspaceTransitionWorkflow } from './workspace-transition.workflow';
import { WorkspaceLocationAdapter } from './workspace-location.adapter';
import { resolveWorkspaceNavigation } from './workspace-navigation.resolver';

/**
 * The application workflow that owns the semantic Workspace destination.
 *
 * The Router is an inbound/outbound projection rather than a second store: URL restoration
 * enters through {@link navigate}, while every successful command publishes one immutable view
 * only after Account readiness and the canonical navigation have both settled.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceNavigationService {
  private readonly accounts = inject(AccountRuntimeService);
  private readonly workflow = inject(WorkspaceTransitionWorkflow);
  private readonly location = inject(WorkspaceLocationAdapter);
  private readonly conversations = inject(ConversationRuntime);
  private readonly media = inject(MediaPipeline);
  private readonly rooms = inject(RoomLibraryService);
  private readonly roomReadiness = inject(RoomReadinessService);
  private readonly invites = inject(InvitesService);
  private readonly spaces = inject(SpacesService);
  private readonly mru = inject(WorkspaceVisitHistoryService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly compact = mediaQuerySignal(BELOW_MD_QUERY, this.destroyRef);
  private readonly workspaceView = signal<WorkspaceView>(this.seedView());
  private readonly transitionMetrics =
    signal<WorkspaceTransitionMetrics | null>(null);
  private readonly eventTargetState = signal<WorkspaceEventTarget | null>(null);
  private hierarchySubscription: Subscription | null = null;
  private projectionsActive = false;
  private hasProjected = false;

  readonly view = this.workspaceView.asReadonly();
  readonly lastTransition = this.transitionMetrics.asReadonly();
  readonly eventTarget = this.eventTargetState.asReadonly();
  readonly activeAccountId = computed(() => this.view().accountId);
  readonly activeSpaceId = computed(() => {
    const scope = this.view().scope;
    return scope.kind === 'space' ? scope.spaceId : null;
  });
  readonly recentView = computed(() => this.view().scope.kind === 'recent');
  readonly roomsView = computed(() => this.view().scope.kind === 'rooms');
  readonly activeRoomId = computed(() => this.view().roomId);
  readonly pane = computed(() => this.view().pane);
  readonly placement = computed(() =>
    this.compact() ? this.view().pane : 'split',
  );

  constructor() {
    this.location
      .changes(() => this.accounts.activeAccountId())
      .pipe(
        filter(() => !this.workflow.projectingLocation),
        concatMap((location) => {
          if (location.kind === 'outside') {
            this.releaseProjections();
            return of(null);
          }
          const parsed = location.parsed;
          if (!parsed.destination) {
            this.eventTargetState.set(null);
            return of(null);
          }
          return this.navigate({
            kind: 'restoration',
            accountId: parsed.destination.accountId,
            scope: parsed.destination.scope,
            roomId: parsed.destination.roomId,
            pane: parsed.destination.pane,
            ...(parsed.eventId ? { eventId: parsed.eventId } : {}),
            canonical: parsed.canonical,
          });
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private publishEventTarget(eventId: string | null): void {
    this.eventTargetState.set(eventId ? { eventId } : null);
  }

  private transition(
    destination: WorkspaceDestination,
    options: WorkspaceOpenOptions,
  ): Observable<WorkspaceOpenOutcome> {
    return defer(() => {
      const attemptOptions = this.projectionsActive
        ? options
        : { ...options, force: true };
      return this.workflow.run(destination, attemptOptions, this.view(), {
        release: () => this.releaseProjections(),
        restore: (view) => {
          this.projectionsActive = true;
          this.hasProjected = true;
          this.project(view);
        },
        commit: (view, metrics, committedOptions) => {
          const changed = !sameWorkspaceDestination(this.view(), view);
          const needsProjection = changed || !this.projectionsActive;
          this.workspaceView.set(view);
          this.transitionMetrics.set(metrics);
          if (Object.hasOwn(committedOptions, 'eventId')) {
            this.publishEventTarget(
              view.roomId && committedOptions.eventId
                ? committedOptions.eventId
                : null,
            );
          }
          this.projectionsActive = true;
          if (needsProjection) {
            const initial = !this.hasProjected;
            this.hasProjected = true;
            this.project(view, initial);
          }
          if (
            committedOptions.source === 'user' &&
            view.accountId &&
            view.roomId
          ) {
            this.mru.record({ accountId: view.accountId, roomId: view.roomId });
          }
        },
      });
    });
  }

  /**
   * Resolve product navigation intent inside Workspace.
   *
   * Keeping resolution inside `defer` means current scope and pane are read only when the
   * command is subscribed. Destinations, history, and transition sources stay private.
   */
  navigate(
    intent: WorkspaceNavigationIntent,
  ): Observable<WorkspaceNavigationOutcome> {
    return defer(() => {
      if (intent.kind === 'person') return this.navigatePerson(intent);
      if (intent.kind === 'invitation') return this.navigateInvitation(intent);
      if (intent.kind === 'history') return this.navigateHistory(intent);
      const resolved = resolveWorkspaceNavigation(intent, this.view());
      if (!resolved) {
        return of({
          kind: 'unavailable',
          reason: 'navigation-rejected',
        } as const);
      }
      const unchanged =
        this.projectionsActive &&
        sameWorkspaceDestination(this.view(), resolved.destination);
      const eventId =
        intent.kind === 'notification' || intent.kind === 'restoration'
          ? normalizeEventId(intent.eventId)
          : null;
      const currentEventId = this.eventTarget()?.eventId ?? null;
      const options =
        eventId === currentEventId
          ? resolved.options
          : { ...resolved.options, eventId };
      return this.transition(resolved.destination, options).pipe(
        map((outcome): WorkspaceNavigationOutcome => {
          switch (outcome.kind) {
            case 'ready': {
              if (!Object.hasOwn(options, 'eventId')) {
                this.publishEventTarget(
                  outcome.view.roomId === resolved.destination.roomId
                    ? eventId
                    : null,
                );
              }
              return {
                kind: 'ready',
                change:
                  unchanged && !outcome.repaired ? 'unchanged' : 'committed',
              };
            }
            case 'failed':
              return { kind: 'unavailable', reason: outcome.failure };
            case 'transition-in-progress':
              return {
                kind: 'unavailable',
                reason: 'transition-in-progress',
              };
          }
        }),
      );
    });
  }

  private navigateHistory(
    intent: Extract<WorkspaceNavigationIntent, { readonly kind: 'history' }>,
  ): Observable<WorkspaceNavigationOutcome> {
    const accountId = this.activeAccountId();
    const roomId = this.activeRoomId();
    const current = accountId && roomId ? { accountId, roomId } : null;
    const known = [
      ...(current ? [current] : []),
      ...intent.availableRooms,
    ].filter(
      (room, index, rooms) =>
        rooms.findIndex(
          (candidate) =>
            candidate.accountId === room.accountId &&
            candidate.roomId === room.roomId,
        ) === index,
    );
    const target =
      intent.action === 'hop'
        ? this.mru.hop(intent.direction, current, known)
        : this.mru.nth(intent.position, current, known);
    if (!target || sameRoomIdentity(target, current)) {
      return of({ kind: 'ready', change: 'unchanged' });
    }
    return this.navigate({
      kind: 'room',
      ...target,
      origin: intent.action === 'hop' ? 'room-hop' : 'shortcut',
    });
  }

  private navigatePerson(
    intent: Extract<WorkspaceNavigationIntent, { readonly kind: 'person' }>,
  ): Observable<WorkspaceNavigationOutcome> {
    const prepare =
      this.activeAccountId() === intent.accountId
        ? of({ kind: 'ready', change: 'unchanged' } as const)
        : this.navigate({
            kind: 'account',
            accountId: intent.accountId,
            origin: 'search-preparation',
          });
    return prepare.pipe(
      // The next semantic command starts only after the Account transition has released
      // its join/conflict lock, not merely after its terminal value was published.
      last(),
      switchMap((outcome) =>
        outcome.kind === 'unavailable'
          ? of(outcome)
          : this.rooms.createDirectMessage(intent.userId).pipe(
              switchMap((roomId) =>
                this.roomReadiness.waitForRoom(intent.accountId, roomId).pipe(
                  switchMap(() =>
                    this.navigate({
                      kind: 'room',
                      accountId: intent.accountId,
                      roomId,
                      scope: { kind: 'home' },
                      origin: 'global-search',
                    }),
                  ),
                ),
              ),
            ),
      ),
    );
  }

  private navigateInvitation(
    intent: Extract<WorkspaceNavigationIntent, { readonly kind: 'invitation' }>,
  ): Observable<WorkspaceNavigationOutcome> {
    return this.invites.acceptInvite(intent.roomId, intent.accountId).pipe(
      switchMap(() =>
        this.roomReadiness.waitForRoom(intent.accountId, intent.roomId),
      ),
      switchMap(() =>
        intent.target === 'space'
          ? this.navigate({
              kind: 'space',
              accountId: intent.accountId,
              spaceId: intent.roomId,
            })
          : this.navigate({
              kind: 'room',
              accountId: intent.accountId,
              roomId: intent.roomId,
              scope:
                intent.target === 'direct'
                  ? { kind: 'home' }
                  : RECENT_WORKSPACE_SCOPE,
              origin: 'global-search',
            }),
      ),
    );
  }

  private releaseProjections(): void {
    if (!this.projectionsActive) return;
    this.projectionsActive = false;
    this.hierarchySubscription?.unsubscribe();
    this.hierarchySubscription = null;
    this.conversations.blur();
    this.media.releaseAll();
    this.eventTargetState.set(null);
  }

  private project(view: WorkspaceView, initial = false): void {
    if (!initial) this.media.releaseAll();
    this.hierarchySubscription?.unsubscribe();
    this.hierarchySubscription = this.spaces
      .openSpace(view.scope.kind === 'space' ? view.scope.spaceId : null)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: () => undefined });
    if (!view.accountId || !view.roomId) {
      if (!initial) this.conversations.blur();
      return;
    }
    this.conversations.focus({
      accountId: view.accountId,
      roomId: view.roomId,
    });
    this.rooms
      .clearMarkedUnread(view.roomId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // Opening a room should not toast if this best-effort cleanup fails; the flag
        // remains visible and the next open retries, but the workflow still owns the
        // command subscription and cancellation.
        error: () => undefined,
      });
  }

  private seedView(): WorkspaceView {
    const activeAccountId = this.accounts.activeAccountId();
    const location = this.location.current(activeAccountId);
    const destination =
      location.kind === 'workspace' ? location.parsed.destination : null;
    if (
      destination &&
      destination.accountId === activeAccountId &&
      this.seedDestinationExists(destination)
    ) {
      return workspaceViewOf(destination);
    }
    return Object.freeze({
      accountId: activeAccountId,
      scope: RECENT_WORKSPACE_SCOPE,
      roomId: null,
      pane: 'list',
    });
  }

  private seedDestinationExists(destination: WorkspaceDestination): boolean {
    if (
      destination.scope.kind === 'space' &&
      !this.selectionAvailable(destination.accountId, destination.scope.spaceId)
    ) {
      return false;
    }
    return (
      !destination.roomId ||
      this.selectionAvailable(destination.accountId, destination.roomId)
    );
  }

  private selectionAvailable(accountId: string, roomId: string): boolean {
    return this.rooms.selectionAvailability(accountId, roomId) === 'available';
  }
}

function normalizeEventId(eventId: string | undefined): string | null {
  return eventId?.startsWith('$') && eventId.length > 1 ? eventId : null;
}

function sameRoomIdentity(
  left: { readonly accountId: string; readonly roomId: string },
  right: { readonly accountId: string; readonly roomId: string } | null,
): boolean {
  return (
    right !== null &&
    left.accountId === right.accountId &&
    left.roomId === right.roomId
  );
}
