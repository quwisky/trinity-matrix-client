import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  Subject,
  catchError,
  debounceTime,
  distinctUntilChanged,
  map,
  merge,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import {
  GIF_PROVIDERS,
  GifService,
  GifSettingsService,
  type GifResult,
} from '@trinity/data-access/gif';
import { GifThumbComponent } from './gif-thumb.component';

/** Delay between the last keystroke and firing a search request. */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * GIF search grid floated above the composer. Loads trending GIFs on open and
 * re-queries (debounced) as the user types, emitting the chosen GIF for the
 * composer to download and send. Only rendered once a provider + API key are
 * configured, so it never queries without credentials.
 */
@Component({
  selector: 'trn-gif-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnInput, GifThumbComponent],
  templateUrl: './gif-picker.component.html',
  styleUrl: './gif-picker.component.scss',
})
export class GifPickerComponent {
  /** The user picked a GIF; the composer downloads it and sends it as media. */
  readonly gifSelect = output<GifResult>();

  readonly query = signal('');
  readonly results = signal<GifResult[]>([]);
  readonly loading = signal(true);
  readonly failed = signal(false);

  private readonly gifs = inject(GifService);
  private readonly settings = inject(GifSettingsService);
  private readonly searchInput =
    viewChild<ElementRef<HTMLInputElement>>('searchInput');

  /** Fires when the user asks to retry after a load failure. */
  private readonly retry$ = new Subject<void>();

  /** Attribution line the active provider's terms require us to display. */
  readonly attribution = computed(
    () =>
      GIF_PROVIDERS.find((p) => p.id === this.settings.provider())
        ?.attribution ?? '',
  );

  constructor() {
    // Opening the picker is a focus transfer from the composer's mobile action sheet.
    afterNextRender(() => this.searchInput()?.nativeElement.focus());

    // The initial '' emission loads trending; each edit debounces into a search.
    const typed$ = toObservable(this.query).pipe(
      debounceTime(SEARCH_DEBOUNCE_MS),
      distinctUntilChanged(),
    );
    // Retry re-runs the current query at once, bypassing distinctUntilChanged so a
    // failed search for the same text can be tried again.
    const retried$ = this.retry$.pipe(map(() => this.query()));
    merge(typed$, retried$)
      .pipe(
        tap(() => {
          this.loading.set(true);
          this.failed.set(false);
        }),
        switchMap((q) =>
          this.gifs.search(q).pipe(
            catchError(() => {
              this.failed.set(true);
              return of<GifResult[]>([]);
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((results) => {
        this.results.set(results);
        this.loading.set(false);
      });
  }

  onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /** Re-run the current query after a load failure (the "Try again" button). */
  retry(): void {
    this.retry$.next();
  }
}
