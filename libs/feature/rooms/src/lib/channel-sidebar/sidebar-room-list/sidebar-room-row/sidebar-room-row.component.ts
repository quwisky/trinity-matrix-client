import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import {
  TrnActionAvailability,
  TrnIconButton,
} from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import {
  AvatarComponent,
  TrnBadge,
  TrnTooltip,
  type AccountBadge,
} from '@trinity/components/generic-content';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuItemSubIndicatorComponent,
  TrnDropdownMenuRadio,
  TrnDropdownMenuRadioIndicatorComponent,
  TrnDropdownMenuSeparator,
  TrnDropdownMenuSub,
  TrnDropdownMenuSubTrigger,
  TrnDropdownMenuTrigger,
} from '@trinity/components/overlay';
import { IdentityPresenceService } from '@trinity/data-access/identity';
import {
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access/notifications';
import type { RoomSummary } from '@trinity/data-access/room-library';
import { formatTypingNotice } from '@trinity/util/matrix';
import { unreadBadgeLabel } from '../../../shared/unread-badge';

/**
 * What a row asks its list to do. Every variant carries the row's room, so the list can
 * route it to the same outputs it always had (a merged row's `accountIds` ride along).
 */
export type SidebarRoomAction =
  | {
      kind:
        | 'select'
        | 'favourite'
        | 'low-priority'
        | 'mark-read'
        | 'mark-unread'
        | 'remove'
        | 'leave';
      room: RoomSummary;
    }
  | { kind: 'notify'; room: RoomSummary; mode: RoomNotifyMode };

/**
 * One room in the sidebar list: the select button, the kebab and its menu with the
 * Notifications submenu.
 *
 * Everything the old row template computed per change detection (`typingIn`, `presenceOf`,
 * `notifyMode`, the badge label) is a `computed()` here, so a list update that leaves this
 * row's inputs alone leaves its derived state alone too. The host is `display: contents`
 * so `.channel-row` lays out as a direct child of the scrolling list.
 */
@Component({
  selector: 'trn-sidebar-room-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'sidebar-room-row.component.html',
  styleUrl: 'sidebar-room-row.component.scss',
  imports: [
    TrnIconButton,
    TrnActionAvailability,
    TrnTooltip,
    TrnBadge,
    AvatarComponent,
    TrnIconComponent,
    TrnDropdownMenuTrigger,
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuItemSubIndicatorComponent,
    TrnDropdownMenuRadio,
    TrnDropdownMenuRadioIndicatorComponent,
    TrnDropdownMenuSeparator,
    TrnDropdownMenuSub,
    TrnDropdownMenuSubTrigger,
  ],
})
export class SidebarRoomRowComponent {
  private readonly presenceService = inject(IdentityPresenceService);
  private readonly notifications = inject(RoomNotificationsService);

  readonly room = input.required<RoomSummary>();
  readonly active = input(false);
  /** Display names typing in this room, excluding the local user. */
  readonly typing = input<readonly string[] | undefined>();
  readonly activeUserId = input<string | null>(null);
  readonly accountBadge = input<AccountBadge | null>(null);
  readonly avatarSize = input(36);
  readonly spaceActive = input(false);
  readonly canCurate = input(false);
  readonly curateReason = input<string | null>(null);

  readonly action = output<SidebarRoomAction>();

  protected readonly typingNotice = computed(() =>
    formatTypingNotice(this.typing() ?? []),
  );
  protected readonly highlightLabel = computed(() =>
    unreadBadgeLabel(this.room().highlightCount),
  );
  /** Read from the push rules, and re-read when they change (the service reads a signal). */
  protected readonly mode = computed(() => {
    const { id, accountIds } = this.room();
    return this.notifications.modeForAccounts(id, accountIds);
  });
  protected readonly presence = computed(() => {
    // Presence is projected from the ACTIVE client only, so a mixed-in account's DM partner
    // has no entry there and would render a grey dot — indistinguishable from genuinely
    // offline. Show nothing rather than something false.
    const { directUserId, accountId } = this.room();
    const active = this.activeUserId();
    if (!directUserId || (active && accountId && accountId !== active)) {
      return null;
    }
    return this.presenceService.presenceFor(directUserId)();
  });
}
