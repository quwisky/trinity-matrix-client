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
  UserDirectoryDiscoveryService,
  type DiscoveredUser,
} from '@trinity/data-access/discovery';
import { initialOf, isValidUserId } from '@trinity/util/matrix';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import { AvatarComponent } from '@trinity/components/generic-content';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';

/** Don't hit the directory until the term is at least this long. */
const MIN_SEARCH_LENGTH = 2;

/**
 * Dialog user picker for the invite and DM flows: a free-text Matrix-ID field (the
 * always-available minimum; Confirm accepts a typed `@user:server`) above live homeserver
 * user-directory results. Presented by {@link UserPickerService} as a
 * {@link TrnSurfaceService} dialog; it closes with the chosen MXID, or `null` on cancel, and
 * never creates or invites itself, so the page stays the orchestrator. matrix-js-sdk is
 * reached only through {@link UserDirectoryDiscoveryService.search}. The card self-sizes for
 * a bare CDK dialog (no `ion-modal` host).
 */
/** Who was picked; the name is null for a typed ID the directory did not return. */
export interface PickedUser {
  readonly userId: string;
  readonly displayName: string | null;
}

/** A line under the search field, with an optional button that closes the picker first. */
export interface UserPickerNote {
  readonly text: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

@Component({
  selector: 'trn-user-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyStateComponent,
    AvatarComponent,
    TrnSpinnerComponent,
    TrnDialogActions,
    TrnDialogShellComponent,
    TrnButton,
    TrnInput,
  ],
  templateUrl: './user-picker.component.html',
  styleUrl: './user-picker.component.scss',
})
export class UserPickerComponent {
  private readonly dialogRef =
    inject<TrnDialogRef<PickedUser | null>>(TrnDialogRef);
  private readonly directory = inject(UserDirectoryDiscoveryService);

  /** Dialog heading (e.g. "Start a direct message"). */
  readonly title = input('Find people');
  /** Confirm-button label for the typed-MXID path (e.g. "Invite"). */
  readonly confirmLabel = input('Select');
  /** Search placeholder. */
  readonly placeholder = input('@user:server or a name');
  /** A line under the search field, such as what an invitee will be able to read. */
  readonly note = input<UserPickerNote | null>(null);

  readonly term = signal('');
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
          return of<readonly DiscoveredUser[]>([]);
        }
        this.searching.set(true);
        return this.directory.search(term).pipe(
          map((page) => page.users),
          // Search is best-effort; a failure shows the empty state, not an error.
          catchError(() => of<readonly DiscoveredUser[]>([])),
          finalize(() => this.searching.set(false)),
        );
      }),
    ),
    { initialValue: [] as readonly DiscoveredUser[] },
  );

  onInput(event: Event): void {
    this.term.set((event.target as HTMLInputElement).value);
  }

  choose(user: DiscoveredUser): void {
    this.dialogRef.close({
      userId: user.userId,
      displayName: user.displayName,
    });
  }

  /** Confirm the typed MXID (enabled only when it's a valid `@user:server`). */
  confirmTyped(): void {
    if (this.canConfirm()) {
      const userId = this.term().trim();
      const known = this.results().find((user) => user.userId === userId);
      this.dialogRef.close({ userId, displayName: known?.displayName ?? null });
    }
  }

  cancel(): void {
    this.dialogRef.close(null);
  }

  /** Run the note's action once the picker is out of the way. */
  runNoteAction(action: NonNullable<UserPickerNote['action']>): void {
    this.cancel();
    action.run();
  }

  readonly initialOf = initialOf;
}
