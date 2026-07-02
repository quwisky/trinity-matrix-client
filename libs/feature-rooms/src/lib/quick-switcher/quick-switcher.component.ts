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
import { IonIcon } from '@ionic/angular/standalone';
import {
  SearchService,
  type SwitcherKind,
  type SwitcherResult,
  type SwitcherSelection,
} from '@trinity/core';
import { AvatarComponent } from '@trinity/ui';
import {
  DialogRef,
  HlmButton,
  TrnInputDirective,
  TrnSpinnerComponent,
} from '@trinity/ui-spartan';
import { addIcons } from 'ionicons';
import {
  chatbubbleOutline,
  lockClosed,
  mailOutline,
  peopleOutline,
  personOutline,
} from 'ionicons/icons';
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

/** Trailing ionicon per kind. */
const KIND_ICON: Record<SwitcherKind, string> = {
  room: 'chatbubble-outline',
  space: 'people-outline',
  dm: 'person-outline',
  invite: 'mail-outline',
  user: 'person-outline',
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
  imports: [
    IonIcon,
    AvatarComponent,
    TrnSpinnerComponent,
    HlmButton,
    TrnInputDirective,
  ],
  template: `
    <div
      class="flex h-[60vh] max-h-[70vh] w-[92vw] max-w-[560px] flex-col overflow-hidden rounded-xl border border-solid border-border bg-card text-card-foreground shadow-lg"
    >
      <div
        class="flex items-center gap-2 border-b border-solid border-border p-3"
      >
        <h2 class="flex-1 text-base font-semibold">Jump to…</h2>
        <button hlmBtn variant="ghost" size="sm" (click)="dismiss(null)">
          Cancel
        </button>
      </div>

      <div class="border-b border-solid border-border p-3">
        <input
          #searchInput
          trnInput
          placeholder="Search rooms, spaces, people"
          autocapitalize="off"
          autocorrect="off"
          inputmode="text"
          [value]="query()"
          (input)="onInput($event)"
          (keydown.arrowDown)="move(1, $event)"
          (keydown.arrowUp)="move(-1, $event)"
          (keydown.enter)="choose($event)"
          (keydown.escape)="dismiss(null)"
        />
      </div>

      <div class="flex-1 overflow-y-auto p-2">
        @for (
          result of results();
          track result.kind + result.id;
          let i = $index
        ) {
          <button
            type="button"
            class="qs-row flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-accent"
            [class.bg-accent]="i === highlight()"
            (click)="select(result)"
          >
            <trn-avatar
              [mxc]="result.avatarMxc"
              [initial]="result.initial"
              [name]="result.title"
              [size]="40"
              [square]="result.kind === 'space'"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{
                result.title
              }}</span>
              @if (result.subtitle) {
                <span class="block truncate text-xs text-muted-foreground">{{
                  result.subtitle
                }}</span>
              }
            </span>
            @if (result.encrypted) {
              <ion-icon
                class="qs-lock"
                name="lock-closed"
                aria-label="Encrypted"
              />
            }
            <ion-icon
              class="qs-kind"
              [name]="kindIcon(result.kind)"
              [attr.aria-label]="kindLabel(result.kind)"
            />
            <span class="text-muted-foreground text-xs">{{
              kindLabel(result.kind)
            }}</span>
          </button>
        } @empty {
          <div class="qs-empty" aria-live="polite">
            @if (searching()) {
              <trn-spinner />
            } @else {
              <span class="text-muted-foreground text-xs">{{
                emptyHint()
              }}</span>
            }
          </div>
        }
      </div>
    </div>
  `,
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
    addIcons({
      chatbubbleOutline,
      lockClosed,
      mailOutline,
      peopleOutline,
      personOutline,
    });
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
