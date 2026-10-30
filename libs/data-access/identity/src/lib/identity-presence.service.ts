import {
  Injectable,
  Signal,
  computed,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { EMPTY, Observable, Subscription, defer, map, tap } from 'rxjs';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { type PresenceState, unwrapEngineResult } from '@trinity/util/matrix';
import {
  projectActiveAccount,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import type { PresenceInfo } from './identity-engine';
import { IDENTITY_ENGINE } from './identity-engine.token';
import {
  identityNotReady,
  recoverIdentityOperation,
} from './identity-operation-error';

export interface PresenceDetails {
  readonly state: PresenceState;
  readonly statusMessage: string;
  /** Epoch ms of the user's last activity, or null when the server did not say. */
  readonly lastActiveAt: number | null;
  readonly currentlyActive: boolean;
}

function samePresenceDetails(
  a: PresenceDetails | null,
  b: PresenceDetails | null,
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.state === b.state &&
      a.statusMessage === b.statusMessage &&
      a.lastActiveAt === b.lastActiveAt &&
      a.currentlyActive === b.currentlyActive)
  );
}

/** Projects authoritative Matrix presence; unavailable or unseen status remains unknown. */
@Injectable({ providedIn: 'root' })
export class IdentityPresenceService {
  private readonly engine = inject(IDENTITY_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly runtime = inject(ProjectionRuntime);
  private readonly available = signal(false);
  /** Whether presence is known at all; false while it is loading or the server has it off. */
  readonly presenceAvailable = this.available.asReadonly();
  private readonly views = new Map<string, Signal<PresenceState | null>>();

  /** One writable signal per tracked user id, updated in place as presence changes. */
  private readonly states = new Map<
    string,
    ReturnType<typeof signal<PresenceState | null>>
  >();

  private readonly detailViews = new Map<
    string,
    Signal<PresenceDetails | null>
  >();
  private readonly details = new Map<
    string,
    ReturnType<typeof signal<PresenceDetails | null>>
  >();

  // The signed-in user's own presence and status message, seeded by loadOwnPresence().
  private readonly _myPresence = signal<PresenceState>('online');
  readonly myPresence = this._myPresence.asReadonly();
  private readonly _myStatusMessage = signal('');
  readonly myStatusMessage = this._myStatusMessage.asReadonly();

  /**
   * Reactive presence for a user; unknown while the projection is unavailable. Safe to call
   * from a template — the returned signal is cached per user id and reused on later calls.
   */
  presenceFor(userId: string): Signal<PresenceState | null> {
    let view = this.views.get(userId);
    if (!view) {
      const state = signal<PresenceState | null>(null);
      this.states.set(userId, state);
      view = computed(() => (this.available() ? state() : null));
      this.views.set(userId, view);
      // Schedule outside the computed read context: invalidation publishes Projection Runtime signals.
      if (this.available()) queueMicrotask(() => this.projection.schedule());
    }
    return view;
  }

  /** Presence state, status message and last-active time for a user; null while unknown. */
  presenceDetailsFor(userId: string): Signal<PresenceDetails | null> {
    let view = this.detailViews.get(userId);
    if (!view) {
      const details = signal<PresenceDetails | null>(null);
      this.details.set(userId, details);
      view = computed(() => (this.available() ? details() : null));
      this.detailViews.set(userId, view);
      if (this.available()) queueMicrotask(() => this.projection.schedule());
    }
    return view;
  }

  private readonly projection = projectActiveAccount<readonly PresenceInfo[]>({
    id: 'identity.presence',
    subscribe: (accountId) => this.engine.presence(accountId),
    // Re-seed tracked users: another account or session has received other presence.
    rebuild: (snapshot, accountId) => {
      const received = new Map(snapshot.map((info) => [info.userId, info]));
      for (const [userId, state] of this.states) {
        state.set(this.currentPresence(userId, accountId, received));
      }
      for (const [userId, details] of this.details) {
        const next = this.currentDetails(userId, accountId, received);
        // Keep the existing object when nothing changed so unrelated events don't re-render consumers.
        if (!samePresenceDetails(details(), next)) details.set(next);
      }
    },
    reset: () => {
      for (const state of this.states.values()) {
        state.set(null);
      }
      for (const details of this.details.values()) {
        details.set(null);
      }
      this._myPresence.set('online');
      this._myStatusMessage.set('');
    },
  });

  /** Cold presence projection retained by the named session lifetime. */
  runProjection(): Observable<void> {
    return new Observable((subscriber) => {
      const ownership = new Subscription();
      ownership.add(this.projection.run().subscribe(subscriber));
      ownership.add(
        this.runtime
          .observe('identity.presence', { kind: 'active-account' })
          .subscribe((state) =>
            this.available.set(state.condition === 'available'),
          ),
      );
      return () => {
        ownership.unsubscribe();
        this.available.set(false);
      };
    });
  }

  /**
   * Seed {@link myPresence} / {@link myStatusMessage} from the signed-in user's current
   * server state, for the presence-settings control to edit. Cold; completes once they hold
   * it. A homeserver usually does not echo your own presence, so an unknown state defaults
   * to `online`.
   */
  loadOwnPresence(): Observable<void> {
    return defer(() => {
      const accountId = untracked(this.session.activeAccountId);
      if (!accountId) return EMPTY;
      return this.engine.ownPresence(accountId).pipe(
        map((result) => {
          if (
            result.ok &&
            untracked(this.session.activeAccountId) === accountId
          ) {
            this._myPresence.set(result.value.presence ?? 'online');
            this._myStatusMessage.set(result.value.statusMessage ?? '');
          }
        }),
      );
    });
  }

  /**
   * Publish the signed-in user's presence and optional status message. Cold — fires on
   * subscribe (see the actions pattern) — and updates {@link myPresence} /
   * {@link myStatusMessage} on success. Homeservers may disable or rate-limit presence,
   * in which case the call fails and the caller surfaces it.
   */
  setOwnPresence(presence: PresenceState, statusMsg: string): Observable<void> {
    const trimmed = statusMsg.trim();
    return defer(() => {
      const accountId = untracked(this.session.activeAccountId);
      if (!accountId) {
        throw identityNotReady('set-presence');
      }
      return this.engine.setPresence(accountId, presence, trimmed || null).pipe(
        unwrapEngineResult(),
        tap(() => {
          // The command may finish after an Account switch: its remote write belongs to the
          // captured Account but must not publish into the new Active Account's state.
          if (untracked(this.session.activeAccountId) === accountId) {
            this._myPresence.set(presence);
            this._myStatusMessage.set(trimmed);
          }
        }),
        map(() => void 0),
      );
    }).pipe(recoverIdentityOperation('set-presence'));
  }

  /**
   * A user's presence as the account received it, or null when it received none. The
   * signed-in user always reads `online`: a homeserver typically doesn't send you your own
   * presence, but our client is live and syncing.
   */
  private currentPresence(
    userId: string,
    accountId: string,
    received: ReadonlyMap<string, PresenceInfo>,
  ): PresenceState | null {
    return userId === accountId
      ? 'online'
      : (received.get(userId)?.presence ?? null);
  }

  private currentDetails(
    userId: string,
    accountId: string,
    received: ReadonlyMap<string, PresenceInfo>,
  ): PresenceDetails | null {
    const state = this.currentPresence(userId, accountId, received);
    if (!state) return null;
    const info = received.get(userId);
    return {
      state,
      statusMessage: info?.statusMessage ?? '',
      lastActiveAt: info?.lastActiveAt ?? null,
      currentlyActive: info?.currentlyActive ?? false,
    };
  }
}
