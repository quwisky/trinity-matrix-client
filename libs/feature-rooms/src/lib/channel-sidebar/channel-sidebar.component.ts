import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, exitOutline } from 'ionicons/icons';
import { AvatarComponent } from '@trinity/ui';
import type { RoomSummary } from '@trinity/core';

/** Discord channel sidebar: space header, room list, and the user panel. */
@Component({
  selector: 'trn-channel-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, IonIcon],
  template: `
    <div class="sidebar">
      <header class="sidebar__header">
        <span class="sidebar__title">{{ spaceName() }}</span>
        @if (spaceActive()) {
          <div class="sidebar__actions">
            <button
              class="sidebar__action"
              (click)="createRoom.emit()"
              aria-label="Create a channel"
              title="Create a channel"
            >
              <ion-icon name="add-outline" aria-hidden="true" />
            </button>
            <button
              class="sidebar__action"
              (click)="leaveSpace.emit()"
              aria-label="Leave space"
              title="Leave space"
            >
              <ion-icon name="exit-outline" aria-hidden="true" />
            </button>
          </div>
        }
      </header>

      <div class="sidebar__scroll">
        <div class="category">Text Channels</div>
        @for (room of rooms(); track room.id) {
          <button
            class="channel"
            [class.active]="activeRoomId() === room.id"
            [class.unread]="room.hasUnread"
            (click)="selectRoom.emit(room.id)"
            [title]="room.name"
          >
            <span class="channel__hash">#</span>
            <span class="channel__name">{{ room.name }}</span>
            @if (room.highlightCount > 0) {
              <span class="channel__badge" aria-label="Unread mentions">{{
                room.highlightCount
              }}</span>
            } @else if (room.hasUnread) {
              <span class="channel__dot" aria-label="Unread"></span>
            }
          </button>
        } @empty {
          <p class="empty">No channels here yet.</p>
        }
      </div>

      <footer class="userbar">
        <trn-avatar
          [mxc]="userAvatarMxc()"
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
  /** Whether a space (not Home) is selected — gates the header space actions. */
  readonly spaceActive = input(false);
  readonly rooms = input<RoomSummary[]>([]);
  readonly activeRoomId = input<string | null>(null);
  readonly userName = input('');
  readonly userId = input('');
  readonly userAvatarMxc = input<string | null>(null);
  readonly userInitial = input('?');
  readonly selectRoom = output<string>();
  /** Header "+" — raise the create-a-channel flow for the active space. */
  readonly createRoom = output<void>();
  /** Header exit icon — raise the leave-this-space confirmation. */
  readonly leaveSpace = output<void>();
  readonly logout = output<void>();

  constructor() {
    addIcons({ addOutline, exitOutline });
  }
}
