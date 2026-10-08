import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';
import { TrnActionAvailability, TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import {
  AvatarComponent,
  TrnTooltip,
} from '@trinity/components/generic-content';
import { PageHeaderComponent } from '@trinity/components/navigation-layout';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuSeparator,
  TrnDropdownMenuTrigger,
} from '@trinity/components/overlay';
import { type RoomSummary } from '@trinity/data-access/room-library';
import { escapeHtml, linkifyText } from '@trinity/util/matrix';

/** A user intent raised from the room header; the page decides what it does. */
export type RoomHeaderAction =
  | { type: 'back' }
  | { type: 'threads' }
  | { type: 'pinned' }
  | { type: 'members' }
  /** Open the search panel: the icon button, or the inline field gaining text. */
  | { type: 'search' }
  | { type: 'invite' }
  | { type: 'settings' }
  | { type: 'jump-to-date' }
  | { type: 'system-status' };

/** The identity the shell is acting as, shown only while accounts are mixed. */
export interface RoomHeaderActingAs {
  readonly userId: string;
  readonly name: string;
  readonly initial: string;
  readonly avatarMxc: string | null;
}

/**
 * The open room's toolbar: back, title (avatar, lock, acting-as chip, topic popover), the
 * panel toggles, inline search and the overflow menu. It renders the shell's page header, so
 * the title stays projected into that header's single `<h1>`.
 */
@Component({
  selector: 'trn-room-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    TrnButton,
    TrnActionAvailability,
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuSeparator,
    TrnDropdownMenuTrigger,
    TrnTooltip,
    TrnIconComponent,
    AvatarComponent,
  ],
  templateUrl: './room-header.component.html',
  styleUrl: './room-header.component.scss',
})
export class RoomHeaderComponent {
  private readonly searchField =
    viewChild<ElementRef<HTMLInputElement>>('searchField');

  readonly room = input<RoomSummary | null>(null);
  /** A linked room the client has not synced yet: no name, no room actions. */
  readonly loading = input(false);
  /** Below md: the topic is dropped and the back button is shown. */
  readonly compact = input(false);
  readonly actingAs = input<RoomHeaderActingAs | null>(null);
  /** Kind of the surface open in the right-hand slot, for the pressed toggles. */
  readonly surfaceKind = input<string | null>(null);
  readonly pinnedCount = input(0);
  readonly membersVisible = input(false);
  readonly invitePermission = input<{
    available: boolean;
    reason: string | null;
  }>({ available: false, reason: null });
  readonly systemStatusProblems = input(false);
  /** Shared by the header field and the search panel's own field. */
  readonly searchQuery = model('');

  readonly action = output<RoomHeaderAction>();

  /** Doubles as tooltip, accessible name and phone menu label, so the count has no badge. */
  protected readonly pinnedLabel = computed(() =>
    this.pinnedCount() > 0
      ? `Pinned messages (${this.pinnedCount()})`
      : 'Pinned messages',
  );

  /**
   * The full topic as HTML: text is escaped by `linkifyText`/`escapeHtml` first, then links
   * are made to open outside the app (Angular's sanitiser keeps `target` and `rel`).
   */
  protected readonly topicHtml = computed(() => {
    const topic = this.room()?.topic ?? '';
    return (
      linkifyText(topic)?.replace(
        /<a href=/g,
        '<a target="_blank" rel="noopener noreferrer" href=',
      ) ?? escapeHtml(topic)
    );
  });

  focusSearch(): void {
    this.searchField()?.nativeElement.focus();
  }

  protected onSearchInput(value: string): void {
    this.searchQuery.set(value);
    if (value && this.surfaceKind() !== 'search') {
      this.action.emit({ type: 'search' });
    }
  }

  protected clearSearch(event: Event): void {
    const field = event.target as HTMLInputElement;
    // Escape that clears text stops there; in an empty field it reaches the page.
    if (field.value) event.stopPropagation();
    this.searchQuery.set('');
    field.blur();
  }
}
