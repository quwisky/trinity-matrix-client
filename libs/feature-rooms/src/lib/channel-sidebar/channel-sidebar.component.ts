import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  addOutline,
  checkmarkOutline,
  closeOutline,
  exitOutline,
  personAddOutline,
} from 'ionicons/icons';
import { AvatarComponent } from '@trinity/ui';
import type { PendingInvite, RoomSummary } from '@trinity/core';

/** Discord channel sidebar: space header, invites, room list, and the user panel. */
@Component({
  selector: 'trn-channel-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, IonIcon],
  template: `
    <div class="sidebar">
      <header class="sidebar__header">
        <span class="sidebar__title">{{ spaceName() }}</span>
        <div class="sidebar__actions">
          @if (spaceActive()) {
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
              (click)="inviteToSpace.emit()"
              aria-label="Invite people to space"
              title="Invite people to space"
            >
              <ion-icon name="person-add-outline" aria-hidden="true" />
            </button>
            <button
              class="sidebar__action"
              (click)="leaveSpace.emit()"
              aria-label="Leave space"
              title="Leave space"
            >
              <ion-icon name="exit-outline" aria-hidden="true" />
            </button>
          } @else {
            <button
              class="sidebar__action"
              (click)="newChat.emit()"
              aria-label="New room or direct message"
              title="New room or direct message"
            >
              <ion-icon name="add-outline" aria-hidden="true" />
            </button>
          }
        </div>
      </header>

      <div class="sidebar__scroll">
        @if (invites().length) {
          <div class="category">Invites</div>
          @for (invite of invites(); track invite.roomId) {
            <div class="invite">
              <trn-avatar
                class="invite__avatar"
                [mxc]="invite.avatarMxc"
                [initial]="invite.initial"
                [name]="invite.name"
                [size]="32"
              />
              <div class="invite__text">
                <span class="invite__name" [title]="invite.name">{{
                  invite.name
                }}</span>
                <span class="invite__meta"
                  >{{
                    invite.isSpace ? 'Space' : invite.isDirect ? 'DM' : 'Room'
                  }}
                  · from {{ invite.inviterName }}</span
                >
              </div>
              <div class="invite__actions">
                <button
                  class="invite__btn accept"
                  (click)="acceptInvite.emit(invite.roomId)"
                  [attr.aria-label]="'Accept invite to ' + invite.name"
                  title="Accept"
                >
                  <ion-icon name="checkmark-outline" aria-hidden="true" />
                </button>
                <button
                  class="invite__btn decline"
                  (click)="declineInvite.emit(invite.roomId)"
                  [attr.aria-label]="'Decline invite to ' + invite.name"
                  title="Decline"
                >
                  <ion-icon name="close-outline" aria-hidden="true" />
                </button>
              </div>
            </div>
          }
        }

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
  /** Pending invites surfaced in an "Invites" group above the channels. */
  readonly invites = input<PendingInvite[]>([]);
  readonly activeRoomId = input<string | null>(null);
  readonly userName = input('');
  readonly userId = input('');
  readonly userAvatarMxc = input<string | null>(null);
  readonly userInitial = input('?');
  readonly selectRoom = output<string>();
  /** Header "+" on Home — raise the new-room / new-DM chooser. */
  readonly newChat = output<void>();
  /** Header "+" in a space — raise the create-a-channel flow. */
  readonly createRoom = output<void>();
  /** Header person-add in a space — raise the invite-to-space flow. */
  readonly inviteToSpace = output<void>();
  /** Header exit icon — raise the leave-this-space confirmation. */
  readonly leaveSpace = output<void>();
  /** Accept / decline a pending invite by room id. */
  readonly acceptInvite = output<string>();
  readonly declineInvite = output<string>();
  readonly logout = output<void>();

  constructor() {
    addIcons({
      addOutline,
      checkmarkOutline,
      closeOutline,
      exitOutline,
      personAddOutline,
    });
  }
}
