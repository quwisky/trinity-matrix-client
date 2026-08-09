import { Injectable, effect, inject, signal } from '@angular/core';
import { UserEvent, type MatrixClient, type User } from 'matrix-js-sdk';
import {
  coalesce,
  MatrixClientService,
} from '@trinity/data-access/matrix-client';

/** One signed-in account's own profile, as that account's client currently knows it. */
export interface AccountProfile {
  userId: string;
  /** Display name, falling back to the user id when the server has none yet. */
  displayName: string;
  /** Raw `mxc://` avatar, or null when unset; the UI resolves it (authed). */
  avatarMxc: string | null;
}

/** The listener attached to one account's client, kept so it can be detached. */
interface AccountListener {
  readonly client: MatrixClient;
  readonly handler: (event: unknown, user: User) => void;
}

/**
 * Projects **every signed-in account's own profile** — display name and avatar — into one
 * signal, each read through that account's own client.
 *
 * Replaces a `RoomsService.revision`/`profileRevision` bump counter that stood for "some
 * profile somewhere may have changed". Two things made it the wrong shape:
 *
 * - It was bumped only by the ACTIVE client's rebuild, while two of its consumers resolve
 *   profiles from OTHER accounts' clients. A mixed-in account whose profile hydrated later
 *   kept a stale badge — its mxid and a hashed letter instead of its name and picture —
 *   until the active account happened to sync. `AccountBadgesService` documented that gap
 *   and papered over it by also reading the unread aggregator, which is fed by every
 *   client. That workaround is what this removes.
 * - It carried no value, so nothing could tell whether a profile had actually changed.
 *
 * Listener set rather than {@link projectFromClient}: this is keyed on the ACCOUNT SET, not
 * on one active client, so it takes the batching primitive alone and reconciles its own
 * listeners — the same shape `MixedRoomsService` and `UnreadAggregatorService` use,
 * including the identity re-check that catches a new client object for the same user id.
 *
 * `User.displayName`/`User.avatarUrl` are re-emitted at the client
 * (`matrix-js-sdk/src/models/user.ts` registers them with the client's re-emitter), which
 * is what makes a single per-client listener enough. The same mechanism `PresenceService`
 * relies on.
 */
@Injectable({ providedIn: 'root' })
export class AccountProfilesService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _profiles = signal<ReadonlyMap<string, AccountProfile>>(
    new Map(),
    { equal: sameProfiles },
  );
  /** Every signed-in account's profile, keyed by user id. */
  readonly profiles = this._profiles.asReadonly();

  private readonly listeners = new Map<string, AccountListener>();

  constructor() {
    // Accounts come and go, and a switch can hand the same user id a NEW client object.
    // Both are read here so the effect re-runs on either.
    effect(() => {
      this.matrix.accountIds();
      this.matrix.activeUserId();
      this.syncListeners();
      this.refresh();
    });
  }

  /** This account's profile, falling back to the bare user id before one is known. */
  profileOf(userId: string): AccountProfile {
    return this._profiles().get(userId) ?? bareProfile(userId);
  }

  /**
   * A burst of profile events — several accounts hydrating at once on startup — collapses
   * into one rebuild. The rebuild is O(accounts), which is small, but it writes a signal
   * several surfaces derive from.
   */
  private readonly flusher = coalesce(() => this.refresh());

  private refresh(): void {
    const next = new Map<string, AccountProfile>();
    for (const userId of this.matrix.accountIds()) {
      const user = this.matrix.clientFor(userId)?.getUser(userId);
      next.set(userId, {
        userId,
        displayName: user?.displayName || userId,
        avatarMxc: user?.avatarUrl ?? null,
      });
    }
    this._profiles.set(next);
  }

  /** Reconcile the per-account listener set against who is signed in. */
  private syncListeners(): void {
    const wanted = new Set(this.matrix.accountIds());

    for (const [userId, held] of this.listeners) {
      if (!wanted.has(userId)) {
        this.detach(held);
        this.listeners.delete(userId);
      }
    }

    for (const userId of wanted) {
      const client = this.matrix.clientFor(userId);
      const held = this.listeners.get(userId);
      if (held) {
        // The same user id can get a NEW client object — re-adding an already signed-in
        // account stops and re-creates it. Holding the old one strands the listener on a
        // stopped client, and that account's profile silently stops updating.
        if (held.client === client) {
          continue;
        }
        this.detach(held);
        this.listeners.delete(userId);
      }
      if (!client) {
        continue; // not fully started yet; a later account change re-checks it
      }
      // Filtered to the account's OWN user: the client re-emits these for every user it
      // knows about, which in a busy session is everyone in every room.
      const handler = (_event: unknown, user: User): void => {
        if (user.userId === userId) {
          this.flusher.schedule();
        }
      };
      client.on(UserEvent.DisplayName, handler);
      client.on(UserEvent.AvatarUrl, handler);
      this.listeners.set(userId, { client, handler });
    }
  }

  private detach({ client, handler }: AccountListener): void {
    client.off(UserEvent.DisplayName, handler);
    client.off(UserEvent.AvatarUrl, handler);
  }
}

/** The stand-in for an account whose profile the server has not given us yet. */
function bareProfile(userId: string): AccountProfile {
  return { userId, displayName: userId, avatarMxc: null };
}

/**
 * Whether two profile maps say the same thing, so a coalesced rebuild that changed nothing
 * does not tick the header chip, the account switcher and every mixed-account badge.
 */
function sameProfiles(
  a: ReadonlyMap<string, AccountProfile>,
  b: ReadonlyMap<string, AccountProfile>,
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [userId, profile] of a) {
    const other = b.get(userId);
    if (
      !other ||
      other.displayName !== profile.displayName ||
      other.avatarMxc !== profile.avatarMxc
    ) {
      return false;
    }
  }
  return true;
}
