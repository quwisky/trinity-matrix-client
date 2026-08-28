import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DateTimeFormatService } from '@trinity/platform-native';
import {
  SearchService,
  type LoadedMessageSearch,
  type MessageHit,
} from '@trinity/data-access/search';
import { TimelineService } from '@trinity/data-access/timeline';
import { runWithBusy } from '@trinity/util/ui';
import { EmptyStateComponent } from '@trinity/components/empty-state';
import { AvatarComponent } from '@trinity/components/avatar';
import { TrnButton } from '@trinity/components/button';
import { TrnInput } from '@trinity/components/input';
import { TrnSpinnerComponent } from '@trinity/components/spinner';
import { TrnIconComponent } from '@trinity/components/icon';

/** One run of highlighting: a snippet slice and whether it is the matched term. */
interface HighlightPart {
  text: string;
  match: boolean;
}

/**
 * In-room message search, presented from the room header (parallel to the threads
 * list) in the rooms shell's right-hand panel slot. Scoped to the active room's
 * `roomId`, a signal input the host binds. Injects {@link SearchService} +
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
 * Presentational: it owns no panel state. Selecting a result emits {@link selected}
 * with the matched event id and closing emits {@link dismissed}; the host owns the
 * slot and decides what to do (jump the timeline, close the panel).
 *
 * The query field is focused when the panel appears, by this component.
 *
 * That used to be CDK's job: search was a dialog, and `TrnDialogService` was passed
 * `autoFocus: '[data-autofocus]'`. Rendered inline in the shell's panel slot there is no CDK
 * focus pass, so without the call below opening search would leave focus wherever it was and
 * a keyboard user would have to tab into the field they just asked for. The marker attribute
 * stays as the selector, so there is still one definition of "the field to focus".
 *
 * The original comment here warned that a `focus()` in the component would be overridden by
 * CDK's pass — true then, and the reason the call did not exist. It is exactly inverted now.
 */
@Component({
  selector: 'trn-message-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyStateComponent,
    TrnIconComponent,
    AvatarComponent,
    TrnSpinnerComponent,
    TrnButton,
    TrnInput,
  ],
  templateUrl: './message-search.component.html',
  styleUrl: './message-search.component.scss',
})
export class MessageSearchComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);
  private readonly search = inject(SearchService);
  private readonly timeline = inject(TimelineService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly queryField =
    viewChild<ElementRef<HTMLInputElement>>('queryField');

  constructor() {
    // After the first render, not on construction: the input does not exist yet at
    // construction time, and `afterNextRender` is the zoneless-safe hook for reaching into
    // the DOM once.
    afterNextRender(() => this.queryField()?.nativeElement.focus());
  }

  /** Active room the search is scoped to, bound by whoever hosts the panel. */
  readonly roomId = input.required<string>();

  /** The user picked a result: the matched event id, for the host to jump to. */
  readonly selected = output<string>();
  /** The user closed search without picking a result. */
  readonly dismissed = output<void>();

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

  /** Click on a row: announce the matched event id for the host to jump to. */
  select(hit: MessageHit): void {
    this.selected.emit(hit.eventId);
  }

  /** Cancel / Escape: announce the close without a selection. */
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
