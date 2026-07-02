import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewChild,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular/standalone';
import {
  SearchService,
  TimelineService,
  type LoadedMessageSearch,
  type MessageHit,
} from '@trinity/core';
import { AvatarComponent, runWithBusy } from '@trinity/ui';
import { addIcons } from 'ionicons';
import { lockClosed, serverOutline } from 'ionicons/icons';

/** One run of highlighting: a snippet slice and whether it is the matched term. */
interface HighlightPart {
  text: string;
  match: boolean;
}

/**
 * In-room message search, presented as an Ionic modal from the room header (parallel
 * to the threads list). Scoped to the active room's `roomId` (a signal input from
 * `componentProps`). Injects {@link SearchService} + {@link TimelineService} directly
 * so the matching logic stays in core and nothing is threaded through props.
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
 * Selecting a result dismisses with its event id; `RoomsPage` jumps the timeline to it.
 */
@Component({
  selector: 'trn-message-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonSearchbar,
    IonList,
    IonItem,
    IonLabel,
    IonIcon,
    IonSpinner,
    AvatarComponent,
  ],
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>Search messages</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="dismiss()">Cancel</ion-button>
        </ion-buttons>
      </ion-toolbar>
      <ion-toolbar>
        <ion-searchbar
          [debounce]="0"
          placeholder="Search this conversation"
          autocapitalize="off"
          autocorrect="off"
          inputmode="text"
          (ionInput)="onInput($event)"
          (keydown.escape)="dismiss()"
        />
      </ion-toolbar>
    </ion-header>

    <ion-content>
      @if (encrypted()) {
        <div class="ms-banner" data-testid="e2ee-note">
          <ion-icon name="lock-closed" aria-hidden="true" />
          <span>
            Encrypted room — searching the {{ scanned() }} loaded
            {{ scanned() === 1 ? 'message' : 'messages' }} only.
          </span>
          <ion-button
            size="small"
            fill="outline"
            [disabled]="loadingHistory()"
            (click)="loadOlderHistory()"
            data-testid="load-older"
          >
            @if (loadingHistory()) {
              <ion-spinner name="dots" slot="start" aria-hidden="true" />
            }
            Load older messages
          </ion-button>
        </div>
      } @else if (query().trim()) {
        <div class="ms-banner">
          @if (serverMode()) {
            <span data-testid="server-summary">
              Showing {{ serverCount() }} server
              {{ serverCount() === 1 ? 'result' : 'results' }} from the full
              history.
            </span>
          } @else {
            <ion-button
              size="small"
              fill="outline"
              [disabled]="searching()"
              (click)="searchServer()"
              data-testid="search-server"
            >
              @if (searching()) {
                <ion-spinner name="dots" slot="start" aria-hidden="true" />
              } @else {
                <ion-icon
                  name="server-outline"
                  slot="start"
                  aria-hidden="true"
                />
              }
              Search all messages
            </ion-button>
          }
        </div>
      }

      <ion-list>
        @for (hit of results(); track hit.eventId) {
          <ion-item button (click)="select(hit)" data-testid="result">
            <trn-avatar
              slot="start"
              [mxc]="hit.senderAvatarMxc"
              [initial]="initialOf(hit.senderName)"
              [name]="hit.senderName"
              [size]="36"
            />
            <ion-label>
              <h2>
                {{ hit.senderName }}
                <span class="ms-time">{{ formatTime(hit.ts) }}</span>
              </h2>
              <p class="ms-snippet">
                @for (part of highlight(hit.snippet); track $index) {
                  @if (part.match) {
                    <mark>{{ part.text }}</mark>
                  } @else {
                    <span>{{ part.text }}</span>
                  }
                }
              </p>
            </ion-label>
          </ion-item>
        } @empty {
          <div class="ms-empty" aria-live="polite">
            <span class="text-muted-foreground text-xs">{{ emptyHint() }}</span>
          </div>
        }
      </ion-list>

      @if (serverMode() && serverNextBatch()) {
        <div class="ms-more">
          <ion-button
            size="small"
            fill="clear"
            [disabled]="searching()"
            (click)="loadMoreServer()"
            data-testid="load-more-server"
          >
            @if (searching()) {
              <ion-spinner name="dots" slot="start" aria-hidden="true" />
            }
            Load more results
          </ion-button>
        </div>
      }
    </ion-content>
  `,
  styleUrl: './message-search.component.scss',
})
export class MessageSearchComponent {
  private readonly search = inject(SearchService);
  private readonly timeline = inject(TimelineService);
  private readonly modalCtrl = inject(ModalController);
  private readonly destroyRef = inject(DestroyRef);

  /** Active room, populated from `componentProps` (app sets `useSetInputAPI`). */
  readonly roomId = input.required<string>();

  @ViewChild(IonSearchbar) private readonly searchbar?: IonSearchbar;

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

  constructor() {
    addIcons({ lockClosed, serverOutline });
  }

  /** Autofocus the field once the modal has finished presenting. */
  ionViewDidEnter(): void {
    void this.searchbar?.setFocus();
  }

  onInput(event: Event): void {
    const value =
      (event as CustomEvent<{ value: string | null }>).detail?.value ?? '';
    this.query.set(value);
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

  /** Click on a row: dismiss with the matched event id for the page to jump to. */
  select(hit: MessageHit): void {
    void this.modalCtrl.dismiss(hit.eventId);
  }

  /** Cancel / Escape: dismiss without a selection. */
  dismiss(): void {
    void this.modalCtrl.dismiss(null);
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

  formatTime(ts: number): string {
    return new Date(ts).toLocaleString(undefined, {
      year: '2-digit',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private resetServer(): void {
    this.serverMode.set(false);
    this.serverHits.set([]);
    this.serverNextBatch.set(null);
    this.serverCount.set(0);
  }
}
