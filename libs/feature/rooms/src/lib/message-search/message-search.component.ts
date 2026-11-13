import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { SidePanelComponent } from '../side-panel/side-panel.component';
import { SidePanelEmptyComponent } from '../side-panel/side-panel-empty.component';
import { DateTimeFormatService } from '@trinity/platform-native';
import {
  type LoadedMessageSearch,
  type MessageHit,
  type MessageSearchFilter,
  ConversationRuntime,
} from '@trinity/data-access/timeline';
import { RoomMembersService } from '@trinity/data-access/room-administration';
import { initialOf, startOfNextLocalDay } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';
import { BannerComponent } from '@trinity/components/generic-content';
import { AvatarComponent } from '@trinity/components/generic-content';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { releaseInputTargetOnDestroy } from '@trinity/components/overlay';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { TrnIconComponent } from '@trinity/components/foundations';
import { UnencryptedMarkComponent } from '../shared/unencrypted-mark/unencrypted-mark.component';
import {
  groupResultsByDay,
  resultTimeStyle,
  type ResultGroup,
} from './result-days';
import { ServerSearch } from './server-search';
import {
  SearchSenderPickerComponent,
  type SenderFilter,
} from './search-sender-picker/search-sender-picker.component';

/** One run of highlighting: a snippet slice and whether it is the matched term. */
interface HighlightPart {
  text: string;
  match: boolean;
}

/** Waits this long after the last keystroke before asking the homeserver across rooms. */
const ALL_ROOMS_DEBOUNCE_MS = 400;
/** The count is announced once it holds this long, not once per keystroke. */
const COUNT_ANNOUNCE_MS = 1_000;

/**
 * In-room message search for the rooms shell's right-hand panel slot, scoped to the
 * `roomId` the host binds. Matching stays in data access: it reads the focused Conversation
 * child's search and timeline surfaces.
 *
 * E2EE-honest by construction:
 *  - Instant results come from the Conversation child's `searchLoaded`, over the
 *    already-loaded, *decrypted* timeline. Reading its `messages()` re-runs the search
 *    on decryption and scrollback.
 *  - An **encrypted** room has only that path: a lock banner states it covers the loaded
 *    messages only, with a "Load older messages" affordance to widen it.
 *  - An **unencrypted** room also gets "Search all messages", the homeserver full-text
 *    search over the whole history, paged via `next_batch`.
 *
 * Presentational: it owns no panel state. It emits {@link selected} with the matched event
 * id and {@link dismissed} on close; the host owns the slot.
 *
 * It focuses the query field itself when the panel appears: rendered inline in the slot
 * there is no CDK focus pass, so a keyboard user would otherwise have to tab into the field.
 * The marker attribute stays the selector, so there is one definition of "the field to focus".
 */
@Component({
  selector: 'trn-message-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    UnencryptedMarkComponent,
    SidePanelComponent,
    BannerComponent,
    SidePanelEmptyComponent,
    TrnIconComponent,
    AvatarComponent,
    TrnSpinnerComponent,
    TrnButton,
    TrnInput,
    SearchSenderPickerComponent,
  ],
  templateUrl: './message-search.component.html',
  styleUrl: './message-search.component.scss',
})
export class MessageSearchComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);
  private readonly conversations = inject(ConversationRuntime);
  private readonly search = this.conversations.search;
  private readonly timeline = this.conversations.timeline;
  private readonly roomMembers = inject(RoomMembersService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly queryField =
    viewChild<ElementRef<HTMLInputElement>>('queryField');
  private readonly senderChip =
    viewChild<ElementRef<HTMLButtonElement>>('senderChip');

  constructor() {
    // Closed or replaced after a press or key inside it, the panel would otherwise stay in
    // memory, detached, as the CDK's last input target until the next one.
    releaseInputTargetOnDestroy();
    // After the first render: the input does not exist at construction.
    // A changed query invalidates any server results; fall back to instant local.
    effect(() => {
      this.query();
      this.sender();
      untracked(() => {
        this.server.reset();
        this.selectedId.set(null);
      });
    });
    // Across rooms only the homeserver can answer, so ask it once typing pauses.
    effect((onCleanup) => {
      const term = this.query().trim();
      if (this.scope() !== 'all-rooms' || !term) {
        return;
      }
      this.sender();
      untracked(() => this.pending.set(true));
      const timer = setTimeout(
        () =>
          untracked(() => {
            this.pending.set(false);
            this.searchServer();
          }),
        ALL_ROOMS_DEBOUNCE_MS,
      );
      onCleanup(() => {
        clearTimeout(timer);
        this.pending.set(false);
      });
    });
    effect((onCleanup) => {
      const count = this.resultCount();
      if (!count) {
        // Cleared at once, so the strip never keeps reading an old count.
        untracked(() => this.countAnnouncement.set(''));
        return;
      }
      const timer = setTimeout(
        () => this.countAnnouncement.set(count),
        COUNT_ANNOUNCE_MS,
      );
      onCleanup(() => clearTimeout(timer));
    });
    // Day groups move at local midnight: "Today" becomes "Yesterday" while the panel is open.
    let midnight: ReturnType<typeof setTimeout> | undefined;
    const atMidnight = () => {
      midnight = setTimeout(
        () => {
          this.now.set(Date.now());
          atMidnight();
        },
        startOfNextLocalDay(Date.now()) - Date.now() + 1_000,
      );
    };
    atMidnight();
    this.destroyRef.onDestroy(() => clearTimeout(midnight));
    afterNextRender(() => {
      // Skip when opened by typing in the header search field, so typing isn't interrupted.
      const active = document.activeElement;
      if (!(active instanceof HTMLInputElement && active.type === 'search')) {
        this.focusField();
      }
    });
  }

  focusField(): void {
    this.queryField()?.nativeElement.focus();
  }

  readonly roomId = input.required<string>();

  readonly selected = output<string>();
  /** A result from another room: the host opens that room at the message. */
  readonly selectedElsewhere = output<{ roomId: string; eventId: string }>();
  readonly dismissed = output<void>();

  readonly query = model('');

  /** Search this room's loaded history, or every room the homeserver can index. */
  readonly scope = signal<'room' | 'all-rooms'>('room');
  /** Narrow the results to one author; null for anyone. */
  readonly sender = signal<SenderFilter | null>(null);

  /** The room's members, for the "From:" menu. */
  protected readonly members = computed(() =>
    this.roomMembers.membersFor(this.roomId())(),
  );

  protected readonly placeholder = computed(() =>
    this.scope() === 'room' ? 'Search this conversation' : 'Search all rooms',
  );

  /** The homeserver's search: its pages, count, and whether it is running or failed. */
  protected readonly server = new ServerSearch(
    (term, nextBatch, filter) =>
      this.search.searchServer(term, nextBatch, filter),
    this.destroyRef,
    () => this.serverRefusedRoom.set(this.roomId()),
  );
  readonly serverMode = this.server.active;
  readonly serverNextBatch = this.server.nextBatch;
  readonly serverCount = this.server.count;
  readonly searching = this.server.searching;
  readonly loadingHistory = signal(false);
  private readonly historyError = signal<string | null>(null);

  /** The From picker is open under the chips. */
  protected readonly pickingSender = signal(false);

  /** When "today" is, for the day groups; moved on at local midnight. */
  private readonly now = signal(Date.now());

  /**
   * Instant client-side results over the loaded, decrypted timeline. Reading
   * `timeline.messages()` makes this recompute on new events, async decryption, and
   * after a scrollback — without the component touching matrix-js-sdk directly.
   */
  private readonly loaded = computed<LoadedMessageSearch>(() => {
    this.timeline.messages();
    return this.search.searchLoaded(this.query(), this.sender()?.id ?? null);
  });

  /** The room the server search found encrypted where the loaded view did not. */
  private readonly serverRefusedRoom = signal<string | null>(null);

  readonly encrypted = computed(
    () => this.loaded().encrypted || this.serverRefusedRoom() === this.roomId(),
  );
  readonly scanned = computed(() => this.loaded().scanned);

  readonly results = computed<readonly MessageHit[]>(() => {
    if (this.serverMode()) {
      return this.server.hits();
    }
    return this.scope() === 'room' ? this.loaded().hits : [];
  });

  /** Searching with nothing to show yet: the panel shows its skeleton rows. */
  protected readonly loading = computed(
    () => (this.searching() || this.pending()) && !this.results().length,
  );

  /** "7 results" in the header, once there is a query and an answer for it. */
  protected readonly resultCount = computed(() => {
    if (!this.query().trim() || this.loading()) {
      return '';
    }
    const loaded = this.results().length;
    const morePages = this.serverMode() && !!this.serverNextBatch();
    // The homeserver counts before it filters senders, so with "From:" set its count says
    // nothing: show what has loaded, and a "+" while pages remain.
    if (morePages && this.sender()) {
      // Nothing kept yet is not "0+": the empty state says to load more instead.
      return loaded ? `${loaded}+ results` : '';
    }
    // Otherwise its count is approximate; once every page is in, count the hits.
    const count = morePages ? Math.max(this.serverCount(), loaded) : loaded;
    return `${count} ${count === 1 ? 'result' : 'results'}`;
  });

  /** The settled {@link resultCount}, for the live region; equal text announces nothing. */
  protected readonly countAnnouncement = signal('');

  /** The results by when they were sent: today, yesterday, the last week, then by month. */
  protected readonly groups = computed<readonly ResultGroup<MessageHit>[]>(() =>
    groupResultsByDay(this.results(), this.now(), (ts, withYear) =>
      this.fmt.month(ts, withYear),
    ),
  );

  /** An all-rooms search is waiting for typing to pause; the panel shows it loading. */
  protected readonly pending = signal(false);

  /** The result picked last, still marked after the jump. */
  protected readonly selectedId = signal<string | null>(null);

  readonly emptyState = computed<{ title: string; body: string } | null>(() => {
    const term = this.query().trim();
    if (!term) {
      return {
        title: 'Search this room',
        body: 'Type a word or phrase to find the messages that contain it.',
      };
    }
    if (this.searching() || this.pending() || this.server.error()) {
      return null;
    }
    if (this.scope() === 'all-rooms' && !this.serverMode()) {
      return null;
    }
    if (this.serverMode() && this.serverNextBatch()) {
      return {
        title: 'No matches yet',
        body: 'None of the messages searched so far match. Load more to search older ones.',
      };
    }
    return {
      title: 'No results',
      body:
        this.scope() === 'room'
          ? `Nothing in this room matches “${term}”. Try other words.`
          : `Nothing in the rooms your homeserver can search matches “${term}”. Encrypted rooms are searched only in their own panel.`,
    };
  });

  onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  searchServer(): void {
    this.server.run(this.query().trim(), this.filter());
  }

  loadMoreServer(): void {
    this.server.more();
  }

  loadOlderHistory(): void {
    runWithBusy(this.search.loadOlder(), {
      busy: this.loadingHistory,
      error: this.historyError,
      destroyRef: this.destroyRef,
    }).subscribe();
  }

  select(hit: MessageHit): void {
    this.selectedId.set(hit.eventId);
    if (hit.roomId === this.roomId()) {
      this.selected.emit(hit.eventId);
    } else {
      this.selectedElsewhere.emit({ roomId: hit.roomId, eventId: hit.eventId });
    }
  }

  setScope(scope: 'room' | 'all-rooms'): void {
    if (scope === this.scope()) {
      return;
    }
    this.scope.set(scope);
    this.server.reset();
  }

  setSender(sender: SenderFilter | null): void {
    this.sender.set(sender);
    this.closePicker();
  }

  /** Close the From picker and put focus back on the chip that opened it. */
  closePicker(): void {
    this.pickingSender.set(false);
    this.senderChip()?.nativeElement.focus();
  }

  /** A result's time: the clock for today and yesterday, the weekday within a week. */
  protected timeOf(ts: number): string {
    switch (resultTimeStyle(ts, this.now())) {
      case 'time':
        return this.fmt.time(ts);
      case 'weekday':
        return this.fmt.weekday(ts);
      default:
        return this.fmt.dateOnly(ts);
    }
  }

  private filter(): MessageSearchFilter {
    return { scope: this.scope(), sender: this.sender()?.id ?? null };
  }

  dismiss(): void {
    this.dismissed.emit();
  }

  /** Split a snippet into matched / unmatched runs for the highlighted render. */
  highlight(snippet: string): HighlightPart[] {
    const term = this.query().trim();
    if (!term) {
      return [{ text: snippet, match: false }];
    }
    const parts: HighlightPart[] = [];
    // Matched on the snippet itself: offsets found in a lowercased copy drift where
    // lowercasing changes the length ('İ' becomes two code units).
    const needle = new RegExp(
      term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'giu',
    );
    let from = 0;
    for (const found of snippet.matchAll(needle)) {
      if (found.index > from) {
        parts.push({ text: snippet.slice(from, found.index), match: false });
      }
      parts.push({ text: found[0], match: true });
      from = found.index + found[0].length;
    }
    if (from < snippet.length) {
      parts.push({ text: snippet.slice(from), match: false });
    }
    return parts;
  }

  readonly initialOf = initialOf;
}
