import { type DestroyRef, signal } from '@angular/core';
import { type Observable, type Subscription } from 'rxjs';
import type {
  MessageHit,
  MessageSearchFilter,
  ServerMessageSearch,
} from '@trinity/data-access/timeline';
import { matrixRequestErrorHandling } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';

type SearchPage = (
  term: string,
  nextBatch: string | undefined,
  filter: MessageSearchFilter,
) => Observable<ServerMessageSearch>;

/**
 * The homeserver's full-text search for one search panel: the pages loaded so far, the
 * approximate count, and whether a request is running or failed. Only the latest request may
 * write results, and `runWithBusy` also ends it with the panel.
 */
export class ServerSearch {
  readonly active = signal(false);
  readonly hits = signal<readonly MessageHit[]>([]);
  readonly nextBatch = signal<string | null>(null);
  /** The homeserver's count, made before it filters senders: approximate. */
  readonly count = signal(0);
  readonly searching = signal(false);
  /** Plain-language failure for the last request, or null. */
  readonly error = signal<string | null>(null);

  private inFlight: Subscription | null = null;
  private last: {
    readonly term: string;
    readonly filter: MessageSearchFilter;
    readonly more: boolean;
  } | null = null;

  constructor(
    private readonly page: SearchPage,
    private readonly destroyRef: DestroyRef,
    /** The homeserver refused because the room is encrypted. */
    private readonly onEncrypted: () => void,
  ) {}

  /** Search from the first page. The instant results stay up until the homeserver answers. */
  run(term: string, filter: MessageSearchFilter): void {
    if (!term) return;
    this.cancel();
    this.last = { term, filter, more: false };
    this.inFlight = this.request(term, undefined, filter).subscribe((page) => {
      if (page.encrypted) {
        this.onEncrypted();
        return;
      }
      this.active.set(true);
      this.hits.set(page.hits);
      this.count.set(page.count);
      this.nextBatch.set(page.nextBatch);
    });
  }

  /** Append the next page of the last search. */
  more(): void {
    const next = this.nextBatch();
    const last = this.last;
    if (!next || !last) return;
    this.cancel();
    this.last = { ...last, more: true };
    this.inFlight = this.request(last.term, next, last.filter).subscribe(
      (page) => {
        this.hits.update((hits) => [...hits, ...page.hits]);
        this.nextBatch.set(page.nextBatch);
      },
    );
  }

  /** Repeat the request that failed. */
  retry(): void {
    const last = this.last;
    if (!last) return;
    if (last.more) this.more();
    else this.run(last.term, last.filter);
  }

  cancel(): void {
    this.inFlight?.unsubscribe();
    this.inFlight = null;
  }

  /** Forget every page, and any failure: the search it belonged to has changed. */
  reset(): void {
    this.cancel();
    this.last = null;
    this.active.set(false);
    this.hits.set([]);
    this.nextBatch.set(null);
    this.count.set(0);
    this.error.set(null);
  }

  private request(
    term: string,
    nextBatch: string | undefined,
    filter: MessageSearchFilter,
  ): Observable<ServerMessageSearch> {
    return runWithBusy(
      this.page(term, nextBatch, filter),
      { busy: this.searching, error: this.error, destroyRef: this.destroyRef },
      matrixRequestErrorHandling(
        'search messages',
        'Couldn’t search the homeserver. Try again.',
      ),
    );
  }
}
