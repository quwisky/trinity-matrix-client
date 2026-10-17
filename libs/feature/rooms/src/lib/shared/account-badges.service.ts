import { Injectable, computed, inject } from '@angular/core';
import {
  AccountIdentitiesService,
  type AccountIdentity,
} from '@trinity/data-access/identity';
import { SelectedRoomLibraryService } from '@trinity/data-access/room-library';
import { type AccountBadge } from '@trinity/components/generic-content';
import { initialOf } from '@trinity/util/matrix';

/** Builds a badge for a user from their profile or id. */
function badgeOf(
  userId: string,
  profile: AccountIdentity | undefined,
): AccountBadge {
  const name = profile?.displayName || userId;
  return {
    id: userId,
    name,
    initial: initialOf(name),
    avatarMxc: profile?.avatarMxc ?? null,
  };
}

/**
 * Owning-account badges: account id to the avatar/initial/name drawn in the corner of a room row,
 * space pill, rail unread chat or switcher result. Shared so every surface badges rows identically.
 *
 * {@link badges} is empty unless more than one account is being mixed (with a single account every
 * row belongs to it). {@link everyAccount} covers every signed-in account regardless.
 */
@Injectable({ providedIn: 'root' })
export class AccountBadgesService {
  private readonly selectedLibrary = inject(SelectedRoomLibraryService);
  private readonly identities = inject(AccountIdentitiesService);

  /** Whether more than one account is being mixed. A boolean computed, so consumers re-evaluate only when mixing starts or stops. */
  readonly mixed = computed(() => this.selectedLibrary.view().mode === 'mixed');

  /** The mixed accounts' badges; empty unless more than one account is being mixed. */
  readonly badges = computed<ReadonlyMap<string, AccountBadge>>(() => {
    const badges = new Map<string, AccountBadge>();
    const view = this.selectedLibrary.view();
    if (view.mode !== 'mixed') {
      return badges;
    }
    // Every account's profile, each read through its OWN client, so a mixed-in account hydrating later
    // updates its badge (the projection listens per account) instead of keeping its mxid and a hashed letter.
    const profiles = this.identities.identities();
    for (const userId of view.accountIds) {
      const profile = profiles.get(userId);
      badges.set(userId, badgeOf(userId, profile));
    }
    return badges;
  });

  /**
   * Every signed-in account's badge, mixed or not. The rail's unread chats list other accounts' chats
   * even with one account selected, so they cannot use {@link badges}.
   */
  readonly everyAccount = computed<ReadonlyMap<string, AccountBadge>>(() => {
    const badges = new Map<string, AccountBadge>();
    for (const [userId, profile] of this.identities.identities()) {
      badges.set(userId, badgeOf(userId, profile));
    }
    return badges;
  });

  /** The badge for an account, or null when not mixing / unknown. */
  forAccount(accountId: string | undefined): AccountBadge | null {
    return accountId ? (this.badges().get(accountId) ?? null) : null;
  }
}
