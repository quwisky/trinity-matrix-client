import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import {
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuLabel,
  HlmDropdownMenuSeparator,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCircleMinus,
  lucideCommand,
  lucideLogOut,
  lucidePlus,
  lucideSettings,
  lucideUserPlus,
  lucideX,
} from '@ng-icons/lucide';
import { AvatarComponent } from '@trinity/ui';
import type { PendingInvite, RoomSummary, SpaceChildRoom } from '@trinity/core';

/** Discord channel sidebar: space header, invites, room list, and the user panel. */
@Component({
  selector: 'trn-channel-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    NgIcon,
    HlmDropdownMenuTrigger,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuLabel,
    HlmDropdownMenuSeparator,
  ],
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCircleMinus,
      lucideCommand,
      lucideLogOut,
      lucidePlus,
      lucideSettings,
      lucideUserPlus,
      lucideX,
    }),
  ],
  template: `
    <div class="sidebar">
      <header class="sidebar__header">
        <span class="sidebar__title">{{ spaceName() }}</span>
        <div class="sidebar__actions">
          <button
            class="sidebar__action"
            (click)="openSwitcher.emit()"
            aria-label="Search (Ctrl/Cmd+K)"
            title="Search (Ctrl/Cmd+K)"
            data-testid="open-switcher"
          >
            <ng-icon name="lucideCommand" aria-hidden="true" />
          </button>
          @if (spaceActive()) {
            <button
              class="sidebar__action"
              (click)="createRoom.emit()"
              aria-label="Create a channel"
              title="Create a channel"
            >
              <ng-icon name="lucidePlus" aria-hidden="true" />
            </button>
            <button
              class="sidebar__action"
              (click)="inviteToSpace.emit()"
              aria-label="Invite people to space"
              title="Invite people to space"
            >
              <ng-icon name="lucideUserPlus" aria-hidden="true" />
            </button>
            <button
              class="sidebar__action"
              (click)="leaveSpace.emit()"
              aria-label="Leave space"
              title="Leave space"
            >
              <ng-icon name="lucideLogOut" aria-hidden="true" />
            </button>
          } @else {
            <button
              class="sidebar__action"
              (click)="newChat.emit()"
              aria-label="New room or direct message"
              title="New room or direct message"
            >
              <ng-icon name="lucidePlus" aria-hidden="true" />
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
                  <ng-icon name="lucideCheck" aria-hidden="true" />
                </button>
                <button
                  class="invite__btn decline"
                  (click)="declineInvite.emit(invite.roomId)"
                  [attr.aria-label]="'Decline invite to ' + invite.name"
                  title="Decline"
                >
                  <ng-icon name="lucideX" aria-hidden="true" />
                </button>
              </div>
            </div>
          }
        }

        <div class="category">Text Channels</div>
        @for (room of rooms(); track room.id) {
          <div class="channel-row">
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
            @if (spaceActive()) {
              <button
                class="channel__remove"
                (click)="removeRoom.emit(room.id)"
                [attr.aria-label]="'Remove ' + room.name + ' from this space'"
                title="Remove from space"
              >
                <ng-icon name="lucideCircleMinus" aria-hidden="true" />
              </button>
            }
          </div>
        } @empty {
          <p class="empty">No channels here yet.</p>
        }

        @if (spaceActive()) {
          @if (childrenLoading()) {
            <p class="empty">Loading channels…</p>
          } @else if (childrenError()) {
            <p class="empty empty--error">
              Couldn’t load this space’s channels.
            </p>
          } @else {
            @if (joinableRooms().length) {
              <div class="category">More Channels</div>
              @for (child of joinableRooms(); track child.roomId) {
                <div class="joinable">
                  <span class="joinable__hash">#</span>
                  <div class="joinable__text">
                    <span
                      class="joinable__name"
                      [title]="child.topic || child.name"
                      >{{ child.name }}</span
                    >
                    @if (child.suggested) {
                      <span class="joinable__tag">Suggested</span>
                    }
                  </div>
                  <button
                    class="joinable__action"
                    (click)="joinRoom.emit(child)"
                    [attr.aria-label]="'Join ' + child.name"
                    title="Join"
                  >
                    Join
                  </button>
                </div>
              }
            }

            @if (childSpaces().length) {
              <div class="category">Spaces</div>
              @for (child of childSpaces(); track child.roomId) {
                <div class="joinable joinable--space">
                  <trn-avatar
                    class="joinable__avatar"
                    [mxc]="child.avatarMxc"
                    [initial]="child.initial"
                    [name]="child.name"
                    [size]="24"
                    [square]="true"
                  />
                  <div class="joinable__text">
                    <span class="joinable__name" [title]="child.name">{{
                      child.name
                    }}</span>
                  </div>
                  @if (child.joined) {
                    <button
                      class="joinable__action"
                      (click)="openChildSpace.emit(child.roomId)"
                      [attr.aria-label]="'Open ' + child.name"
                      title="Open"
                    >
                      Open
                    </button>
                  } @else {
                    <button
                      class="joinable__action"
                      (click)="joinRoom.emit(child)"
                      [attr.aria-label]="'Join ' + child.name"
                      title="Join"
                    >
                      Join
                    </button>
                  }
                </div>
              }
            }
          }
        }
      </div>

      <footer class="userbar">
        <button
          class="userbar__trigger"
          [hlmDropdownMenuTrigger]="accountMenu"
          side="top"
          align="start"
          aria-label="Account menu"
          data-testid="user-menu-trigger"
        >
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
        </button>
        <button
          class="userbar__settings"
          (click)="openSettings.emit()"
          aria-label="Settings"
          title="Settings"
          data-testid="open-settings"
        >
          <ng-icon name="lucideSettings" />
        </button>
      </footer>

      <ng-template #accountMenu>
        <div hlmDropdownMenu>
          <div hlmDropdownMenuLabel class="truncate">{{ userName() }}</div>
          <div hlmDropdownMenuSeparator></div>
          <button
            hlmDropdownMenuItem
            variant="destructive"
            (triggered)="logout.emit()"
            data-testid="logout"
          >
            <ng-icon name="lucideLogOut" />
            Log out
          </button>
        </div>
      </ng-template>
    </div>
  `,
  styleUrl: './channel-sidebar.component.scss',
})
export class ChannelSidebarComponent {
  readonly spaceName = input('Home');
  /** Whether a space (not Home) is selected — gates the header space actions. */
  readonly spaceActive = input(false);
  readonly rooms = input<RoomSummary[]>([]);
  /** Not-yet-joined channels of the active space (the "More Channels" list). */
  readonly joinableRooms = input<SpaceChildRoom[]>([]);
  /** Sub-spaces of the active space (joined → Open, otherwise Join). */
  readonly childSpaces = input<SpaceChildRoom[]>([]);
  /** Whether the active space's child hierarchy is still loading. */
  readonly childrenLoading = input(false);
  /** Non-null when the active space's child hierarchy failed to load. */
  readonly childrenError = input<string | null>(null);
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
  /** Join a not-yet-joined child room or sub-space of the active space. */
  readonly joinRoom = output<SpaceChildRoom>();
  /** Remove (unlink) a joined channel from the active space, by room id. */
  readonly removeRoom = output<string>();
  /** Open a joined sub-space (select it in the rail), by room id. */
  readonly openChildSpace = output<string>();
  /** Accept / decline a pending invite by room id. */
  readonly acceptInvite = output<string>();
  readonly declineInvite = output<string>();
  /** Header search icon — open the global quick switcher (Ctrl/Cmd+K). */
  readonly openSwitcher = output<void>();
  /** User-panel gear — open the settings page. */
  readonly openSettings = output<void>();
  readonly logout = output<void>();
}
