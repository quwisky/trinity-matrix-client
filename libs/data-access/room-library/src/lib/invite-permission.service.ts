import { Injectable, computed, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  Observable,
  defer,
  finalize,
  from,
  lastValueFrom,
  map,
  of,
  share,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { plainEqual } from '@trinity/util/matrix';
import type { InviteBlocking } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { unwrapOwned } from './unwrap-owned';

/**
 * The active account's server-enforced "Who can invite you" setting (MSC4380). Blocking makes
 * the homeserver refuse every invite to this account; it is not a client-side filter.
 */
@Injectable({ providedIn: 'root' })
export class InvitePermissionService {
  private readonly engine = inject(ROOM_LIST_ENGINE);
  private readonly session = inject(SessionStateService);
  private writes: Promise<void> = Promise.resolve();
  private readonly state = signal<InviteBlocking | null>(null);

  /** The active account; a new generation is a new client to read from. */
  private readonly active = computed(
    () => {
      const accountId = this.session.activeAccountId();
      const generation = accountId
        ? this.session.status(accountId)?.generation
        : undefined;
      return accountId && generation !== undefined
        ? { accountId, generation }
        : null;
    },
    { equal: plainEqual },
  );

  private readonly active$ = toObservable(this.active);

  private readonly projection = this.active$.pipe(
    switchMap((active) =>
      active ? this.engine.inviteBlocking(active.accountId) : of(null),
    ),
    tap((state) => this.state.set(state)),
    map(() => void 0),
    finalize(() => this.state.set(null)),
    share(),
  );

  /** Whether the server enforces invite blocking; null while no account is projected. */
  readonly supported = computed(() => this.state()?.supported ?? null);

  /** Whether the server currently turns down every invite to this account. */
  readonly blocked = computed(() => this.state()?.blocked ?? false);

  /** Cold projection lifetime, held by the surface that shows the setting. */
  runProjection(): Observable<void> {
    return this.projection;
  }

  /**
   * Block or allow every invite to the account active when this is called. Writes run one at a
   * time, in call order, and a queued write still runs if its caller unsubscribes.
   */
  setBlocked(blocked: boolean): Observable<void> {
    const accountId = this.session.activeAccountId();
    return defer(() => {
      if (!accountId) {
        return throwError(() => new Error('Not signed in.'));
      }
      const run = this.writes.then(() =>
        lastValueFrom(
          this.engine.setInviteBlocking(accountId, blocked).pipe(
            unwrapOwned(),
            map(() => void 0),
          ),
        ),
      );
      this.writes = run.then(
        () => undefined,
        () => undefined,
      );
      return from(run);
    });
  }
}
