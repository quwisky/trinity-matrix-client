import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { Observable, Subscription, defer, from, tap } from 'rxjs';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { type PresenceState, toPresenceState } from '@trinity/util/matrix';
import {
  IDENTITY_MATRIX_EVENTS,
  IdentityMatrixPort,
  type IdentityMatrixClient,
} from '@trinity/data-access/matrix-client';
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
  private readonly matrix = inject(IdentityMatrixPort);
  private readonly runtime = inject(ProjectionRuntime);
  private readonly available = signal(false);
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

  /** Coalesce SDK invalidations so read failures are observed by Projection Runtime. */
  private readonly projection = this.matrix.project({
    id: 'identity.presence',
    events: [IDENTITY_MATRIX_EVENTS.presence],
    // Re-seed tracked users: a re-login brings a fresh client whose users may differ.
    rebuild: (client) => {
      for (const [userId, state] of this.states) {
        state.set(this.currentPresence(userId, client));
      }
      for (const [userId, details] of this.details) {
        const next = this.currentDetails(userId, client);
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
   * server state, for the presence-settings control to edit. A homeserver usually does
   * not echo your own presence, so an unknown state defaults to `online`.
   */
  loadOwnPresence(): void {
    if (!this.matrix.isAvailable()) {
      return;
    }
    const { accountId, client } = this.matrix.active();
    const user = client.getUser(accountId);
    this._myPresence.set(
      user?.presence ? toPresenceState(user.presence) : 'online',
    );
    this._myStatusMessage.set(user?.presenceStatusMsg ?? '');
  }

  /**
   * Publish the signed-in user's presence and optional status message. Cold — fires on
   * subscribe (see the actions pattern) — and updates {@link myPresence} /
   * {@link myStatusMessage} on success. Homeservers may disable or rate-limit presence,
   * in which case the call rejects and the caller surfaces it.
   */
  setOwnPresence(presence: PresenceState, statusMsg: string): Observable<void> {
    const trimmed = statusMsg.trim();
    return defer(() => {
      if (!this.matrix.isAvailable()) {
        throw identityNotReady('set-presence');
      }
      const { accountId, client } = this.matrix.active();
      return from(
        client.setPresence({
          presence,
          status_msg: trimmed || undefined,
        }),
      ).pipe(
        tap(() => {
          // The command may finish after an Account switch: its remote write belongs to the
          // captured Account but must not publish into the new Active Account's state.
          if (this.matrix.activeAccountId() === accountId) {
            this._myPresence.set(presence);
            this._myStatusMessage.set(trimmed);
          }
        }),
      );
    }).pipe(recoverIdentityOperation('set-presence'));
  }

  private currentDetails(
    userId: string,
    client: IdentityMatrixClient,
  ): PresenceDetails | null {
    const state = this.currentPresence(userId, client);
    const user = client.getUser(userId);
    // The SDK seeds every loaded member as offline with lastPresenceTs 0 and sets it only
    // when a presence event arrives; self stays known as online without one.
    const known = !!user?.lastPresenceTs || userId === client.getUserId();
    if (!state || !known) return null;
    return {
      state,
      statusMessage: user?.presenceStatusMsg ?? '',
      // Same anchor as the SDK's getLastActiveTs().
      lastActiveAt:
        user?.lastPresenceTs && user.lastActiveAgo != null
          ? user.lastPresenceTs - user.lastActiveAgo
          : null,
      currentlyActive: user?.currentlyActive ?? false,
    };
  }

  /**
   * This client's current presence for a user, or null when unknown. The signed-in
   * user always reads `online`: a homeserver typically doesn't send you your own presence,
   * so `getUser(self)` would report `offline` even though our client is live and syncing.
   */
  private currentPresence(
    userId: string,
    projectedClient?: IdentityMatrixClient,
  ): PresenceState | null {
    if (!projectedClient && !this.matrix.isAvailable()) {
      return null;
    }
    const client = projectedClient ?? this.matrix.active().client;
    if (userId === client.getUserId()) {
      return 'online';
    }
    const presence = client.getUser(userId)?.presence;
    return presence ? toPresenceState(presence) : null;
  }
}
