import { Injectable, computed, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { AccountScopeService, RoomsService } from '@trinity/data-access-rooms';
import { type AccountBadge } from '@trinity/ui';

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
  private readonly matrix = inject(MatrixClientService);
  private readonly scope = inject(AccountScopeService);
  private readonly rooms = inject(RoomsService);

  readonly badges = computed<ReadonlyMap<string, AccountBadge>>(() => {
    const badges = new Map<string, AccountBadge>();
    if (!this.scope.mixing()) {
      return badges;
    }
    this.rooms.revision(); // re-read each account's profile as it hydrates on sync
    for (const userId of this.scope.selected()) {
      const user = this.matrix.clientFor(userId)?.getUser(userId);
      const name = user?.displayName || userId;
      badges.set(userId, {
        id: userId,
        name,
        initial: (name.replace(/^[@#!]+/, '').trim()[0] ?? '?').toUpperCase(),
        avatarMxc: user?.avatarUrl ?? null,
      });
    }
    return badges;
  });

  /** The badge for an account, or null when not mixing / unknown. */
  forAccount(accountId: string | undefined): AccountBadge | null {
    return accountId ? (this.badges().get(accountId) ?? null) : null;
  }
}
