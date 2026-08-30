import { Injectable, computed, inject } from '@angular/core';
import { AccountProfilesService } from '@trinity/data-access/profile';
import { AccountScopeService } from '@trinity/data-access/room-library';
import { type AccountBadge } from '@trinity/components/avatar';

/**
 * Owning-account badges for the mixed-account view: account id → the avatar/initial/name
 * drawn in the corner of a room row, space pill or switcher result.
 *
 * Shared so every surface that renders mixed rows badges them identically — the sidebar,
 * the rail and the quick switcher would otherwise each derive this, and drift.
 *
 * Empty unless more than one account is being mixed, which is what makes a badge meaningful
 * in the first place: with a single account every row belongs to it.
 */
@Injectable({ providedIn: 'root' })
export class AccountBadgesService {
  private readonly scope = inject(AccountScopeService);
  private readonly profiles = inject(AccountProfilesService);

  readonly badges = computed<ReadonlyMap<string, AccountBadge>>(() => {
    const badges = new Map<string, AccountBadge>();
    if (!this.scope.mixing()) {
      return badges;
    }
    // Every account's profile, each read through its OWN client. This used to read a
    // counter only the ACTIVE client bumped, and lean on the unread aggregator — the one
    // signal already fed by every client — to notice a mixed-in account hydrating later,
    // which otherwise kept its mxid and a hashed letter instead of its name and picture.
    // That workaround is gone: the projection listens per account, so a badge is driven by
    // the thing it displays rather than by whichever unrelated signal happened to tick.
    const profiles = this.profiles.profiles();
    for (const userId of this.scope.selected()) {
      const profile = profiles.get(userId);
      const name = profile?.displayName || userId;
      badges.set(userId, {
        id: userId,
        name,
        initial: (name.replace(/^[@#!]+/, '').trim()[0] ?? '?').toUpperCase(),
        avatarMxc: profile?.avatarMxc ?? null,
      });
    }
    return badges;
  });

  /** The badge for an account, or null when not mixing / unknown. */
  forAccount(accountId: string | undefined): AccountBadge | null {
    return accountId ? (this.badges().get(accountId) ?? null) : null;
  }
}
