import {
  Injectable,
  Injector,
  effect,
  inject,
  type Signal,
  untracked,
} from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ProjectionRuntime,
  type CapabilityContext,
  type CapabilityRecoveryOutcome,
  type ProjectionObservation,
} from '@trinity/runtime/projection';
import { isTransientMatrixError } from '@trinity/util/matrix';
import {
  Observable,
  Subject,
  Subscription,
  catchError,
  defer,
  filter,
  map,
  of,
  take,
  timeout,
} from 'rxjs';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import type {
  RoomAdministrationHealth,
  RoomAdministrationLifetimeEvent,
  RoomAdministrationOperation,
} from './room-administration-health.models';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import { RoomMembersService } from './room-members.service';

const PREPARATION_BUDGET_MS = 10_000;
const OPERATIONS: readonly RoomAdministrationOperation[] = [
  'permissions',
  'members',
  'bans',
];
const PROJECTIONS = [
  {
    id: 'room-administration.action-permissions',
    operations: ['permissions'] as const,
  },
  {
    id: 'room-administration.members',
    operations: ['members', 'bans'] as const,
  },
] as const;

type RoomAdministrationProjection = (typeof PROJECTIONS)[number];
type RoomAdministrationProjectionId = RoomAdministrationProjection['id'];

/** Room Administration projections and exact Room recovery for one Runtime session. */
@Injectable({ providedIn: 'root' })
export class RoomAdministrationLifetime {
  private readonly injector = inject(Injector);
  private readonly runtime = inject(ProjectionRuntime);
  private readonly matrix = inject(MatrixClientService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly members = inject(RoomMembersService);
  private readonly presentation = inject(RoomAdministrationProjectionState);
  private readonly changes = new Subject<RoomAdministrationHealth>();
  private readonly current = new Map<
    RoomAdministrationOperation,
    RoomAdministrationHealth
  >();
  private generation = 0;
  private retry: ((operation: RoomAdministrationOperation) => void) | null =
    null;
  private scopeCurrent: (() => boolean) | null = null;

  /** Attach on an exact routed Room demand and release with the Runtime session. */
  run(
    demanded: Signal<boolean>,
    roomId: Signal<string | null>,
  ): Observable<RoomAdministrationLifetimeEvent> {
    return new Observable((subscriber) => {
      if (this.retry)
        throw new Error('Room Administration lifetime already owned.');
      const contexts = new Map<string, CapabilityContext>();
      const states = new Map<
        RoomAdministrationProjectionId,
        ProjectionObservation['condition']
      >();
      let accountId: string | null = null;
      let selectedRoomId: string | null = null;
      let required = false;
      let prepared = false;
      let observations = new Subscription();
      let projections = new Subscription();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let ownsProjections = false;
      let applying = false;

      const clearWatchdog = (): void => {
        clearTimeout(watchdog);
        watchdog = undefined;
      };
      const acknowledge = (): void => {
        if (prepared) return;
        prepared = true;
        subscriber.next({ kind: 'prepared' });
      };
      const publish = (
        operation: RoomAdministrationOperation,
        condition: RoomAdministrationHealth['condition'],
        code: RoomAdministrationHealth['code'],
        preparation: RoomAdministrationHealth['preparation'],
      ): void => {
        const previous = this.current.get(operation);
        if (!previous || subscriber.closed) return;
        const ownership = ownsProjections ? 'retained' : 'released';
        const nextPreparation =
          previous.preparation === 'acknowledged' && preparation === 'failed'
            ? 'acknowledged'
            : preparation;
        if (
          previous.condition === condition &&
          previous.code === code &&
          previous.preparation === nextPreparation &&
          previous.ownership === ownership
        )
          return;
        const next: RoomAdministrationHealth = {
          ...previous,
          generation: ++this.generation,
          ownership,
          condition,
          code,
          preparation: nextPreparation,
        };
        this.current.set(operation, next);
        subscriber.next({ kind: 'health', fact: next });
        this.changes.next(next);
      };
      const publishCurrent = (fact: RoomAdministrationHealth): void => {
        this.current.set(fact.operation, fact);
        subscriber.next({ kind: 'health', fact });
        this.changes.next(fact);
      };
      const finishPreparation = (): void => {
        if (
          PROJECTIONS.every((projection) => {
            const condition = states.get(projection.id);
            return condition === 'available' || condition === 'failed';
          })
        ) {
          clearWatchdog();
          acknowledge();
        }
      };
      const ownershipReleased = (): void => {
        if (!ownsProjections) return;
        disconnect();
        for (const operation of OPERATIONS) {
          this.presentation.update(operation, 'released', 'released');
          publish(
            operation,
            'degraded',
            'room-administration-ownership-released',
            'failed',
          );
        }
        clearWatchdog();
        acknowledge();
      };
      const evaluate = (): void => {
        if (!ownsProjections) return;
        for (const projection of PROJECTIONS) {
          const state = states.get(projection.id);
          if (state === 'released') {
            ownershipReleased();
            return;
          }
          if (state !== 'available' && state !== 'failed') continue;
          for (const operation of projection.operations) {
            this.presentation.update(operation, state, 'retained');
            publish(
              operation,
              state === 'available' ? 'available' : 'degraded',
              state === 'available'
                ? 'room-administration-ready'
                : 'room-administration-reconciliation-failed',
              state === 'available' ? 'acknowledged' : 'failed',
            );
          }
        }
        finishPreparation();
      };
      const disconnect = (): void => {
        clearWatchdog();
        observations.unsubscribe();
        observations = new Subscription();
        projections.unsubscribe();
        projections = new Subscription();
        ownsProjections = false;
        states.clear();
      };
      const projectionError = (error: unknown): void => {
        if (isTransientMatrixError(error)) ownershipReleased();
        else subscriber.error(error);
      };
      const attach = (): void => {
        ownsProjections = true;
        for (const projection of PROJECTIONS) {
          states.set(projection.id, 'reconciling');
          for (const operation of projection.operations)
            this.presentation.update(operation, 'reconciling', 'retained');
        }
        projections.add(
          defer(() => this.permissions.runProjection()).subscribe({
            error: projectionError,
            complete: ownershipReleased,
          }),
        );
        if (!ownsProjections || subscriber.closed) return;
        projections.add(
          defer(() => this.members.runProjection()).subscribe({
            error: projectionError,
            complete: ownershipReleased,
          }),
        );
        if (!ownsProjections || subscriber.closed) return;
        for (const projection of PROJECTIONS) {
          observations.add(
            this.runtime
              .observe(projection.id, { kind: 'active-account' })
              .subscribe((state) => {
                if (!ownsProjections || !this.scopeCurrent?.()) return;
                states.set(projection.id, state.condition);
                evaluate();
              }),
          );
        }
        watchdog = setTimeout(() => {
          for (const projection of PROJECTIONS) {
            const condition = states.get(projection.id);
            if (condition === 'available' || condition === 'failed') continue;
            for (const operation of projection.operations) {
              this.presentation.update(operation, 'failed', 'retained');
              publish(
                operation,
                'degraded',
                'room-administration-preparation-timeout',
                'failed',
              );
            }
          }
          acknowledge();
        }, PREPARATION_BUDGET_MS);
      };
      const apply = (): void => {
        if (applying) return;
        const nextAccount = this.matrix.activeUserId();
        const nextRoom = roomId();
        const nextRequired = !!nextAccount && !!nextRoom && demanded();
        if (
          nextAccount === accountId &&
          nextRoom === selectedRoomId &&
          nextRequired === required &&
          this.current.size > 0
        )
          return;
        applying = true;
        try {
          for (const fact of this.current.values()) {
            publish(
              fact.operation,
              'not-applicable',
              'room-administration-not-demanded',
              'acknowledged',
            );
          }
          disconnect();
          accountId = nextAccount;
          selectedRoomId = nextRoom;
          required = nextRequired;
          this.presentation.select(accountId, selectedRoomId);
          this.current.clear();
          for (const operation of OPERATIONS) {
            const key = `${accountId ?? ''}\u001f${selectedRoomId ?? ''}\u001f${operation}`;
            let context = contexts.get(key);
            if (!context) {
              context = Symbol();
              contexts.set(key, context);
            }
            publishCurrent({
              context,
              generation: ++this.generation,
              capability: 'room-administration',
              operation,
              demanded: required,
              preparation: required ? 'pending' : 'acknowledged',
              ownership: 'released',
              condition: required ? 'initializing' : 'not-applicable',
              code: required
                ? 'room-administration-preparing'
                : 'room-administration-not-demanded',
            });
          }
          if (required) attach();
          else acknowledge();
        } finally {
          applying = false;
        }
      };

      this.scopeCurrent = () =>
        required &&
        demanded() &&
        accountId !== null &&
        accountId === this.matrix.activeUserId() &&
        selectedRoomId !== null &&
        selectedRoomId === roomId();
      this.retry = (operation) => {
        if (!this.scopeCurrent?.()) return;
        const retained = ownsProjections;
        const target = projectionFor(operation);
        if (!retained) disconnect();
        const affected = retained ? target.operations : OPERATIONS;
        for (const affectedOperation of affected) {
          this.presentation.update(
            affectedOperation,
            'reconciling',
            'retained',
          );
          publish(
            affectedOperation,
            'recovering',
            'room-administration-preparing',
            'pending',
          );
        }
        if (!retained) attach();
        else if (target.id === 'room-administration.action-permissions')
          this.permissions.retryProjection();
        else this.members.retryProjection();
      };
      apply();
      const changes = effect(
        () => {
          this.matrix.activeUserId();
          demanded();
          roomId();
          untracked(apply);
        },
        { injector: this.injector },
      );
      return () => {
        changes.destroy();
        this.retry = null;
        this.scopeCurrent = null;
        this.current.clear();
        disconnect();
        this.presentation.release();
      };
    });
  }

  recover(
    operation: RoomAdministrationOperation,
    context: CapabilityContext,
    generation: number,
  ): Observable<CapabilityRecoveryOutcome> {
    return defer(() => {
      const current = this.current.get(operation);
      if (
        !this.retry ||
        !this.scopeCurrent?.() ||
        current?.context !== context ||
        current.generation !== generation
      )
        return of({ kind: 'unavailable' } as const);
      return new Observable<CapabilityRecoveryOutcome>((subscriber) => {
        const observation = this.changes
          .pipe(
            filter(
              (fact) =>
                fact.operation === operation &&
                fact.context === context &&
                fact.generation > generation &&
                fact.condition !== 'recovering',
            ),
            take(1),
            map((fact): CapabilityRecoveryOutcome => ({
              kind:
                fact.condition === 'available'
                  ? 'success'
                  : fact.condition === 'not-applicable'
                    ? 'unavailable'
                    : 'failure',
            })),
            timeout(PREPARATION_BUDGET_MS),
            catchError(() => of({ kind: 'failure' } as const)),
          )
          .subscribe(subscriber);
        this.retry?.(operation);
        return () => observation.unsubscribe();
      });
    });
  }
}

function projectionFor(
  operation: RoomAdministrationOperation,
): RoomAdministrationProjection {
  return operation === 'permissions' ? PROJECTIONS[0] : PROJECTIONS[1];
}
