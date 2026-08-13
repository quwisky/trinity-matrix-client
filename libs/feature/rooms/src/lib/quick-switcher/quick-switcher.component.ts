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
  SearchService,
  type SwitcherKind,
  type SwitcherResult,
  type SwitcherSelection,
} from '@trinity/data-access/search';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AccountBadgesService } from '../shared/account-badges.service';
import { AvatarComponent, type AccountBadge } from '@trinity/ui';
import { TrnDialogRef } from '@trinity/components/overlay';
import { HlmButton } from '@trinity/helm/button';
import { TrnInput } from '@trinity/components/input';
import { TrnSpinnerComponent } from '@trinity/components/spinner';
import { TrnIconComponent, type TrnIconName } from '@trinity/components/icon';
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

/** Trailing icon per kind. */
const KIND_ICON: Record<SwitcherKind, TrnIconName> = {
  room: 'message-square',
  space: 'users',
  dm: 'user',
  invite: 'mail',
  user: 'user',
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
 * bare CDK dialog (no `ion-modal` host). The search field takes focus on open through
 * the dialog's `autoFocus` selector (see {@link QuickSwitcherService}) — CDK focuses
 * after attach, so anything the component focuses itself is immediately overridden.
 */
@Component({
  selector: 'trn-quick-switcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnIconComponent,
    AvatarComponent,
    TrnSpinnerComponent,
    HlmButton,
    TrnInput,
  ],
  templateUrl: './quick-switcher.component.html',
  styleUrl: './quick-switcher.component.scss',
})
export class QuickSwitcherComponent {
  private readonly dialogRef =
    inject<TrnDialogRef<SwitcherSelection | null>>(TrnDialogRef);
  private readonly search = inject(SearchService);
  private readonly accountBadges = inject(AccountBadgesService);
  private readonly matrix = inject(MatrixClientService);

  /**
   * Restrict results to the active account. Set by callers that act on the target without
   * switching accounts first (message forwarding), for which another account's room is not
   * a usable destination.
   */
  readonly activeAccountOnly = input(false);

  /** Current query text, driving both the local computed and the people stream. */
  readonly query = signal('');
  /** Index of the keyboard-highlighted row in {@link results}. */
  readonly highlight = signal(0);
  /** A directory lookup is in flight (drives the empty-state spinner). */
  readonly searching = signal(false);

  /** Instant, ranked local matches — reactive because the service reads live signals. */
  private readonly localResults = computed(() =>
    this.search.localResults(
      this.query(),
      undefined,
      // Scoping inside the query keeps the result cap meaningful — post-filtering would let
      // another account's rooms fill it and starve this one's out entirely.
      this.activeAccountOnly()
        ? (this.matrix.activeUserId() ?? undefined)
        : undefined,
    ),
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
    this.dismiss({
      kind: result.kind,
      id: result.id,
      ...(result.accountId ? { accountId: result.accountId } : {}),
    });
  }

  /** The owning-account badge for a result (mixed view only), or null. */
  badgeFor(result: SwitcherResult): AccountBadge | null {
    return this.accountBadges.forAccount(result.accountId);
  }

  dismiss(selection: SwitcherSelection | null): void {
    this.dialogRef.close(selection);
  }

  kindLabel(kind: SwitcherKind): string {
    return KIND_LABEL[kind];
  }

  kindIcon(kind: SwitcherKind): TrnIconName {
    return KIND_ICON[kind];
  }
}
