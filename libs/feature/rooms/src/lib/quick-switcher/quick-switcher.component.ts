import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  GlobalSearchService,
  type SwitcherKind,
  type SwitcherResult,
  type SwitcherSelection,
} from '@trinity/application/search';
import { AccountBadgesService } from '../shared/account-badges.service';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import {
  AvatarComponent,
  type AccountBadge,
  type AvatarShape,
} from '@trinity/components/generic-content';
import {
  TrnDialogRef,
  TrnOverlaySurfaceDirective,
} from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';

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
 * renders a {@link GlobalSearchService} session over Room Library and Discovery.
 *
 * Local matches are an instant `computed` over the query signal; people are a
 * debounced RxJS stream. Keyboard nav (Up/Down move, Enter select, Esc close) lives on
 * the native input. On a pick it closes with the chosen {@link SwitcherSelection},
 * leaving the actual navigation and repair to Workspace. The card self-sizes so it works in a
 * bare CDK dialog (no `ion-modal` host). The search field takes focus on open through
 * the dialog's `autoFocus` selector (see {@link QuickSwitcherService}) — CDK focuses
 * after attach, so anything the component focuses itself is immediately overridden.
 */
@Component({
  selector: 'trn-quick-switcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyStateComponent,
    TrnIconComponent,
    AvatarComponent,
    TrnOverlaySurfaceDirective,
    TrnSpinnerComponent,
    TrnButton,
    TrnInput,
  ],
  templateUrl: './quick-switcher.component.html',
  styleUrl: './quick-switcher.component.scss',
})
export class QuickSwitcherComponent {
  private readonly dialogRef =
    inject<TrnDialogRef<SwitcherSelection | null>>(TrnDialogRef);
  private readonly search = inject(GlobalSearchService);
  private readonly injector = inject(Injector);
  private readonly accountBadges = inject(AccountBadgesService);

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
  private readonly session = this.search.createSession(
    this.query,
    this.activeAccountOnly,
    this.injector,
  );
  readonly searching = this.session.searching;
  readonly results = this.session.results;

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
    this.dismiss(this.search.destinationFor(result));
  }

  /** The owning-account badge for a result (mixed view only), or null. */
  badgeFor(result: SwitcherResult): AccountBadge | null {
    return this.accountBadges.forAccount(result.accountBadgeId);
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

  /** People and DMs are circular; every room-like destination is a stable squircle. */
  avatarShape(result: SwitcherResult): AvatarShape {
    switch (result.kind) {
      case 'user':
      case 'dm':
        return 'person';
      case 'room':
      case 'space':
        return 'place';
      case 'invite':
        return result.isDirect ? 'person' : 'place';
      default:
        return this.unreachableSwitcherResult(result);
    }
  }

  /** Compile-time exhaustiveness guard for future switcher result kinds. */
  private unreachableSwitcherResult(result: never): never {
    throw new Error(`Unsupported switcher result: ${String(result)}`);
  }
}
