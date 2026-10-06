import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import {
  AvatarComponent,
  TrnBadge,
  TrnTooltip,
  type AccountBadge,
} from '@trinity/components/generic-content';
import { TrnButton, TrnIconButton } from '@trinity/components/controls';
import { type SpaceSummary } from '@trinity/data-access/room-library';
import { unreadBadgeLabel } from '../shared/unread-badge';
import { TrnIconComponent } from '@trinity/components/foundations';
import { type ExactSpaceSelection } from '../shared/exact-selection';

/** Unread and mention counts for one rail item. */
export interface RailCounts {
  unread: number;
  /** Highlight (mention) total; shown as a danger badge. */
  mentions: number;
}

/** Unread and mention counts driving the rail's indicators and badges. */
export interface RailUnread {
  /** Everything the Recent activity view lists. */
  recent: RailCounts;
  /** Direct-message rooms (Home). */
  home: RailCounts;
  /** Non-DM rooms outside any space (Rooms). */
  rooms: RailCounts;
  /** Per-space counts keyed by space id. */
  perSpace: Record<string, RailCounts>;
}

const NO_COUNTS: RailCounts = { unread: 0, mentions: 0 };

/**
 * Discord server rail: a combined Recent activity view, then Home (direct messages), a
 * Rooms view, and one pill per Matrix Space.
 */
@Component({
  selector: 'trn-server-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    NgTemplateOutlet,
    TrnBadge,
    TrnButton,
    TrnIconButton,
    TrnIconComponent,
    TrnTooltip,
  ],
  templateUrl: './server-rail.component.html',
  styleUrl: './server-rail.component.scss',
})
export class ServerRailComponent {
  readonly spaces = input<readonly SpaceSummary[]>([]);
  readonly activeAccountId = input.required<string | null>();
  readonly activeSpaceId = input<string | null>(null);
  /** Whether the Recent activity view is active (drives its pill's active state). */
  readonly recentActive = input(false);
  /** Whether the Rooms view is active (drives the Rooms pill's active state). */
  readonly roomsActive = input(false);
  /** Unread notification counts for the Recent / Home / Rooms / per-space badges. */
  readonly unread = input<RailUnread>({
    recent: NO_COUNTS,
    home: NO_COUNTS,
    rooms: NO_COUNTS,
    perSpace: {},
  });
  /**
   * Owning-account badge per account id (mixed-account view): account id → its avatar/
   * initial/name. Empty when not in mixed mode — space pills then show no badge.
   */
  readonly accountBadges = input<ReadonlyMap<string, AccountBadge>>(new Map());
  readonly selectSpace = output<ExactSpaceSelection>();
  /** The "+" pill at the end of the rail — raise the create-a-space flow. */
  readonly createSpace = output<void>();
  /** Show the Recent activity view (all DMs + rooms, mixed by recency). */
  readonly showRecent = output<void>();
  /** Show the Rooms view (non-DM rooms). */
  readonly showRooms = output<void>();

  selectHome(): void {
    const accountId = this.activeAccountId();
    if (accountId) this.selectSpace.emit({ spaceId: null, accountId });
  }

  /** The account badge for a space pill (mixed view), or null when not badged. */
  badgeFor(accountId: string): AccountBadge | null {
    return this.accountBadges().get(accountId) ?? null;
  }

  /** The mention badge text ("99+" cap), or null when there are no mentions. */
  mentionLabel(counts: RailCounts | undefined): string | null {
    return counts && counts.mentions > 0
      ? unreadBadgeLabel(counts.mentions)
      : null;
  }

  /** Whether the item shows the plain unread dot (unread without mentions). */
  showDot(counts: RailCounts | undefined): boolean {
    return !!counts && counts.unread > 0 && counts.mentions === 0;
  }
}
