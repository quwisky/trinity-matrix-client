import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnDialogRef,
  TrnLockedSelectionDirective,
  TrnOverlaySurfaceDirective,
} from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { SelectedRoomLibraryService } from '@trinity/data-access/room-library';
import { AvatarComponent } from '@trinity/components/generic-content';
import { type AccountSummary } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';

/**
 * The mobile stand-in for the user panel's "Accounts in view" submenu.
 *
 * Below the `md` breakpoint the sidebar is a full-screen page and the user panel is a bar
 * across the bottom of the viewport, so a flyout anchored beside the account menu has nowhere
 * to go — it would land back on top of the menu, which is the bug this exists to avoid.
 *
 * Writes through {@link SelectedRoomLibraryService} directly, as the other dialogs in this feature
 * inject their own data-access service. That keeps multi-select honest: each tick applies
 * immediately and the dialog stays open, matching the submenu, rather than inventing a
 * batch-and-commit contract the rest of the app does not have. The consequence worth knowing
 * is that these writes do not pass through `RoomsPage`, so they are invisible to anyone
 * reading `rooms.page.html`.
 */
@Component({
  selector: 'trn-account-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './account-picker.component.html',
  styleUrl: './account-picker.component.scss',
  imports: [
    AvatarComponent,
    TrnButton,
    TrnIconComponent,
    TrnLockedSelectionDirective,
    TrnOverlaySurfaceDirective,
  ],
})
export class AccountPickerComponent {
  private readonly selected = inject(SelectedRoomLibraryService);
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly destroyRef = inject(DestroyRef);

  /** Every signed-in account (populated from the dialog's `inputs`). */
  readonly accounts = input<AccountSummary[]>([]);

  /** The account being acted as — always shown, so its row is locked. */
  readonly activeUserId = input<string | null>(null);

  /** First account that can be changed; focus skips the locked active account. */
  readonly firstFocusableAccountId = computed(
    () => this.accounts().find(({ userId }) => !this.isLocked(userId))?.userId,
  );

  /** Whether `userId` is currently mixed into the view. Live, so a tick re-renders its row. */
  isShown(userId: string): boolean {
    return this.selected.view().accountIds.has(userId);
  }

  /**
   * The active account is always shown, so its row is disabled rather than merely pre-ticked:
   * the service refuses to drop it, and a tickable row that silently does nothing would drift
   * out of sync with the state behind it.
   */
  isLocked(userId: string): boolean {
    return userId === this.activeUserId();
  }

  /** Tick or untick an account. Deliberately does NOT close — this is a multi-select. */
  toggle(userId: string): void {
    if (!this.isLocked(userId)) {
      this.selected
        .toggleAccount(userId)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (outcome) => {
            if (outcome.kind !== 'completed') {
              console.error('Could not update the accounts shown');
            }
          },
          error: (err: unknown) =>
            console.error('Could not update the accounts shown', err),
        });
    }
  }

  initialOf(account: AccountSummary): string {
    const stripped = account.displayName.replace(/^[#@!]+/, '').trim();
    return (stripped[0] ?? account.userId[1] ?? '?').toUpperCase();
  }

  close(): void {
    this.dialogRef.close();
  }
}
