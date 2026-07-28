import { Injectable, Signal, inject, signal } from '@angular/core';
import { UserEvent, type User } from 'matrix-js-sdk';
import { Observable, defer, from, tap, throwError } from 'rxjs';
import { type PresenceState, toPresenceState } from '@trinity/util-matrix';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access-matrix-client';

/**
 * Projects other users' Matrix presence (`m.presence`) into read-only Angular signals.
 * {@link presenceFor} returns a per-user signal that starts at the user's current known
 * presence (`offline` if we've never seen one) and updates live as `User.presence` events
 * arrive. The signal is memoized per user id, so many rows watching the same user share one.
 *
 * Wired like the other read models: {@link connect} attaches a single client-level listener
 * (matrix-js-sdk re-emits `User.presence` for every user) and re-binds onto a fresh client
 * after a re-login. Components never touch matrix-js-sdk directly.
 */
@Injectable({ providedIn: 'root' })
export class PresenceService {
  private readonly matrix = inject(MatrixClientService);

  /** One writable signal per tracked user id, updated in place as presence changes. */
  private readonly states = new Map<
    string,
    ReturnType<typeof signal<PresenceState>>
  >();

  // The signed-in user's own presence + status message, as last set from this client.
  // Seeded by loadOwnPresence(); the presence-settings control reads and writes these.
  private readonly _myPresence = signal<PresenceState>('online');
  readonly myPresence = this._myPresence.asReadonly();
  private readonly _myStatusMessage = signal('');
  readonly myStatusMessage = this._myStatusMessage.asReadonly();

  /** Handles a client `User.presence` event by writing the per-user signal, which schedules change detection. */
  private readonly onPresence = (_event: unknown, user: User): void => {
    const state = this.states.get(user.userId);
    if (!state) {
      return;
    }
    // The signed-in user is always shown online (see currentPresence); never let a self
    // presence event the server might send flip us offline.
    const next =
      user.userId === this.projection.client()?.getUserId()
        ? 'online'
        : toPresenceState(user.presence);
    // Only write (→ a change-detection pass) on an actual coarse-state change: the client
    // re-emits presence for every co-member on each sync, and most are no-op transitions
    // (e.g. still-offline) that would otherwise tick CD for nothing.
    if (next !== state()) {
      state.set(next);
    }
  };

  /**
   * Reactive presence for a user; `offline` until a presence update is seen. Safe to call
   * from a template — the returned signal is cached per user id and reused on later calls.
   */
  presenceFor(userId: string): Signal<PresenceState> {
    let state = this.states.get(userId);
    if (!state) {
      state = signal<PresenceState>(this.currentPresence(userId));
      this.states.set(userId, state);
    }
    return state.asReadonly();
  }

  /**
   * The projection. `onPresence` is bound by hand because it reads the event's `user`
   * argument, and there is nothing to coalesce: the handler is a targeted O(1) write to
   * one user's signal, not a rebuild of a read model.
   */
  private readonly projection = projectFromClient({
    matrix: this.matrix,
    bind: (client) => client.on(UserEvent.Presence, this.onPresence),
    unbind: (client) => client.off(UserEvent.Presence, this.onPresence),
    // Re-seed any already-tracked users from this client (a re-login brings a fresh
    // client whose users may differ), so stale signals don't linger at the old value.
    rebuild: () => {
      for (const [userId, state] of this.states) {
        state.set(this.currentPresence(userId));
      }
    },
  });

  /**
   * Track presence changes for users this session displays; pair with {@link disconnect}.
   * Idempotent per client; re-running after a re-login rewires onto the new one.
   */
  connect(): void {
    this.projection.connect();
  }

  /** Detach the presence listener from the current client. */
  disconnect(): void {
    this.projection.disconnect();
  }

  /**
   * Seed {@link myPresence} / {@link myStatusMessage} from the signed-in user's current
   * server state, for the presence-settings control to edit. A homeserver usually does
   * not echo your own presence, so an unknown state defaults to `online`.
   */
  loadOwnPresence(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    const user = client.getUser(client.getUserId() ?? '');
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
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.matrix.instance.setPresence({
          presence,
          status_msg: trimmed || undefined,
        }),
      ).pipe(
        tap(() => {
          this._myPresence.set(presence);
          this._myStatusMessage.set(trimmed);
        }),
      );
    });
  }

  /**
   * This client's current presence for a user, or `offline` when unknown. The signed-in
   * user always reads `online`: a homeserver typically doesn't send you your own presence,
   * so `getUser(self)` would report `offline` even though our client is live and syncing.
   */
  private currentPresence(userId: string): PresenceState {
    if (!this.matrix.isInitialized) {
      return 'offline';
    }
    const client = this.matrix.instance;
    if (userId === client.getUserId()) {
      return 'online';
    }
    return toPresenceState(client.getUser(userId)?.presence);
  }
}
