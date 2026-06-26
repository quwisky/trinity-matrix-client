import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { AvatarComponent } from '../avatar/avatar.component';
import type { RoomSummary } from '@trinity/core';

/** Discord channel sidebar: space header, room list, and the user panel. */
@Component({
  selector: 'app-channel-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent],
  template: `
    <div class="sidebar">
      <header class="sidebar__header">{{ spaceName() }}</header>

      <div class="sidebar__scroll">
        <div class="category">Text Channels</div>
        @for (room of rooms(); track room.id) {
          <button
            class="channel"
            [class.active]="activeRoomId() === room.id"
            (click)="selectRoom.emit(room.id)"
            [title]="room.name"
          >
            <span class="channel__hash">#</span>
            <span class="channel__name">{{ room.name }}</span>
          </button>
        } @empty {
          <p class="empty">No channels here yet.</p>
        }
      </div>

      <footer class="userbar">
        <app-avatar
          [url]="userAvatarUrl()"
          [initial]="userInitial()"
          [name]="userName()"
          [size]="32"
        />
        <div class="userbar__id">
          <span class="userbar__name">{{ userName() }}</span>
          <span class="userbar__handle">{{ userId() }}</span>
        </div>
        <button
          class="userbar__logout"
          (click)="logout.emit()"
          aria-label="Log out"
          title="Log out"
        >
          ⏻
        </button>
      </footer>
    </div>
  `,
  styleUrl: './channel-sidebar.component.scss',
})
export class ChannelSidebarComponent {
  readonly spaceName = input('Home');
  readonly rooms = input<RoomSummary[]>([]);
  readonly activeRoomId = input<string | null>(null);
  readonly userName = input('');
  readonly userId = input('');
  readonly userAvatarUrl = input<string | null>(null);
  readonly userInitial = input('?');
  readonly selectRoom = output<string>();
  readonly logout = output<void>();
}
