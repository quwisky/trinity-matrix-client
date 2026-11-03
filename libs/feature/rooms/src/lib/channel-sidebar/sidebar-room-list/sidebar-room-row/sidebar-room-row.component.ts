import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
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
  TrnSurfaceService,
} from '@trinity/components/overlay';
import { IdentityPresenceService } from '@trinity/data-access/identity';
import {
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access/notifications';
import { ContentReportingService } from '@trinity/data-access/room-administration';
import type { RoomSummary } from '@trinity/data-access/room-library';
import { HapticsService } from '@trinity/platform-native';
import { unencryptedShield } from '@trinity/data-access/timeline';
import { formatTypingNotice } from '@trinity/util/matrix';
import { UnencryptedMarkComponent } from '../../../shared/unencrypted-mark/unencrypted-mark.component';
import { unreadBadgeLabel } from '../../../shared/unread-badge';
import { roomSheetButtons } from './room-sheet-buttons';

/**
 * What a row asks its list to do. Every variant carries the row's room (a merged row's `accountIds`
 * ride along).
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
        | 'report'
        | 'leave';
      room: RoomSummary;
    }
  | { kind: 'notify'; room: RoomSummary; mode: RoomNotifyMode };

/** How long a touch is held before it opens the room's actions, and how far it may drift first. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;
/** The most a hold may keep swallowing clicks if no pointer end is ever seen. */
const SWALLOW_FALLBACK_MS = 10_000;

/**
 * One room in the sidebar list: the select button, the kebab and its menu with the Notifications submenu.
 *
 * Per-row helpers (`typingIn`, `presenceOf`, `notifyMode`, the badge label) are `computed()`. Not
 * memoised across syncs: `projectSelectedRooms` rebuilds every `RoomSummary` on each sync, so every
 * row's `room` input changes then and its computeds re-read the push rule and presence (cheap
 * lookups). The host is `display: contents` so `.channel-row` lays out as a direct child of the list.
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
    UnencryptedMarkComponent,
  ],
})
export class SidebarRoomRowComponent {
  private readonly presenceService = inject(IdentityPresenceService);
  private readonly notifications = inject(RoomNotificationsService);
  private readonly reporting = inject(ContentReportingService);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly haptics = inject(HapticsService);
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressOrigin: { x: number; y: number } | null = null;
  private pressPointerId: number | null = null;
  private swallowing = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * After a hold opened the sheet, the click that follows the lift lands on the sheet's backdrop
   * (closing it) or on the row (opening the room). Taken in capture so it reaches neither.
   */
  private readonly swallowClick = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    this.releaseClick();
  };

  /** Hidden once the row's account has learned its server takes no room reports. */
  protected readonly canReport = computed(() =>
    this.reporting.offers(this.room().accountId, 'room'),
  );

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
  protected readonly previewShield = computed(() =>
    unencryptedShield(this.room().lastMessageMark),
  );
  /** Read from the push rules, and re-read when they change (the service reads a signal). */
  protected readonly mode = computed(() => {
    const { id, accountIds } = this.room();
    return this.notifications.modeForAccounts(id, accountIds);
  });
  protected readonly presence = computed(() => {
    // Presence is projected from the ACTIVE client only, so a mixed-in account's DM partner has no
    // entry and would render a grey dot, indistinguishable from offline. Show nothing rather than something false.
    const { directUserId, accountId } = this.room();
    const active = this.activeUserId();
    if (!directUserId || (active && accountId && accountId !== active)) {
      return null;
    }
    return this.presenceService.presenceFor(directUserId)();
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.cancelPress();
      this.releaseClick();
    });
  }

  protected select(): void {
    this.action.emit({ kind: 'select', room: this.room() });
  }

  /** The lift of the finger that held: its click follows at once, so stop swallowing shortly after. */
  private readonly liftSeen = (event: PointerEvent) => {
    if (event.pointerId !== this.pressPointerId || this.releaseTimer !== null)
      return;
    this.releaseTimer = setTimeout(() => this.releaseClick(), 300);
  };

  private releaseClick(): void {
    if (!this.swallowing) return;
    this.swallowing = false;
    document.removeEventListener('click', this.swallowClick, true);
    document.removeEventListener('pointerup', this.liftSeen, true);
    document.removeEventListener('pointercancel', this.liftSeen, true);
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    if (this.fallbackTimer !== null) clearTimeout(this.fallbackTimer);
    this.releaseTimer = this.fallbackTimer = null;
  }

  /** Touch has no ⋮ here: holding the row opens the same actions in the action sheet. */
  protected onPointerDown(event: PointerEvent): void {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    this.cancelPress();
    this.pressOrigin = { x: event.clientX, y: event.clientY };
    this.pressPointerId = event.pointerId;
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.swallowing = true;
      document.addEventListener('click', this.swallowClick, true);
      document.addEventListener('pointerup', this.liftSeen, true);
      document.addEventListener('pointercancel', this.liftSeen, true);
      // Whatever ends the gesture elsewhere, a tap must never be swallowed for long.
      this.fallbackTimer = setTimeout(
        () => this.releaseClick(),
        SWALLOW_FALLBACK_MS,
      );
      this.haptics.gestureCommitted();
      this.surfaces.openActions(
        {
          header:
            this.mode() === 'mixed'
              ? 'Notification settings differ between accounts'
              : undefined,
          buttons: roomSheetButtons({
            room: this.room(),
            active: this.active(),
            mode: this.mode(),
            canReport: this.canReport(),
            spaceActive: this.spaceActive(),
            canCurate: this.canCurate(),
            curateReason: this.curateReason(),
            emit: (action) => this.action.emit(action),
          }),
        },
        { ariaLabel: `Options for ${this.room().name}` },
      );
    }, LONG_PRESS_MS);
  }

  /** A press that travels is a scroll. */
  protected onPointerMove(event: PointerEvent): void {
    const origin = this.pressOrigin;
    if (
      origin &&
      Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y) >
        LONG_PRESS_SLOP_PX
    ) {
      this.cancelPress();
    }
  }

  protected cancelPress(event?: PointerEvent): void {
    if (event && event.pointerId !== this.pressPointerId) return;
    if (this.pressTimer !== null) clearTimeout(this.pressTimer);
    this.pressTimer = null;
    this.pressOrigin = null;
  }

  /** Android raises a context menu at the end of the hold; the sheet is the menu. */
  protected onContextMenu(event: Event): void {
    if (this.swallowing || this.pressTimer !== null) event.preventDefault();
  }
}
