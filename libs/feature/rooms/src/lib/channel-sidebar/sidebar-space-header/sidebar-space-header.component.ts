import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import {
  TrnActionAvailability,
  TrnButton,
  TrnIconButton,
} from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnTooltip } from '@trinity/components/generic-content';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuItemSubIndicatorComponent,
  TrnDropdownMenuLabel,
  TrnDropdownMenuRadio,
  TrnDropdownMenuRadioIndicatorComponent,
  TrnDropdownMenuSeparator,
  TrnDropdownMenuSub,
  TrnDropdownMenuSubTrigger,
  TrnDropdownMenuTrigger,
} from '@trinity/components/overlay';
import {
  DEFAULT_ROOM_SORT,
  TRINITY_ROOM_SORTS,
  type RoomSortMode,
} from '@trinity/data-access/room-library';

/**
 * What the header asks the sidebar to do. The sidebar maps each kind onto the output it
 * always had, so `rooms.page` binds nothing new. `new-chat` carries the button the chooser
 * anchors to; `sort` carries `null` for "follow my account default".
 */
export type SidebarSpaceAction =
  | {
      kind:
        | 'open-switcher'
        | 'create-room'
        | 'mark-all-read'
        | 'invite'
        | 'members'
        | 'add-rooms'
        | 'manage-rooms'
        | 'create-subspace'
        | 'settings'
        | 'leave';
    }
  | { kind: 'new-chat'; anchor: HTMLElement }
  | { kind: 'sort'; mode: RoomSortMode | null };

/**
 * The channel sidebar's 48px header: the title (a menu trigger inside a space), the quick
 * actions, and the space menu with its "Order rooms" submenu.
 *
 * The host is `display: contents` so `.sidebar__header` stays a direct flex item of the
 * sidebar column.
 */
@Component({
  selector: 'trn-sidebar-space-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sidebar-space-header.component.html',
  styleUrl: './sidebar-space-header.component.scss',
  imports: [
    TrnButton,
    TrnIconButton,
    TrnActionAvailability,
    TrnTooltip,
    TrnIconComponent,
    TrnDropdownMenuTrigger,
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuItemSubIndicatorComponent,
    TrnDropdownMenuLabel,
    TrnDropdownMenuRadio,
    TrnDropdownMenuRadioIndicatorComponent,
    TrnDropdownMenuSeparator,
    TrnDropdownMenuSub,
    TrnDropdownMenuSubTrigger,
  ],
})
export class SidebarSpaceHeaderComponent {
  /** The orderings offered in the "Order rooms" submenu. */
  protected readonly sortModes = TRINITY_ROOM_SORTS;

  /** The row that drops the space's override: "Use my default (…)", or another account's. */
  protected readonly defaultSortLabel = computed(() => {
    const owner = this.defaultSortOwner();
    const mode = this.labelFor(this.defaultSortMode());
    return owner
      ? `Use ${owner}’s default (${mode})`
      : `Use my default (${mode})`;
  });

  /** What the "Order rooms" row announces — the effective order, override or not. */
  protected readonly sortModeLabel = computed(() =>
    this.labelFor(this.sortMode()),
  );

  readonly spaceName = input('Direct messages');
  /** Whether a space (not Home) is selected — gates the space actions. */
  readonly spaceActive = input(false);
  /** Desktop's title row owns the quick switcher; the button then steps aside. */
  readonly showSwitcher = input(true);
  /** Whether any room is unread — gates "Mark all as read" (see the sidebar's `hasAnyUnread`). */
  readonly hasAnyUnread = input(false);
  readonly canConfigureSpace = input(false);
  readonly canCurateSpace = input(false);
  readonly curateSpaceReason = input<string | null>(null);
  readonly canInviteToSpace = input(false);
  readonly inviteToSpaceReason = input<string | null>(null);
  /** Leave and Members act as the active account, which may not hold this space. */
  readonly canUseSpaceMembership = input(false);
  readonly spaceMembershipReason = input<string | null>(null);
  /** The ordering the open space's list is using (drives the radio checks). */
  readonly sortMode = input<RoomSortMode>(DEFAULT_ROOM_SORT);
  /** Whether that ordering is the space's own override rather than the account default. */
  readonly sortOverridden = input(false);
  /** The default ordering the list follows, named in the "Use … default" row. */
  readonly defaultSortMode = input<RoomSortMode>(DEFAULT_ROOM_SORT);
  /**
   * Whose default that is, when it is not the account on screen's: in the mixed view a
   * space only another account holds follows that account's ordering. `null` reads "my".
   */
  readonly defaultSortOwner = input<string | null>(null);

  readonly spaceAction = output<SidebarSpaceAction>();

  protected labelFor(mode: RoomSortMode): string {
    return TRINITY_ROOM_SORTS.find((option) => option.id === mode)?.label ?? '';
  }
}
