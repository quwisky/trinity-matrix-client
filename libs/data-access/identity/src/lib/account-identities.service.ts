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
 * Projects every signed-in account's own profile (display name and avatar) into one signal,
 * each read through that account's own client.
 *
 * Keyed on the account set, not one active client, so it reconciles its own listeners.
 *
 * Listens to `ClientEvent.Sync` as well as `UserEvent.*`: the client re-emits
 * `User.displayName`/`User.avatarUrl` only for users built by `User.createUser`, and an
 * account's OWN user is not one of them (`startClient()` seeds it with the plain `new User`
 * constructor, so no re-emitter). Without the sync tick the own profile would never update.
 * `IdentityPresenceService` consumes the re-emission for OTHER users and hardcodes self to
 * `online`. `equal: sameProfiles` makes ticks that changed nothing free.
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
    // Accounts come and go, and a switch can hand the same user id a NEW client object;
    // read both so the effect re-runs on either.
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

  /** Collapses a burst of profile events (accounts hydrating at startup) into one rebuild. */
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
        // The same user id can get a NEW client object (re-adding a signed-in account);
        // holding the old one strands the listener on a stopped client.
        if (held.client === client) {
          continue;
        }
        this.detach(held);
        this.listeners.delete(userId);
      }
      if (!client) {
        continue; // not fully started yet; a later account change re-checks it
      }
      // Filtered to the account's OWN user: the client re-emits these for every known user.
      // Not enough alone for the own user; see the class doc.
      const onUser = (_event: unknown, user: IdentitySdkUser): void => {
        if (user.userId === userId) {
          this.flusher.schedule();
        }
      };
      // The trigger that fires for the account's own profile. Per account, so a background
      // account hydrating is heard without the active one syncing.
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

/** Whether two profile maps are equal, so a no-op rebuild does not tick every consumer. */
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
