import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { DateTimeFormatService } from '@trinity/platform-native';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLock, lucideServer, lucideX } from '@ng-icons/lucide';
import {
  SearchService,
  type LoadedMessageSearch,
  type MessageHit,
} from '@trinity/data-access-search';
import { TimelineService } from '@trinity/data-access-timeline';
import { AvatarComponent, runWithBusy } from '@trinity/ui';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { HlmSpinner } from '@trinity/helm/spinner';

/** One run of highlighting: a snippet slice and whether it is the matched term. */
interface HighlightPart {
  text: string;
  match: boolean;
}

/**
 * In-room message search, presented from the room header (parallel to the threads
 * list) by {@link MessageSearchService} as a full-height, right-aligned
 * {@link TrnDialogService} side panel. Scoped to the active room's `roomId` (a signal
 * input set from the dialog's `inputs`). Injects {@link SearchService} +
 * {@link TimelineService} directly so the matching logic stays in core and nothing is
 * threaded through props.
 *
 * E2EE-honest by construction:
 *  - The instant results come from {@link SearchService.searchLoadedMessages}, over the
 *    already-loaded, *decrypted* timeline — recomputed reactively by reading
 *    `TimelineService.messages()`, so decryption + scrollback re-run the search.
 *  - For an **encrypted** room that's the only path: a lock banner states it covers the
 *    loaded messages only, with a "Load older messages" affordance to widen it.
 *  - For an **unencrypted** room a "Search all messages" button runs the homeserver
 *    full-text search ({@link SearchService.searchServerMessages}) over the whole
 *    history, paged via `next_batch`.
 *
 * Selecting a result closes with its event id; `RoomsPage` jumps the timeline to it.
 * The query field takes focus on open through the dialog's `autoFocus` selector (see
 * {@link MessageSearchService}) — CDK focuses after attach, so anything the component
 * focuses itself is immediately overridden.
 */
@Component({
  selector: 'trn-message-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, AvatarComponent, HlmSpinner, HlmButton, HlmInput],
  viewProviders: [provideIcons({ lucideLock, lucideServer, lucideX })],
  templateUrl: './message-search.component.html',
  styleUrl: './message-search.component.scss',
})
export class MessageSearchComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);
  private readonly search = inject(SearchService);
  private readonly timeline = inject(TimelineService);
  private readonly dialogRef =
    inject<DialogRef<string | null, MessageSearchComponent>>(DialogRef);
  private readonly destroyRef = inject(DestroyRef);

  /** Active room, populated from the dialog's `inputs` (app sets `useSetInputAPI`). */
  readonly roomId = input.required<string>();

  /** Current query text. */
  readonly query = signal('');

  /** Whether the server (full-history) results are being shown instead of loaded. */
  readonly serverMode = signal(false);
  private readonly serverHits = signal<MessageHit[]>([]);
  /** Token for the next page of server results, or null when exhausted. */
  readonly serverNextBatch = signal<string | null>(null);
  /** Total server-reported match count. */
  readonly serverCount = signal(0);
  /** A server search / load-more is in flight. */
  readonly searching = signal(false);
  /** A "load older history" scrollback is in flight (encrypted rooms). */
  readonly loadingHistory = signal(false);
  /** Last server/history failure message (swallowed by runWithBusy). */
  private readonly error = signal<string | null>(null);

  /**
   * Instant client-side results over the loaded, decrypted timeline. Reading
   * `timeline.messages()` makes this recompute on new events, async decryption, and
   * after a scrollback — without the component touching matrix-js-sdk directly.
   */
  private readonly loaded = computed<LoadedMessageSearch>(() => {
    this.timeline.messages();
    return this.search.searchLoadedMessages(this.roomId(), this.query());
  });

  readonly encrypted = computed(() => this.loaded().encrypted);
  readonly scanned = computed(() => this.loaded().scanned);

  /** The rows to show: server results when in server mode, else the loaded matches. */
  readonly results = computed<MessageHit[]>(() =>
    this.serverMode() ? this.serverHits() : this.loaded().hits,
  );

  /** Contextual empty-state copy. */
  readonly emptyHint = computed(() => {
    if (!this.query().trim()) {
      return 'Type to search messages in this conversation.';
    }
    if (this.searching()) {
      return 'Searching…';
    }
    return 'No matching messages.';
  });

  onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    // A changed query invalidates any server results; fall back to instant local.
    this.resetServer();
  }

  /** Run the homeserver full-text search over the whole (unencrypted) history. */
  searchServer(): void {
    const term = this.query().trim();
    if (!term) {
      return;
    }
    this.serverMode.set(true);
    runWithBusy(this.search.searchServerMessages(this.roomId(), term), {
      busy: this.searching,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe((page) => {
      this.serverHits.set(page.hits);
      this.serverCount.set(page.count);
      this.serverNextBatch.set(page.nextBatch);
    });
  }

  /** Append the next page of server results. */
  loadMoreServer(): void {
    const term = this.query().trim();
    const next = this.serverNextBatch();
    if (!term || !next) {
      return;
    }
    runWithBusy(this.search.searchServerMessages(this.roomId(), term, next), {
      busy: this.searching,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe((page) => {
      this.serverHits.update((hits) => [...hits, ...page.hits]);
      this.serverNextBatch.set(page.nextBatch);
    });
  }

  /** Page in older history so the instant (loaded) search can see more of it. */
  loadOlderHistory(): void {
    runWithBusy(this.search.loadMoreHistory(this.roomId()), {
      busy: this.loadingHistory,
      error: this.error,
      destroyRef: this.destroyRef,
      // The `loaded` computed re-runs when TimelineService.messages() updates after
      // the scrollback, so no manual re-search is needed.
    }).subscribe();
  }

  /** Click on a row: close with the matched event id for the page to jump to. */
  select(hit: MessageHit): void {
    this.dialogRef.close(hit.eventId);
  }

  /** Cancel / Escape: close without a selection. */
  dismiss(): void {
    this.dialogRef.close(null);
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

  initialOf(name: string): string {
    const stripped = name.replace(/^[#@!]+/, '').trim();
    return (stripped[0] ?? '?').toUpperCase();
  }

  private resetServer(): void {
    this.serverMode.set(false);
    this.serverHits.set([]);
    this.serverNextBatch.set(null);
    this.serverCount.set(0);
  }
}
