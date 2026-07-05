import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideDoorOpen, lucideHouse } from '@ng-icons/lucide';
import { AvatarComponent } from '@trinity/ui';
import { type SpaceSummary } from '@trinity/data-access-rooms';
import { unreadBadgeLabel } from '../shared/unread-badge';

/** Unread notification counts driving the rail's badges. */
export interface RailUnread {
  /** Total across direct-message rooms (Home badge). */
  home: number;
  /** Total across non-DM rooms (Rooms badge). */
  rooms: number;
  /** Per-space totals keyed by space id (space-pill badges). */
  perSpace: Record<string, number>;
}

/** Discord server rail: Home (direct messages) + a Rooms view + one pill per Matrix Space. */
@Component({
  selector: 'trn-server-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, NgIcon],
  viewProviders: [provideIcons({ lucideDoorOpen, lucideHouse })],
  templateUrl: './server-rail.component.html',
  styleUrl: './server-rail.component.scss',
})
export class ServerRailComponent {
  readonly spaces = input<SpaceSummary[]>([]);
  readonly activeSpaceId = input<string | null>(null);
  /** Whether the Rooms view is active (drives the Rooms pill's active state). */
  readonly roomsActive = input(false);
  /** Unread notification counts for the Home / Rooms / per-space badges. */
  readonly unread = input<RailUnread>({ home: 0, rooms: 0, perSpace: {} });
  readonly selectSpace = output<string | null>();
  /** The "+" pill at the end of the rail — raise the create-a-space flow. */
  readonly createSpace = output<void>();
  /** Show the Rooms view (non-DM rooms). */
  readonly showRooms = output<void>();

  /** Cap an unread count for a pill badge, Discord-style ("99+"). */
  readonly badgeLabel = unreadBadgeLabel;
}
