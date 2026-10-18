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
import { SidePanelHeaderComponent } from '../side-panel/side-panel-header.component';
import { DateTimeFormatService } from '@trinity/platform-native';
import {
  type LoadedMessageSearch,
  type MessageHit,
  ConversationRuntime,
} from '@trinity/data-access/timeline';
import { initialOf } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';
import {
  BannerComponent,
  EmptyStateComponent,
} from '@trinity/components/generic-content';
import { AvatarComponent } from '@trinity/components/generic-content';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { releaseInputTargetOnDestroy } from '@trinity/components/overlay';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { TrnIconComponent } from '@trinity/components/foundations';
import { UnencryptedMarkComponent } from '../shared/unencrypted-mark/unencrypted-mark.component';

/** One run of highlighting: a snippet slice and whether it is the matched term. */
interface HighlightPart {
  text: string;
  match: boolean;
}

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
    SidePanelHeaderComponent,
    BannerComponent,
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
  private readonly conversations = inject(ConversationRuntime);
  private readonly search = this.conversations.search;
  private readonly timeline = this.conversations.timeline;
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
      untracked(() => {
        this.cancelServer();
        this.resetServer();
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
  readonly dismissed = output<void>();

  readonly query = model('');

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
    return this.search.searchLoaded(this.query());
  });

  readonly encrypted = computed(() => this.loaded().encrypted);
  readonly scanned = computed(() => this.loaded().scanned);

  readonly results = computed<readonly MessageHit[]>(() =>
    this.serverMode() ? this.serverHits() : this.loaded().hits,
  );

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
  }

  searchServer(): void {
    const term = this.query().trim();
    if (!term) {
      return;
    }
    this.cancelServer();
    this.serverMode.set(true);
    this.inFlight = runWithBusy(this.search.searchServer(term), {
      busy: this.searching,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe((page) => {
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
    this.inFlight = runWithBusy(this.search.searchServer(term, next), {
      busy: this.searching,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe((page) => {
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
    this.selected.emit(hit.eventId);
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
