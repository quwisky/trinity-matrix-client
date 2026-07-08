import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { HlmInput } from '@trinity/helm/input';
import {
  GIF_PROVIDERS,
  GifService,
  GifSettingsService,
  type GifResult,
} from '@trinity/data-access-gif';
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
  imports: [HlmInput, GifThumbComponent],
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

  /** Attribution line the active provider's terms require us to display. */
  readonly attribution = computed(
    () =>
      GIF_PROVIDERS.find((p) => p.id === this.settings.provider())
        ?.attribution ?? '',
  );

  constructor() {
    // The initial '' emission loads trending; each edit debounces into a search.
    toObservable(this.query)
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        distinctUntilChanged(),
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
}
