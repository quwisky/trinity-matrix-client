import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { AvatarComponent, type AccountBadge } from '@trinity/components/avatar';
import { TrnIconButton } from '@trinity/components/button';
import { TrnTooltip } from '@trinity/components/tooltip';
import { type SpaceSummary } from '@trinity/data-access/room-library';
import { unreadBadgeLabel } from '../shared/unread-badge';
import { TrnIconComponent } from '@trinity/components/icon';

/** Unread notification counts driving the rail's badges. */
export interface RailUnread {
  /** Total across everything the Recent activity view lists (Recent badge). */
  recent: number;
  /** Total across direct-message rooms (Home badge). */
  home: number;
  /** Total across non-DM rooms (Rooms badge). */
  rooms: number;
  /** Per-space totals keyed by space id (space-pill badges). */
  perSpace: Record<string, number>;
}

/**
 * Discord server rail: a combined Recent activity view, then Home (direct messages), a
 * Rooms view, and one pill per Matrix Space.
 */
@Component({
  selector: 'trn-server-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, TrnIconButton, TrnIconComponent, TrnTooltip],
  templateUrl: './server-rail.component.html',
  styleUrl: './server-rail.component.scss',
})
export class ServerRailComponent {
  readonly spaces = input<SpaceSummary[]>([]);
  readonly activeSpaceId = input<string | null>(null);
  /** Whether the Recent activity view is active (drives its pill's active state). */
  readonly recentActive = input(false);
  /** Whether the Rooms view is active (drives the Rooms pill's active state). */
  readonly roomsActive = input(false);
  /** Unread notification counts for the Recent / Home / Rooms / per-space badges. */
  readonly unread = input<RailUnread>({
    recent: 0,
    home: 0,
    rooms: 0,
    perSpace: {},
  });
  /**
   * Owning-account badge per account id (mixed-account view): account id → its avatar/
   * initial/name. Empty when not in mixed mode — space pills then show no badge.
   */
  readonly accountBadges = input<ReadonlyMap<string, AccountBadge>>(new Map());
  readonly selectSpace = output<string | null>();
  /** The "+" pill at the end of the rail — raise the create-a-space flow. */
  readonly createSpace = output<void>();
  /** Show the Recent activity view (all DMs + rooms, mixed by recency). */
  readonly showRecent = output<void>();
  /** Show the Rooms view (non-DM rooms). */
  readonly showRooms = output<void>();

  /** The account badge for a space pill (mixed view), or null when not badged. */
  badgeFor(accountId: string): AccountBadge | null {
    return this.accountBadges().get(accountId) ?? null;
  }

  /** Cap an unread count for a pill badge, Discord-style ("99+"). */
  readonly badgeLabel = unreadBadgeLabel;
}
