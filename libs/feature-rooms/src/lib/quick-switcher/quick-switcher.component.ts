import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
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
  type SwitcherKind,
  type SwitcherResult,
  type SwitcherSelection,
} from '@trinity/core';
import { AvatarComponent } from '@trinity/ui';
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
 * Presented by {@link QuickSwitcherService}; injects {@link SearchService} directly so
 * the aggregation stays in core and nothing is threaded through `componentProps`.
 *
 * Local matches are an instant `computed` over the query signal; people are a
 * debounced RxJS stream. Keyboard nav (Up/Down move, Enter select, Esc close) lives on
 * the searchbar host. On a pick it dismisses with the chosen {@link SwitcherSelection},
 * leaving the actual navigation to `RoomsPage`.
 */
@Component({
  selector: 'trn-quick-switcher',
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
        <ion-title>Jump to…</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="dismiss(null)">Cancel</ion-button>
        </ion-buttons>
      </ion-toolbar>
      <ion-toolbar>
        <ion-searchbar
          [debounce]="0"
          placeholder="Search rooms, spaces, people"
          autocapitalize="off"
          autocorrect="off"
          inputmode="text"
          (ionInput)="onInput($event)"
          (keydown.arrowDown)="move(1, $event)"
          (keydown.arrowUp)="move(-1, $event)"
          (keydown.enter)="choose($event)"
          (keydown.escape)="dismiss(null)"
        />
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <ion-list>
        @for (
          result of results();
          track result.kind + result.id;
          let i = $index
        ) {
          <ion-item
            button
            [class.qs-row--active]="i === highlight()"
            (click)="select(result)"
          >
            <trn-avatar
              slot="start"
              [mxc]="result.avatarMxc"
              [initial]="result.initial"
              [name]="result.title"
              [size]="40"
              [square]="result.kind === 'space'"
            />
            <ion-label>
              <h2>{{ result.title }}</h2>
              @if (result.subtitle) {
                <p>{{ result.subtitle }}</p>
              }
            </ion-label>
            @if (result.encrypted) {
              <ion-icon
                slot="end"
                class="qs-lock"
                name="lock-closed"
                aria-label="Encrypted"
              />
            }
            <ion-icon
              slot="end"
              class="qs-kind"
              [name]="kindIcon(result.kind)"
              [attr.aria-label]="kindLabel(result.kind)"
            />
            <span slot="end" class="text-muted-foreground text-xs">{{
              kindLabel(result.kind)
            }}</span>
          </ion-item>
        } @empty {
          <div class="qs-empty" aria-live="polite">
            @if (searching()) {
              <ion-spinner name="dots" aria-label="Searching" />
            } @else {
              <span class="text-muted-foreground text-xs">{{
                emptyHint()
              }}</span>
            }
          </div>
        }
      </ion-list>
    </ion-content>
  `,
  styleUrl: './quick-switcher.component.scss',
})
export class QuickSwitcherComponent {
  private readonly modalCtrl = inject(ModalController);
  private readonly search = inject(SearchService);

  @ViewChild(IonSearchbar) private readonly searchbar?: IonSearchbar;

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
  }

  /** Autofocus the field once the modal has finished presenting. */
  ionViewDidEnter(): void {
    void this.searchbar?.setFocus();
  }

  onInput(event: Event): void {
    const value =
      (event as CustomEvent<{ value: string | null }>).detail?.value ?? '';
    this.query.set(value);
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

  /** Click/Enter on a row: dismiss with its selection. */
  select(result: SwitcherResult): void {
    this.dismiss({ kind: result.kind, id: result.id });
  }

  dismiss(selection: SwitcherSelection | null): void {
    void this.modalCtrl.dismiss(selection);
  }

  kindLabel(kind: SwitcherKind): string {
    return KIND_LABEL[kind];
  }

  kindIcon(kind: SwitcherKind): string {
    return KIND_ICON[kind];
  }
}
