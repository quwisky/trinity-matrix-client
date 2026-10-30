import {
  DestroyRef,
  Injectable,
  type Signal,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { Subscription } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { plainEqual } from '@trinity/util/matrix';
import type { UserProfile } from './identity-engine';
import { IDENTITY_ENGINE } from './identity-engine.token';

/** One signed-in account's own profile, as that account's client currently knows it. */
export interface AccountIdentity {
  readonly userId: string;
  /** Display name, falling back to the user id when the server has none yet. */
  readonly displayName: string;
  /** Raw `mxc://` avatar, or null when unset; the UI resolves it (authed). */
  readonly avatarMxc: string | null;
}

interface LiveAccount {
  readonly accountId: string;
  readonly generation: number;
}

/**
 * Projects every signed-in account's own profile (display name and avatar) into one signal,
 * each read through that account's own engine subscription, so a background account's
 * profile hydrating is heard without the active one changing.
 */
@Injectable({ providedIn: 'root' })
export class AccountIdentitiesService {
  private readonly engine = inject(IDENTITY_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly profiles = signal<ReadonlyMap<string, UserProfile>>(
    new Map(),
  );
  private readonly subscriptions = new Map<
    string,
    { readonly generation: number; readonly subscription: Subscription }
  >();

  /** Every signed-in account's profile, keyed by user id. */
  readonly identities: Signal<ReadonlyMap<string, AccountIdentity>> = computed(
    () => {
      const profiles = this.profiles();
      return new Map(
        this.session
          .accountIds()
          .map((userId) => [
            userId,
            identityFrom(userId, profiles.get(userId)),
          ]),
      );
    },
    { equal: sameIdentities },
  );

  constructor() {
    // Keyed on the generation too: re-adding a signed-in account keeps its id but starts a
    // new client, and a subscription held on the old one would freeze that account.
    const live = computed<readonly LiveAccount[]>(
      () =>
        this.session.snapshot().accounts.map(({ accountId, generation }) => ({
          accountId,
          generation,
        })),
      { equal: plainEqual },
    );
    effect(() => {
      const accounts = live();
      untracked(() => this.reconcile(accounts));
    });
    inject(DestroyRef).onDestroy(() => {
      for (const { subscription } of this.subscriptions.values()) {
        subscription.unsubscribe();
      }
    });
  }

  /** This account's profile, falling back to the bare user id before one is known. */
  identityOf(userId: string): AccountIdentity {
    return this.identities().get(userId) ?? bareIdentity(userId);
  }

  private reconcile(accounts: readonly LiveAccount[]): void {
    const wanted = new Map(
      accounts.map(({ accountId, generation }) => [accountId, generation]),
    );
    for (const [accountId, held] of this.subscriptions) {
      if (wanted.get(accountId) === held.generation) continue;
      held.subscription.unsubscribe();
      this.subscriptions.delete(accountId);
      this.profiles.update((current) => {
        const next = new Map(current);
        next.delete(accountId);
        return next;
      });
    }
    for (const [accountId, generation] of wanted) {
      if (this.subscriptions.has(accountId)) continue;
      const subscription = this.engine
        .ownProfile(accountId)
        .subscribe((profile) =>
          this.profiles.update((current) =>
            new Map(current).set(accountId, profile),
          ),
        );
      this.subscriptions.set(accountId, { generation, subscription });
    }
  }
}

function identityFrom(
  userId: string,
  profile: UserProfile | undefined,
): AccountIdentity {
  return {
    userId,
    // `||`: a server hands back '' for a user without a display name.
    displayName: profile?.displayName || userId,
    avatarMxc: profile?.avatarMxc ?? null,
  };
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
