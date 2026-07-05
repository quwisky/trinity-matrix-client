import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideLock,
  lucideMail,
  lucideMessageSquare,
  lucideUser,
  lucideUsers,
} from '@ng-icons/lucide';
import {
  SearchService,
  type SwitcherKind,
  type SwitcherResult,
  type SwitcherSelection,
} from '@trinity/data-access-search';
import { AvatarComponent } from '@trinity/ui';
import { DialogRef } from '@trinity/helm/overlay';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { HlmSpinner } from '@trinity/helm/spinner';
import {
  debounceTime,
  distinctUntilChanged,
  finalize,
  map,
  of,
  switchMap,
} from 'rxjs';

/** Debounce window for the networked directory lookup (the local list is instant). */
const PEOPLE_DEBOUNCE_MS = 250;

/** Human-readable kind hint shown at the trailing edge of a result row. */
const KIND_LABEL: Record<SwitcherKind, string> = {
  room: 'Room',
  space: 'Space',
  dm: 'Direct',
  invite: 'Invite',
  user: 'Person',
};

/** Trailing lucide icon per kind. */
const KIND_ICON: Record<SwitcherKind, string> = {
  room: 'lucideMessageSquare',
  space: 'lucideUsers',
  dm: 'lucideUser',
  invite: 'lucideMail',
  user: 'lucideUser',
};

/**
 * Quick-switcher overlay (Ctrl/Cmd+K): a single search field over joined rooms,
 * spaces, DMs, and pending invites, with debounced directory-people results appended.
 * Presented by {@link QuickSwitcherService} as a {@link TrnDialogService} dialog;
 * injects {@link SearchService} directly so the aggregation stays in core.
 *
 * Local matches are an instant `computed` over the query signal; people are a
 * debounced RxJS stream. Keyboard nav (Up/Down move, Enter select, Esc close) lives on
 * the native input. On a pick it closes with the chosen {@link SwitcherSelection},
 * leaving the actual navigation to `RoomsPage`. The card self-sizes so it works in a
 * bare CDK dialog (no `ion-modal` host).
 */
@Component({
  selector: 'trn-quick-switcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, AvatarComponent, HlmSpinner, HlmButton, HlmInput],
  viewProviders: [
    provideIcons({
      lucideLock,
      lucideMail,
      lucideMessageSquare,
      lucideUser,
      lucideUsers,
    }),
  ],
  templateUrl: './quick-switcher.component.html',
  styleUrl: './quick-switcher.component.scss',
})
export class QuickSwitcherComponent {
  private readonly dialogRef =
    inject<DialogRef<SwitcherSelection | null, QuickSwitcherComponent>>(
      DialogRef,
    );
  private readonly search = inject(SearchService);

  private readonly searchInput =
    viewChild<ElementRef<HTMLInputElement>>('searchInput');

  /** Current query text, driving both the local computed and the people stream. */
  readonly query = signal('');
  /** Index of the keyboard-highlighted row in {@link results}. */
  readonly highlight = signal(0);
  /** A directory lookup is in flight (drives the empty-state spinner). */
  readonly searching = signal(false);

  /** Instant, ranked local matches — reactive because the service reads live signals. */
  private readonly localResults = computed(() =>
    this.search.localResults(this.query()),
  );

  /** Debounced directory people, appended after the local matches. */
  private readonly people = toSignal(
    toObservable(this.query).pipe(
      map((q) => q.trim()),
      debounceTime(PEOPLE_DEBOUNCE_MS),
      distinctUntilChanged(),
      switchMap((q) => {
        if (q.length < 2) {
          this.searching.set(false);
          return of<SwitcherResult[]>([]);
        }
        this.searching.set(true);
        // finalize resets on complete, error, or switchMap cancellation.
        return this.search
          .searchPeople(q)
          .pipe(finalize(() => this.searching.set(false)));
      }),
    ),
    { initialValue: [] as SwitcherResult[] },
  );

  /** Local matches first, then directory people. */
  readonly results = computed<SwitcherResult[]>(() => [
    ...this.localResults(),
    ...this.people(),
  ]);

  /** Contextual empty-state copy. */
  readonly emptyHint = computed(() =>
    this.query().trim()
      ? 'No matches.'
      : 'Search rooms, spaces, and people — or pick a recent chat.',
  );

  constructor() {
    // Autofocus the field once the dialog has rendered.
    afterNextRender(() => this.searchInput()?.nativeElement.focus());
  }

  onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.highlight.set(0); // a fresh query re-anchors the highlight to the top
  }

  /** Move the highlight by `delta`, wrapping; stops the caret from moving. */
  move(delta: number, event: Event): void {
    event.preventDefault();
    const length = this.results().length;
    if (length === 0) {
      this.highlight.set(0);
      return;
    }
    this.highlight.update((index) => (index + delta + length) % length);
  }

  /** Enter: select the highlighted row (no-op when the list is empty). */
  choose(event: Event): void {
    event.preventDefault();
    const result = this.results()[this.highlight()];
    if (result) {
      this.select(result);
    }
  }

  /** Click/Enter on a row: close with its selection. */
  select(result: SwitcherResult): void {
    this.dismiss({ kind: result.kind, id: result.id });
  }

  dismiss(selection: SwitcherSelection | null): void {
    this.dialogRef.close(selection);
  }

  kindLabel(kind: SwitcherKind): string {
    return KIND_LABEL[kind];
  }

  kindIcon(kind: SwitcherKind): string {
    return KIND_ICON[kind];
  }
}
