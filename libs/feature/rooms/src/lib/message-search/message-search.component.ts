import { type Subscription } from 'rxjs';
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
import { initialOf } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';
import { BannerComponent } from '@trinity/components/generic-content';
import { AvatarComponent } from '@trinity/components/generic-content';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuTrigger,
  releaseInputTargetOnDestroy,
} from '@trinity/components/overlay';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { TrnIconComponent } from '@trinity/components/foundations';
import { UnencryptedMarkComponent } from '../shared/unencrypted-mark/unencrypted-mark.component';
import {
  groupResultsByDay,
  resultTimeStyle,
  type ResultGroup,
} from './result-days';

/** One run of highlighting: a snippet slice and whether it is the matched term. */
interface HighlightPart {
  text: string;
  match: boolean;
}

/** The author a search is narrowed to. */
interface SenderFilter {
  readonly id: string;
  readonly name: string;
}

/** Waits this long after the last keystroke before asking the homeserver across rooms. */
const ALL_ROOMS_DEBOUNCE_MS = 400;

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
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuTrigger,
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
        this.cancelServer();
        this.resetServer();
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

  readonly serverMode = signal(false);
  private readonly serverHits = signal<readonly MessageHit[]>([]);
  readonly serverNextBatch = signal<string | null>(null);
  readonly serverCount = signal(0);
  readonly searching = signal(false);
  readonly loadingHistory = signal(false);
  private readonly error = signal<string | null>(null);

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
      return this.serverHits();
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
    // The homeserver's count is approximate, so once every page is in, count the hits.
    const count =
      this.serverMode() && this.serverNextBatch()
        ? Math.max(this.serverCount(), this.results().length)
        : this.results().length;
    return `${count} ${count === 1 ? 'result' : 'results'}`;
  });

  /** The results by when they were sent: today, yesterday, the last week, then by month. */
  protected readonly groups = computed<readonly ResultGroup<MessageHit>[]>(() =>
    groupResultsByDay(this.results(), Date.now()),
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
    if (this.searching() || this.pending()) {
      return null;
    }
    if (this.scope() === 'all-rooms' && !this.serverMode()) {
      return null;
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
    const term = this.query().trim();
    if (!term) {
      return;
    }
    this.cancelServer();
    this.serverMode.set(true);
    this.inFlight = runWithBusy(
      this.search.searchServer(term, undefined, this.filter()),
      {
        busy: this.searching,
        error: this.error,
        destroyRef: this.destroyRef,
      },
    ).subscribe((page) => {
      if (page.encrypted) {
        this.serverRefusedRoom.set(this.roomId());
        this.serverMode.set(false);
        return;
      }
      this.serverHits.set(page.hits);
      this.serverCount.set(page.count);
      this.serverNextBatch.set(page.nextBatch);
    });
  }

  loadMoreServer(): void {
    const term = this.query().trim();
    const next = this.serverNextBatch();
    if (!term || !next) {
      return;
    }
    this.cancelServer();
    this.inFlight = runWithBusy(
      this.search.searchServer(term, next, this.filter()),
      {
        busy: this.searching,
        error: this.error,
        destroyRef: this.destroyRef,
      },
    ).subscribe((page) => {
      this.serverHits.update((hits) => [...hits, ...page.hits]);
      this.serverNextBatch.set(page.nextBatch);
    });
  }

  loadOlderHistory(): void {
    runWithBusy(this.search.loadOlder(), {
      busy: this.loadingHistory,
      error: this.error,
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
    this.cancelServer();
    this.resetServer();
  }

  setSender(sender: SenderFilter | null): void {
    this.sender.set(sender);
  }

  /** A result's time: the clock for today and yesterday, the weekday within a week. */
  protected timeOf(ts: number): string {
    switch (resultTimeStyle(ts, Date.now())) {
      case 'time':
        return this.fmt.time(ts);
      case 'weekday':
        return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
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
    const lower = snippet.toLowerCase();
    const needle = term.toLowerCase();
    let from = 0;
    let at = lower.indexOf(needle, from);
    while (at >= 0) {
      if (at > from) {
        parts.push({ text: snippet.slice(from, at), match: false });
      }
      parts.push({ text: snippet.slice(at, at + needle.length), match: true });
      from = at + needle.length;
      at = lower.indexOf(needle, from);
    }
    if (from < snippet.length) {
      parts.push({ text: snippet.slice(from), match: false });
    }
    return parts;
  }

  readonly initialOf = initialOf;

  /** Only the latest server request may write results; `runWithBusy` also bounds it to the component. */
  private inFlight: Subscription | null = null;

  private cancelServer(): void {
    this.inFlight?.unsubscribe();
    this.inFlight = null;
  }

  private resetServer(): void {
    this.serverMode.set(false);
    this.serverHits.set([]);
    this.serverNextBatch.set(null);
    this.serverCount.set(0);
  }
}
