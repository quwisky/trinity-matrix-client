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
  type UserSearchResult,
} from '@trinity/data-access/rooms';
import { isValidUserId } from '@trinity/util/matrix';
import { EmptyStateComponent } from '@trinity/components/empty-state';
import { AvatarComponent } from '@trinity/components/avatar';
import { TrnDialogRef } from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/button';
import { TrnInput } from '@trinity/components/input';
import { TrnSpinnerComponent } from '@trinity/components/spinner';

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
  imports: [
    EmptyStateComponent,
    AvatarComponent,
    TrnSpinnerComponent,
    TrnButton,
    TrnInput,
  ],
  templateUrl: './user-picker.component.html',
  styleUrl: './user-picker.component.scss',
})
export class UserPickerComponent {
  private readonly dialogRef =
    inject<TrnDialogRef<string | null>>(TrnDialogRef);
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
