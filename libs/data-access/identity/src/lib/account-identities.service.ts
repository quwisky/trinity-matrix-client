import { Injectable, effect, inject, signal } from '@angular/core';
import {
  coalesce,
  IDENTITY_MATRIX_EVENTS,
  IdentityMatrixPort,
  type IdentityMatrixClient,
  type IdentitySdkUser,
} from '@trinity/data-access/matrix-client';

/** One signed-in account's own profile, as that account's client currently knows it. */
export interface AccountIdentity {
  readonly userId: string;
  /** Display name, falling back to the user id when the server has none yet. */
  readonly displayName: string;
  /** Raw `mxc://` avatar, or null when unset; the UI resolves it (authed). */
  readonly avatarMxc: string | null;
}

/** The listener attached to one account's client, kept so it can be detached. */
interface AccountListener {
  readonly client: IdentityMatrixClient;
  readonly onUser: (event: unknown, user: IdentitySdkUser) => void;
  readonly onSync: () => void;
}

/**
 * Projects **every signed-in account's own profile** — display name and avatar — into one
 * signal, each read through that account's own client.
 *
 * Replaces a `RoomLibraryService.revision`/`profileRevision` bump counter that stood for "some
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
 * **Why it listens to `ClientEvent.Sync` and not only to `UserEvent.*`**, which is the trap
 * here: the client re-emits `User.displayName`/`User.avatarUrl` only for `User` objects
 * built by `User.createUser`, and an account's OWN user is not one of them.
 * `startClient()` seeds it as `store.storeUser(new User(userId))` — the plain constructor,
 * no re-emitter — precisely so it exists before the first sync
 * (`matrix-js-sdk/src/client.ts`, "Create our own user object artificially"). Nothing
 * later replaces it, and `client.setDisplayName` emits on that same object, so a listener
 * for the account's own profile would never fire once. `IdentityPresenceService` is not a
 * counter-example: it consumes the re-emission for OTHER users and hardcodes self to
 * `online`.
 *
 * So the sync tick is the real trigger, and the `UserEvent` listeners are the fast path for
 * the case they do cover. `equal: sameProfiles` makes the ticks that changed nothing free.
 */
@Injectable({ providedIn: 'root' })
export class AccountIdentitiesService {
  private readonly matrix = inject(IdentityMatrixPort);

  private readonly _identities = signal<ReadonlyMap<string, AccountIdentity>>(
    new Map(),
    { equal: sameIdentities },
  );
  /** Every signed-in account's profile, keyed by user id. */
  readonly identities = this._identities.asReadonly();

  private readonly listeners = new Map<string, AccountListener>();

  constructor() {
    // Accounts come and go, and a switch can hand the same user id a NEW client object.
    // Both are read here so the effect re-runs on either.
    effect(() => {
      this.matrix.accountIds();
      this.matrix.activeAccountId();
      this.syncListeners();
      this.refresh();
    });
  }

  /** This account's profile, falling back to the bare user id before one is known. */
  identityOf(userId: string): AccountIdentity {
    return this._identities().get(userId) ?? bareIdentity(userId);
  }

  /**
   * A burst of profile events — several accounts hydrating at once on startup — collapses
   * into one rebuild. The rebuild is O(accounts), which is small, but it writes a signal
   * several surfaces derive from.
   */
  private readonly flusher = coalesce(() => this.refresh());

  private refresh(): void {
    const next = new Map<string, AccountIdentity>();
    for (const userId of this.matrix.accountIds()) {
      const user = this.matrix.forAccount(userId)?.getUser(userId);
      next.set(userId, {
        userId,
        displayName: user?.displayName || userId,
        avatarMxc: user?.avatarUrl ?? null,
      });
    }
    this._identities.set(next);
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
      const client = this.matrix.forAccount(userId);
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
      // knows about, which in a busy session is everyone in every room. See the class doc
      // for why this listener alone is NOT enough for the own user.
      const onUser = (_event: unknown, user: IdentitySdkUser): void => {
        if (user.userId === userId) {
          this.flusher.schedule();
        }
      };
      // The trigger that actually fires for the account's own profile. Per account, so a
      // background account hydrating is heard without the active one having to sync.
      const onSync = (): void => this.flusher.schedule();
      client.on(IDENTITY_MATRIX_EVENTS.displayName, onUser);
      client.on(IDENTITY_MATRIX_EVENTS.avatarUrl, onUser);
      client.on(IDENTITY_MATRIX_EVENTS.sync, onSync);
      this.listeners.set(userId, { client, onUser, onSync });
    }
  }

  private detach({ client, onUser, onSync }: AccountListener): void {
    client.off(IDENTITY_MATRIX_EVENTS.displayName, onUser);
    client.off(IDENTITY_MATRIX_EVENTS.avatarUrl, onUser);
    client.off(IDENTITY_MATRIX_EVENTS.sync, onSync);
  }
}

/** The stand-in for an account whose profile the server has not given us yet. */
function bareIdentity(userId: string): AccountIdentity {
  return { userId, displayName: userId, avatarMxc: null };
}

/**
 * Whether two profile maps say the same thing, so a coalesced rebuild that changed nothing
 * does not tick the header chip, the account switcher and every mixed-account badge.
 */
function sameIdentities(
  a: ReadonlyMap<string, AccountIdentity>,
  b: ReadonlyMap<string, AccountIdentity>,
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
