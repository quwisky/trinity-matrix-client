import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  type ParamMap,
} from '@angular/router';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  InvitesService,
  RoomLibraryService,
  RoomReadinessService,
  SpacesService,
} from '@trinity/data-access/room-library';
import type { WorkspaceSearchIntent } from '@trinity/application/workspace';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { BELOW_MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import {
  Observable,
  type Subscription,
  combineLatest,
  concatMap,
  defer,
  filter,
  map,
  of,
  startWith,
  switchMap,
} from 'rxjs';
import { MruRoomsService } from '../shortcuts/mru-rooms.service';
import {
  RECENT_WORKSPACE_SCOPE,
  sameWorkspaceDestination,
  type WorkspaceDestination,
  type WorkspaceEventTarget,
  type WorkspaceOpenOptions,
  type WorkspaceOpenOutcome,
  type WorkspaceScope,
  type WorkspaceTransitionMetrics,
  type WorkspaceView,
  workspaceViewOf,
} from './workspace.models';
import { WorkspaceTransitionWorkflow } from './workspace-transition.workflow';
import { parseWorkspaceUrl } from './workspace-url';

/**
 * The application workflow that owns the semantic Workspace destination.
 *
 * The Router is an inbound/outbound projection rather than a second store: URL restoration
 * enters through {@link open}, while every successful command publishes one immutable view
 * only after Account readiness and the canonical navigation have both settled.
 */
@Injectable()
export class WorkspaceService {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly workflow = inject(WorkspaceTransitionWorkflow);
  private readonly conversations = inject(ConversationRuntime);
  private readonly media = inject(MediaPipeline);
  private readonly rooms = inject(RoomLibraryService);
  private readonly roomReadiness = inject(RoomReadinessService);
  private readonly invites = inject(InvitesService);
  private readonly spaces = inject(SpacesService);
  private readonly mru = inject(MruRoomsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly compact = mediaQuerySignal(BELOW_MD_QUERY, this.destroyRef);
  private readonly routeMaps = toSignal(
    combineLatest([this.route.paramMap, this.route.queryParamMap]),
    { requireSync: true },
  );
  private readonly workspaceView = signal<WorkspaceView>(this.seedView());
  private readonly transitionMetrics =
    signal<WorkspaceTransitionMetrics | null>(null);
  private readonly eventTargetState = signal<WorkspaceEventTarget | null>(null);
  private hierarchySubscription: Subscription | null = null;

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
    this.project(this.view(), true);
    // The Router adapter writes both maps before its navigation settles. Those emissions
    // are projections of the in-flight command, not a second inbound destination.
    this.routeLocations()
      .pipe(
        filter(() => !this.workflow.projectingUrl),
        map(([params, query]) =>
          parseWorkspaceUrl(params, query, this.accounts.activeAccountId()),
        ),
        concatMap((parsed) => {
          if (!parsed.destination) {
            this.eventTargetState.set(null);
            return of(null);
          }
          if (
            parsed.canonical &&
            sameWorkspaceDestination(this.view(), parsed.destination)
          ) {
            this.publishEventTarget(parsed.eventId ?? null);
            return of(null);
          }
          return this.open(parsed.destination, {
            source: 'restore',
            history: 'replace',
          }).pipe(
            map((outcome) => {
              if (outcome.kind === 'ready') {
                this.publishEventTarget(
                  outcome.view.roomId === parsed.destination?.roomId
                    ? (parsed.eventId ?? null)
                    : null,
                );
              }
              return outcome;
            }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private publishEventTarget(eventId: string | null): void {
    this.eventTargetState.set(eventId ? { eventId } : null);
  }

  /**
   * Open one exact semantic destination as a cold, joining RxJS command.
   *
   * User intent pushes history. Restoration, canonical repair, and an unavailable room or
   * space replace it. A conflicting command receives a typed outcome before any mutation.
   */
  open(
    destination: WorkspaceDestination,
    options: WorkspaceOpenOptions,
  ): Observable<WorkspaceOpenOutcome> {
    return defer(() =>
      this.workflow.run(destination, options, this.view(), {
        release: () => this.release(),
        restore: (view) => this.project(view),
        commit: (view, metrics, committedOptions) => {
          const changed = !sameWorkspaceDestination(this.view(), view);
          this.workspaceView.set(view);
          this.transitionMetrics.set(metrics);
          if (changed) this.project(view);
          if (committedOptions.source === 'user' && view.roomId) {
            this.mru.record(view.roomId);
          }
        },
      }),
    );
  }

  /**
   * Resolve one fully qualified Global Search intent through the authoritative
   * Workspace workflow. Account context is never re-derived from a mutable row list:
   * exact Rooms/Spaces open directly, while people and invitations first perform the
   * named Account action and then open the resulting semantic destination.
   */
  openSearchIntent(
    intent: WorkspaceSearchIntent,
  ): Observable<WorkspaceOpenOutcome> {
    return defer(() => {
      switch (intent.kind) {
        case 'conversation':
          return this.open(
            this.roomDestination(intent.accountId, intent.roomId),
            { source: 'user', history: 'push' },
          );
        case 'space':
          return this.open(
            this.scopeDestination(intent.accountId, {
              kind: 'space',
              spaceId: intent.spaceId,
            }),
            { source: 'user', history: 'push' },
          );
        case 'person':
          return this.ensureSearchAccount(intent.accountId).pipe(
            switchMap((activation) =>
              activation
                ? of(activation)
                : this.rooms
                    .createDirectMessage(intent.userId)
                    .pipe(
                      switchMap((roomId) =>
                        this.roomReadiness
                          .waitForRoom(intent.accountId, roomId)
                          .pipe(
                            switchMap(() =>
                              this.open(
                                this.roomInScopeDestination(
                                  intent.accountId,
                                  roomId,
                                  { kind: 'home' },
                                ),
                                { source: 'user', history: 'push' },
                              ),
                            ),
                          ),
                      ),
                    ),
            ),
          );
        case 'invitation':
          return this.invites
            .acceptInvite(intent.roomId, intent.accountId)
            .pipe(
              switchMap(() =>
                this.roomReadiness
                  .waitForRoom(intent.accountId, intent.roomId)
                  .pipe(
                    switchMap(() =>
                      intent.target === 'space'
                        ? this.open(
                            this.scopeDestination(intent.accountId, {
                              kind: 'space',
                              spaceId: intent.roomId,
                            }),
                            { source: 'user', history: 'push' },
                          )
                        : this.open(
                            this.roomInScopeDestination(
                              intent.accountId,
                              intent.roomId,
                              intent.target === 'direct'
                                ? { kind: 'home' }
                                : RECENT_WORKSPACE_SCOPE,
                            ),
                            { source: 'user', history: 'push' },
                          ),
                    ),
                  ),
              ),
            );
        default:
          return this.unreachableSearchIntent(intent);
      }
    });
  }

  /** Preserve a non-space scope when a room on another Account is selected. */
  roomDestination(accountId: string, roomId: string): WorkspaceDestination {
    const current = this.view();
    const scope =
      current.scope.kind !== 'space' ? current.scope : RECENT_WORKSPACE_SCOPE;
    return { accountId, scope, roomId, pane: 'conversation' };
  }

  /** Open a room and sidebar scope as one destination and one history entry. */
  roomInScopeDestination(
    accountId: string,
    roomId: string,
    scope: WorkspaceScope,
  ): WorkspaceDestination {
    return { accountId, scope, roomId, pane: 'conversation' };
  }

  /** Select a sidebar scope, retaining the open room only on the same Account. */
  scopeDestination(
    accountId: string,
    scope: WorkspaceScope,
  ): WorkspaceDestination {
    const current = this.view();
    return {
      accountId,
      scope,
      roomId: current.accountId === accountId ? current.roomId : null,
      pane: current.accountId === accountId ? current.pane : 'list',
    };
  }

  /** Close the compact Conversation while keeping its sidebar scope addressable. */
  listDestination(): WorkspaceDestination | null {
    const current = this.view();
    return current.accountId
      ? {
          accountId: current.accountId,
          scope: current.scope,
          roomId: current.roomId,
          pane: 'list',
        }
      : null;
  }

  /** Return to the current list after the selected Room ceases to exist. */
  unselectedListDestination(): WorkspaceDestination | null {
    const current = this.view();
    return current.accountId
      ? {
          accountId: current.accountId,
          scope: current.scope,
          roomId: null,
          pane: 'list',
        }
      : null;
  }

  /** The explicit destination for a manual Account switch. */
  accountDestination(accountId: string): WorkspaceDestination {
    return {
      accountId,
      scope: { kind: 'home' },
      roomId: null,
      pane: 'list',
    };
  }

  /** Null means the requested Account is ready; a non-ready outcome stops resolution. */
  private ensureSearchAccount(
    accountId: string,
  ): Observable<WorkspaceOpenOutcome | null> {
    if (this.activeAccountId() === accountId) return of(null);
    return this.open(this.accountDestination(accountId), {
      source: 'repair',
      history: 'replace',
    }).pipe(map((outcome) => (outcome.kind === 'ready' ? null : outcome)));
  }

  private unreachableSearchIntent(intent: never): never {
    throw new Error(`Unsupported Workspace search intent: ${String(intent)}`);
  }

  /** Release page-scoped projection ownership without changing semantic history. */
  release(): void {
    this.conversations.blur();
    this.media.releaseAll();
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
    const [params, query] = this.routeMaps();
    const activeAccountId = this.accounts.activeAccountId();
    const parsed = parseWorkspaceUrl(params, query, activeAccountId);
    const destination = parsed.destination;
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

  private routeLocations(): Observable<readonly [ParamMap, ParamMap]> {
    // Production observes NavigationEnd, where path and query maps are one committed URL.
    // Narrow coordinator tests intentionally provide only the two route streams, so retain
    // that adapter fallback without weakening the production atomicity guarantee.
    if (this.router.events && this.route.snapshot) {
      return this.router.events.pipe(
        filter((event) => event instanceof NavigationEnd),
        startWith(null),
        map(
          () =>
            [
              this.route.snapshot.paramMap,
              this.route.snapshot.queryParamMap,
            ] as const,
        ),
      );
    }
    return combineLatest([this.route.paramMap, this.route.queryParamMap]);
  }
}
