import { Injectable, NgZone, Signal, inject, signal } from '@angular/core';
import { MatrixClient, UserEvent, type User } from 'matrix-js-sdk';
import { type PresenceState, toPresenceState } from '@trinity/util-matrix';
import {
  MatrixClientService,
  reprojectOnAccountSwitch,
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
  private readonly zone = inject(NgZone);

  /** The client we currently have the presence listener on (null when detached). */
  private connectedClient: MatrixClient | null = null;

  /** One writable signal per tracked user id, updated in place as presence changes. */
  private readonly states = new Map<
    string,
    ReturnType<typeof signal<PresenceState>>
  >();

  /** Matrix events fire outside Angular's zone; re-enter so the signal write renders. */
  private readonly onPresence = (_event: unknown, user: User): void => {
    const state = this.states.get(user.userId);
    if (!state) {
      return;
    }
    // The signed-in user is always shown online (see currentPresence); never let a self
    // presence event the server might send flip us offline.
    const next =
      user.userId === this.connectedClient?.getUserId()
        ? 'online'
        : toPresenceState(user.presence);
    // Only re-enter the zone (→ a change-detection pass) on an actual coarse-state
    // change: the client re-emits presence for every co-member on each sync, and most
    // are no-op transitions (e.g. still-offline) that would otherwise tick CD for nothing.
    if (next !== state()) {
      this.zone.run(() => state.set(next));
    }
  };

  constructor() {
    // On an account switch, re-bind onto the newly-active account's client — but only
    // while already connected (a viewing surface is displaying presence).
    reprojectOnAccountSwitch(
      this.matrix,
      () => this.connectedClient !== null,
      () => this.connect(),
    );
  }

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
   * Attach the presence listener and re-seed tracked users from the current client.
   * Idempotent per client; re-running after a re-login rewires onto the new one.
   */
  connect(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    if (this.connectedClient === client) {
      return;
    }
    this.disconnect();
    this.connectedClient = client;
    client.on(UserEvent.Presence, this.onPresence);
    // Re-seed any already-tracked users from this client (a re-login brings a fresh
    // client whose users may differ), so stale signals don't linger at the old value.
    for (const [userId, state] of this.states) {
      state.set(this.currentPresence(userId));
    }
  }

  /** Detach the presence listener from the current client. */
  disconnect(): void {
    this.connectedClient?.off(UserEvent.Presence, this.onPresence);
    this.connectedClient = null;
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
