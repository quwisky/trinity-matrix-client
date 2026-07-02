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
import {
  DialogRef,
  HlmButton,
  TrnInputDirective,
  TrnSpinnerComponent,
} from '@trinity/ui-spartan';

/** Don't hit the directory until the term is at least this long. */
const MIN_SEARCH_LENGTH = 2;

/**
 * Dialog user picker for the invite and DM flows. Combines a free-text Matrix-ID
 * field (the always-available minimum — the Confirm action accepts a typed
 * `@user:server`) with live homeserver user-directory results below it. Presented
 * by {@link UserPickerService} as a {@link TrnDialogService} dialog; on a pick it
 * closes with the chosen MXID, and on cancel with `null` — it never creates or
 * invites itself, so the page stays the orchestrator (matching the
 * `TrnAlertService` prompts in `RoomsPage`).
 *
 * Config (heading / confirm label / placeholder) arrives as signal inputs (set by
 * TrnDialogService). matrix-js-sdk is reached only through
 * {@link RoomsService.searchUsers}. The card self-sizes so it works in a bare CDK
 * dialog (no `ion-modal` host).
 */
@Component({
  selector: 'trn-user-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, TrnSpinnerComponent, HlmButton, TrnInputDirective],
  template: `
    <div
      class="flex h-[560px] max-h-[85vh] w-[92vw] max-w-[460px] flex-col overflow-hidden rounded-xl border border-solid border-border bg-card text-card-foreground shadow-lg"
    >
      <div
        class="flex items-center gap-2 border-b border-solid border-border p-3"
      >
        <button hlmBtn variant="ghost" size="sm" (click)="cancel()">
          Cancel
        </button>
        <h2 class="flex-1 truncate text-center text-base font-semibold">
          {{ title() }}
        </h2>
        <button
          hlmBtn
          size="sm"
          [disabled]="!canConfirm()"
          (click)="confirmTyped()"
        >
          {{ confirmLabel() }}
        </button>
      </div>

      <div class="border-b border-solid border-border p-3">
        <input
          trnInput
          [placeholder]="placeholder()"
          autocapitalize="off"
          autocorrect="off"
          inputmode="text"
          [value]="term()"
          (input)="onInput($event)"
        />
      </div>

      <div class="flex-1 overflow-y-auto p-2">
        @if (searching()) {
          <div class="picker-status" aria-live="polite"><trn-spinner /></div>
        }
        @for (user of results(); track user.userId) {
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-accent"
            (click)="choose(user.userId)"
          >
            <trn-avatar
              [mxc]="user.avatarMxc"
              [initial]="initialOf(user.displayName)"
              [name]="user.displayName"
              [size]="36"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{
                user.displayName
              }}</span>
              <span class="block truncate text-xs text-muted-foreground">{{
                user.userId
              }}</span>
            </span>
          </button>
        } @empty {
          @if (!searching()) {
            <div class="picker-empty">
              <span class="text-muted-foreground text-xs">{{
                emptyHint()
              }}</span>
            </div>
          }
        }
      </div>
    </div>
  `,
  styleUrl: './user-picker.component.scss',
})
export class UserPickerComponent {
  private readonly dialogRef =
    inject<DialogRef<string | null, UserPickerComponent>>(DialogRef);
  private readonly rooms = inject(RoomsService);

  /** Dialog heading (e.g. "Start a direct message"). */
  readonly title = input('Find people');
  /** Confirm-button label for the typed-MXID path (e.g. "Invite"). */
  readonly confirmLabel = input('Select');
  /** Search placeholder. */
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
    this.term.set((event.target as HTMLInputElement).value);
  }

  /** Pick a directory result. */
  choose(userId: string): void {
    this.dialogRef.close(userId);
  }

  /** Confirm the typed MXID (enabled only when it's a valid `@user:server`). */
  confirmTyped(): void {
    if (this.canConfirm()) {
      this.dialogRef.close(this.term().trim());
    }
  }

  cancel(): void {
    this.dialogRef.close(null);
  }

  /** First visible character (sans sigil), uppercased, for the avatar fallback. */
  initialOf(name: string): string {
    const stripped = name.replace(/^[#@!]+/, '').trim();
    return (stripped[0] ?? '?').toUpperCase();
  }
}
