import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AvatarComponent,
  TrnBadge,
  TrnTooltip,
  type AccountBadge,
} from '@trinity/components/generic-content';
import { TrnButton, TrnIconButton } from '@trinity/components/controls';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuLabel,
  TrnDropdownMenuSeparator,
  TrnDropdownMenuTrigger,
  TrnSurfaceService,
  type TrnDialogRef,
} from '@trinity/components/overlay';
import { type SpaceSummary } from '@trinity/data-access/room-library';
import { isMobileOs } from '@trinity/platform-native';
import { BELOW_MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import { unreadBadgeLabel } from '../shared/unread-badge';
import { TrnIconComponent } from '@trinity/components/foundations';
import {
  type ExactRoomSelection,
  type ExactSpaceSelection,
} from '../shared/exact-selection';
import {
  NO_RAIL_UNREAD_CHATS,
  moreUnreadChatsLabel,
  type RailUnreadChats,
} from './rail-unread-chats';
import { RailUnreadOverflowRowComponent } from './rail-unread-overflow-row/rail-unread-overflow-row.component';
import {
  RailUnreadOverflowSheetComponent,
  type RailOverflowChoice,
} from './rail-unread-overflow-sheet/rail-unread-overflow-sheet.component';

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
    RailUnreadOverflowRowComponent,
    TrnBadge,
    TrnButton,
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuLabel,
    TrnDropdownMenuSeparator,
    TrnDropdownMenuTrigger,
    TrnIconButton,
    TrnIconComponent,
    TrnTooltip,
  ],
  templateUrl: './server-rail.component.html',
  styleUrl: './server-rail.component.scss',
})
export class ServerRailComponent {
  private readonly surface = inject(TrnSurfaceService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly belowMd = mediaQuerySignal(BELOW_MD_QUERY, this.destroyRef);
  private overflowSheet: TrnDialogRef<RailOverflowChoice> | null = null;

  /**
   * "+N" lists the rest as a bottom sheet on phones and tablets and below `md` (the
   * surface service's sheet rule), and as a menu beside it otherwise.
   */
  protected readonly overflowInSheet = computed(
    () => isMobileOs() || this.belowMd(),
  );
  protected readonly overflowSheetOpen = signal(false);
  /** The chats behind "+N", newest first. */
  protected readonly overflowEntries = computed(
    () => this.unreadChats().overflowEntries,
  );

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
  /** Chats with new messages, already filtered, ordered, capped and badged. */
  readonly unreadChats = input<RailUnreadChats>(NO_RAIL_UNREAD_CHATS);
  readonly selectSpace = output<ExactSpaceSelection>();
  /** The "+" pill at the end of the rail — raise the create-a-space flow. */
  readonly createSpace = output<void>();
  /** Show the Recent activity view (all DMs + rooms, mixed by recency). */
  readonly showRecent = output<void>();
  /** Show the Rooms view (non-DM rooms). */
  readonly showRooms = output<void>();
  /** Open one unread chat on the account that owns it. */
  readonly openUnreadChat = output<ExactRoomSelection>();

  constructor() {
    // An emptied list has nothing left to offer, and its "+N" has gone with it.
    effect(() => {
      if (this.overflowEntries().length === 0) this.overflowSheet?.close();
    });
    this.destroyRef.onDestroy(() => this.overflowSheet?.close());
  }

  /** The phone form of "+N": the remaining chats in a bottom sheet. */
  protected openOverflowSheet(): void {
    if (this.overflowSheet) return;
    const ref = this.surface.open<
      RailOverflowChoice,
      RailUnreadOverflowSheetComponent
    >(RailUnreadOverflowSheetComponent, {
      // No `ariaLabel`: the shell's live title names the dialog, so the name follows the count.
      inputs: { chats: this.overflowEntries },
    });
    this.overflowSheet = ref;
    this.overflowSheetOpen.set(true);
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((choice) => {
      this.overflowSheet = null;
      this.overflowSheetOpen.set(false);
      if (choice?.kind === 'chat') this.openUnreadChat.emit(choice.selection);
      if (choice?.kind === 'recent') this.showRecent.emit();
    });
  }

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

  /** Accessible name of a pill: its label plus unread state, since the badge and dot sit outside the button. */
  pillLabel(label: string, counts: RailCounts | undefined): string {
    if (!counts) return label;
    if (counts.mentions > 0) return `${label}, ${counts.mentions} mentions`;
    return counts.unread > 0 ? `${label}, unread` : label;
  }

  /** "+N" text; the count beyond 99 reads "+99". */
  overflowText(count: number): string {
    return `+${Math.min(count, 99)}`;
  }

  /** "+N"'s accessible name and the title of the list it opens. */
  overflowLabel(count: number): string {
    return moreUnreadChatsLabel(count);
  }

  /** Whether the item shows the plain unread dot (unread without mentions). */
  showDot(counts: RailCounts | undefined): boolean {
    return !!counts && counts.unread > 0 && counts.mentions === 0;
  }
}
