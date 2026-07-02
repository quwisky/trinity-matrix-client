import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
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
  catchError,
  debounceTime,
  distinctUntilChanged,
  finalize,
  map,
  of,
  switchMap,
} from 'rxjs';
import {
  RoomsService,
  isValidUserId,
  type UserSearchResult,
} from '@trinity/core';
import { AvatarComponent } from '@trinity/ui';

/** Don't hit the directory until the term is at least this long. */
const MIN_SEARCH_LENGTH = 2;

/**
 * Modal user picker for the invite and DM flows. Combines a free-text Matrix-ID
 * field (the always-available minimum — the Confirm action accepts a typed
 * `@user:server`) with live homeserver user-directory results below it. Presented
 * by {@link UserPickerService}; on a pick it dismisses with the chosen MXID, and on
 * cancel with `null` — it never creates or invites itself, so the page stays the
 * orchestrator (matching the AlertController prompts in `RoomsPage`).
 *
 * Config (heading / confirm label / placeholder) arrives through `componentProps`
 * as signal inputs (the app enables Ionic's set-input API). matrix-js-sdk is reached
 * only through {@link RoomsService.searchUsers}.
 */
@Component({
  selector: 'trn-user-picker',
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
    IonSpinner,
    AvatarComponent,
  ],
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-button (click)="cancel()">Cancel</ion-button>
        </ion-buttons>
        <ion-title>{{ title() }}</ion-title>
        <ion-buttons slot="end">
          <ion-button
            [strong]="true"
            [disabled]="!canConfirm()"
            (click)="confirmTyped()"
          >
            {{ confirmLabel() }}
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
      <ion-toolbar>
        <ion-searchbar
          [placeholder]="placeholder()"
          [debounce]="0"
          autocapitalize="off"
          autocorrect="off"
          inputmode="text"
          (ionInput)="onInput($event)"
        />
      </ion-toolbar>
    </ion-header>

    <ion-content>
      @if (searching()) {
        <div class="picker-status" aria-live="polite">
          <ion-spinner name="dots" aria-label="Searching" />
        </div>
      }

      <ion-list>
        @for (user of results(); track user.userId) {
          <ion-item button (click)="choose(user.userId)">
            <trn-avatar
              slot="start"
              [mxc]="user.avatarMxc"
              [initial]="initialOf(user.displayName)"
              [name]="user.displayName"
              [size]="36"
            />
            <ion-label>
              <h2>{{ user.displayName }}</h2>
              <p>{{ user.userId }}</p>
            </ion-label>
          </ion-item>
        } @empty {
          @if (!searching()) {
            <div class="picker-empty">
              <span class="text-muted-foreground text-xs">{{
                emptyHint()
              }}</span>
            </div>
          }
        }
      </ion-list>
    </ion-content>
  `,
  styleUrl: './user-picker.component.scss',
})
export class UserPickerComponent {
  private readonly modalCtrl = inject(ModalController);
  private readonly rooms = inject(RoomsService);

  /** Modal heading (e.g. "Start a direct message"). */
  readonly title = input('Find people');
  /** Confirm-button label for the typed-MXID path (e.g. "Invite"). */
  readonly confirmLabel = input('Select');
  /** Searchbar placeholder. */
  readonly placeholder = input('@user:server or a name');

  /** Current free-text term, driving both validation and the live search. */
  readonly term = signal('');
  /** A directory request is in flight (drives the spinner). */
  readonly searching = signal(false);

  /** Whether the typed term is a complete MXID, so Confirm can act on it as-is. */
  readonly canConfirm = computed(() => isValidUserId(this.term()));

  /** Contextual empty-state copy: idle, too-short, or genuinely no matches. */
  readonly emptyHint = computed(() => {
    const term = this.term().trim();
    if (!term) {
      return 'Search by name, or type a full Matrix ID like @alice:example.org.';
    }
    if (term.length < MIN_SEARCH_LENGTH) {
      return 'Keep typing to search the directory.';
    }
    return this.canConfirm()
      ? 'No directory matches — Confirm to use this Matrix ID.'
      : 'No matches. Type a full Matrix ID like @alice:example.org.';
  });

  /** Live directory results for the current term (empty while too short). */
  readonly results = toSignal(
    toObservable(this.term).pipe(
      map((term) => term.trim()),
      debounceTime(250),
      distinctUntilChanged(),
      switchMap((term) => {
        if (term.length < MIN_SEARCH_LENGTH) {
          return of<UserSearchResult[]>([]);
        }
        this.searching.set(true);
        return this.rooms.searchUsers(term).pipe(
          // Search is best-effort; a failure shows the empty state, not an error.
          catchError(() => of<UserSearchResult[]>([])),
          finalize(() => this.searching.set(false)),
        );
      }),
    ),
    { initialValue: [] as UserSearchResult[] },
  );

  onInput(event: Event): void {
    const value =
      (event as CustomEvent<{ value: string | null }>).detail?.value ?? '';
    this.term.set(value);
  }

  /** Pick a directory result. */
  choose(userId: string): void {
    void this.modalCtrl.dismiss(userId);
  }

  /** Confirm the typed MXID (enabled only when it's a valid `@user:server`). */
  confirmTyped(): void {
    if (this.canConfirm()) {
      void this.modalCtrl.dismiss(this.term().trim());
    }
  }

  cancel(): void {
    void this.modalCtrl.dismiss(null);
  }

  /** First visible character (sans sigil), uppercased, for the avatar fallback. */
  initialOf(name: string): string {
    const stripped = name.replace(/^[#@!]+/, '').trim();
    return (stripped[0] ?? '?').toUpperCase();
  }
}
