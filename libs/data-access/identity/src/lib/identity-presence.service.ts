import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import {
  EMPTY,
  Observable,
  Subscription,
  catchError,
  defer,
  from,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { PreferenceStoreService } from '@trinity/runtime/preferences';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { type PresenceState, toPresenceState } from '@trinity/util/matrix';
import {
  IDENTITY_MATRIX_EVENTS,
  IdentityMatrixPort,
  type IdentityMatrixClient,
  type IdentitySdkUser,
} from '@trinity/data-access/matrix-client';
import {
  identityNotReady,
  recoverIdentityOperation,
} from './identity-operation-error';
import {
  OWN_PRESENCE_PREFERENCE,
  type SavedOwnPresence,
} from './own-presence.preference';

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

/**
 * The status message in the user's last presence event. Not `presenceStatusMsg`: the SDK only
 * overwrites that when an event carries a message, so a cleared one would linger.
 */
function reportedStatusMessage(user: IdentitySdkUser): string {
  const message = user.events?.presence?.getContent().status_msg;
  return typeof message === 'string' ? message : '';
}

/** Projects authoritative Matrix presence; unavailable or unseen status remains unknown. */
@Injectable({ providedIn: 'root' })
export class IdentityPresenceService {
  private readonly matrix = inject(IdentityMatrixPort);
  private readonly runtime = inject(ProjectionRuntime);
  private readonly preferences = inject(PreferenceStoreService);
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

  /**
   * Bumps whenever any user's presence may have changed. Read it beside
   * {@link peekDetails} to follow a whole roster without a signal per user.
   */
  private readonly _revision = signal(0);
  readonly revision = this._revision.asReadonly();

  // The signed-in user's own presence and status message: what they set here, else what the
  // server last reported, else online. Every read of the signed-in user's presence uses it.
  private readonly _myPresence = signal<PresenceState>('online');
  readonly myPresence = this._myPresence.asReadonly();
  private readonly _myStatusMessage = signal('');
  readonly myStatusMessage = this._myStatusMessage.asReadonly();
  /** When this client last wrote its own presence; older server reports don't undo it. */
  private ownWrittenAt = 0;
  private readonly restoredClients = new WeakSet<IdentityMatrixClient>();
  private restore = Subscription.EMPTY;

  /**
   * Reactive presence for a user; unknown while the projection is unavailable. Safe to call
   * from a template — the returned signal is cached per user id and reused on later calls.
   */
  presenceFor(userId: string): Signal<PresenceState | null> {
    let view = this.views.get(userId);
    if (!view) {
      const state = signal<PresenceState | null>(null);
      this.states.set(userId, state);
      view = computed(() => {
        if (!this.available()) return null;
        return userId === this.matrix.activeAccountId()
          ? this._myPresence()
          : state();
      });
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
      view = computed(() => {
        if (!this.available()) return null;
        const current = details();
        return current && userId === this.matrix.activeAccountId()
          ? {
              ...current,
              state: this._myPresence(),
              statusMessage: this._myStatusMessage(),
            }
          : current;
      });
      this.detailViews.set(userId, view);
      if (this.available()) queueMicrotask(() => this.projection.schedule());
    }
    return view;
  }

  /**
   * A user's presence right now, or null while it is unknown (presence off, or nothing
   * reported for them yet). Caches nothing, so a 5,000-member roster leaves no per-user
   * state behind; read {@link revision} in the same reactive context to recompute it.
   */
  peekDetails(userId: string): PresenceDetails | null {
    if (!this.available() || !this.matrix.isAvailable()) return null;
    return this.currentDetails(userId, this.matrix.active().client);
  }

  /** Coalesce SDK invalidations so read failures are observed by Projection Runtime. */
  private readonly projection = this.matrix.project({
    id: 'identity.presence',
    events: [IDENTITY_MATRIX_EVENTS.presence],
    bind: (client) => this.restoreOwnPresence(client),
    // Re-seed tracked users: a re-login brings a fresh client whose users may differ.
    rebuild: (client) => {
      this.seedOwnPresence(client);
      for (const [userId, state] of this.states) {
        state.set(this.currentPresence(userId, client));
      }
      for (const [userId, details] of this.details) {
        const next = this.currentDetails(userId, client);
        // Keep the existing object when nothing changed so unrelated events don't re-render consumers.
        if (!samePresenceDetails(details(), next)) details.set(next);
      }
      this._revision.update((n) => n + 1);
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
      this.ownWrittenAt = 0;
      this._revision.update((n) => n + 1);
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
   * not echo your own presence; without a server report the current value stays.
   */
  loadOwnPresence(): void {
    if (this.matrix.isAvailable()) {
      this.seedOwnPresence(this.matrix.active().client);
    }
  }

  /**
   * Publish the signed-in user's presence and optional status message. Cold — fires on
   * subscribe (see the actions pattern) — and updates {@link myPresence} /
   * {@link myStatusMessage} on success. Homeservers may disable or rate-limit presence,
   * in which case the call rejects and the caller surfaces it.
   */
  setOwnPresence(presence: PresenceState, statusMsg: string): Observable<void> {
    return defer(() => {
      // The user's choice wins: a restore still in flight must not send the old status after it.
      this.restore.unsubscribe();
      if (this.matrix.isAvailable()) {
        this.restoredClients.add(this.matrix.active().client);
      }
      return this.publishOwnPresence(presence, statusMsg, false);
    });
  }

  private publishOwnPresence(
    presence: PresenceState,
    statusMsg: string,
    restoring: boolean,
  ): Observable<void> {
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
        // Per the spec, a sync that omits set_presence marks the user online, undoing the choice.
        switchMap(() =>
          client.setSyncPresence(
            presence as Parameters<IdentityMatrixClient['setSyncPresence']>[0],
          ),
        ),
        tap(() => {
          // The command may finish after an Account switch: its remote write belongs to the
          // captured Account but must not publish into the new Active Account's state.
          if (this.matrix.activeAccountId() === accountId) {
            this._myPresence.set(presence);
            this._myStatusMessage.set(trimmed);
            this.ownWrittenAt = Date.now();
          }
          if (!restoring) this.saveOwnPresence(accountId, presence, trimmed);
        }),
      );
    }).pipe(recoverIdentityOperation('set-presence'));
  }

  /**
   * Re-send the presence this Account last chose on this device: every new session starts
   * online on the server otherwise. Best effort, and a choice made meanwhile wins.
   */
  private restoreOwnPresence(client: IdentityMatrixClient): void {
    const accountId = client.getUserId();
    // Once per client: switching back to an Account must not undo a status set elsewhere since.
    // A restore cut short by a switch is not done, so it runs again on the way back.
    if (!accountId || this.restoredClients.has(client)) return;
    this.restore.unsubscribe();
    this.restore = this.preferences
      .readSaved(OWN_PRESENCE_PREFERENCE, { kind: 'account', accountId })
      .pipe(
        switchMap((saved) =>
          saved &&
          this.ownWrittenAt === 0 &&
          this.matrix.activeAccountId() === accountId
            ? this.publishOwnPresence(saved.presence, saved.statusMessage, true)
            : EMPTY,
        ),
        catchError(() => EMPTY),
      )
      .subscribe({ complete: () => this.restoredClients.add(client) });
  }

  private saveOwnPresence(
    accountId: string,
    presence: PresenceState,
    statusMessage: string,
  ): void {
    const saved: SavedOwnPresence =
      presence === 'online' && !statusMessage
        ? null
        : { presence, statusMessage };
    // Best effort: a failed write only means the next session starts online.
    this.preferences
      .setPreference(
        OWN_PRESENCE_PREFERENCE,
        { kind: 'account', accountId },
        saved,
      )
      .pipe(catchError(() => of(undefined)))
      .subscribe();
  }

  /**
   * Adopt the signed-in user's presence when the server has reported it. The SDK seeds
   * every user as offline with `lastPresenceTs` 0, which is not a report, and a report
   * older than this client's own write is stale.
   */
  private seedOwnPresence(client: IdentityMatrixClient): void {
    const user = client.getUser(client.getUserId() ?? '');
    if (!user?.lastPresenceTs || user.lastPresenceTs <= this.ownWrittenAt) {
      return;
    }
    this._myPresence.set(toPresenceState(user.presence ?? 'online'));
    this._myStatusMessage.set(reportedStatusMessage(user));
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
      statusMessage:
        userId === client.getUserId()
          ? this._myStatusMessage()
          : user
            ? reportedStatusMessage(user)
            : '',
      // Same anchor as the SDK's getLastActiveTs().
      lastActiveAt:
        user?.lastPresenceTs && user.lastActiveAgo != null
          ? user.lastPresenceTs - user.lastActiveAgo
          : null,
      currentlyActive: user?.currentlyActive ?? false,
    };
  }

  /**
   * This client's current presence for a user, or null when unknown. The signed-in user
   * reads {@link myPresence}: a homeserver often doesn't send you your own presence, so
   * `getUser(self)` would report the SDK's placeholder `offline` while the client is live.
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
      return this._myPresence();
    }
    const presence = client.getUser(userId)?.presence;
    return presence ? toPresenceState(presence) : null;
  }
}
