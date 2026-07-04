import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideDoorOpen, lucideHouse } from '@ng-icons/lucide';
import { AvatarComponent } from '@trinity/ui';
import type { SpaceSummary } from '@trinity/core';

/** Discord server rail: Home (direct messages) + a Rooms view + one pill per Matrix Space. */
@Component({
  selector: 'trn-server-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, NgIcon],
  viewProviders: [provideIcons({ lucideDoorOpen, lucideHouse })],
  template: `
    <nav class="rail">
      <div
        class="item"
        [class.active]="activeSpaceId() === null && !roomsActive()"
      >
        <span class="indicator"></span>
        <button
          class="pill home"
          [class.round]="activeSpaceId() === null && !roomsActive()"
          (click)="selectSpace.emit(null)"
          [attr.aria-current]="
            activeSpaceId() === null && !roomsActive() ? 'true' : null
          "
          aria-label="Home"
          title="Home"
        >
          <ng-icon name="lucideHouse" aria-hidden="true" />
        </button>
        @if (homeUnread() > 0) {
          <span
            class="badge"
            [attr.aria-label]="badgeLabel(homeUnread()) + ' unread'"
            >{{ badgeLabel(homeUnread()) }}</span
          >
        }
      </div>

      <div class="item" [class.active]="roomsActive()">
        <span class="indicator"></span>
        <button
          class="pill rooms"
          (click)="showRooms.emit()"
          [attr.aria-current]="roomsActive() ? 'true' : null"
          aria-label="Rooms"
          title="Rooms"
          data-testid="rail-rooms"
        >
          <ng-icon name="lucideDoorOpen" aria-hidden="true" />
        </button>
        @if (roomsUnread() > 0) {
          <span
            class="badge"
            [attr.aria-label]="badgeLabel(roomsUnread()) + ' unread'"
            >{{ badgeLabel(roomsUnread()) }}</span
          >
        }
      </div>

      <div class="separator"></div>

      @for (space of spaces(); track space.id) {
        @let spaceUnreadCount = spaceUnread()[space.id] ?? 0;
        <div
          class="item"
          [class.active]="activeSpaceId() === space.id && !roomsActive()"
        >
          <span class="indicator"></span>
          <button
            class="pill"
            (click)="selectSpace.emit(space.id)"
            [attr.aria-current]="
              activeSpaceId() === space.id && !roomsActive() ? 'true' : null
            "
            [attr.aria-label]="space.name"
            [title]="space.name"
          >
            <trn-avatar
              [mxc]="space.avatarMxc"
              [initial]="space.initial"
              [name]="space.name"
              [square]="activeSpaceId() !== space.id || roomsActive()"
              [size]="48"
            />
          </button>
          @if (spaceUnreadCount > 0) {
            <span
              class="badge"
              [attr.aria-label]="badgeLabel(spaceUnreadCount) + ' unread'"
              >{{ badgeLabel(spaceUnreadCount) }}</span
            >
          }
        </div>
      }

      <div class="item">
        <span class="indicator"></span>
        <button
          class="pill add"
          (click)="createSpace.emit()"
          aria-label="Create a space"
          title="Create a space"
        >
          +
        </button>
      </div>
    </nav>
  `,
  styleUrl: './server-rail.component.scss',
})
export class ServerRailComponent {
  readonly spaces = input<SpaceSummary[]>([]);
  readonly activeSpaceId = input<string | null>(null);
  /** Whether the Rooms view is active (drives the Rooms pill's active state). */
  readonly roomsActive = input(false);
  /** Total unread notifications across direct-message rooms (Home badge). */
  readonly homeUnread = input(0);
  /** Total unread notifications across non-DM rooms (Rooms badge). */
  readonly roomsUnread = input(0);
  /** Per-space total unread notifications, keyed by space id (space-pill badge). */
  readonly spaceUnread = input<Record<string, number>>({});
  readonly selectSpace = output<string | null>();
  /** The "+" pill at the end of the rail — raise the create-a-space flow. */
  readonly createSpace = output<void>();
  /** Show the Rooms view (non-DM rooms). */
  readonly showRooms = output<void>();

  /** Cap an unread count for a pill badge, Discord-style ("99+"). */
  badgeLabel(count: number): string {
    return count > 99 ? '99+' : String(count);
  }
}
