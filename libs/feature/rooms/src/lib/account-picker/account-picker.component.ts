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
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
  TrnLockedSelectionDirective,
} from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { SelectedRoomLibraryService } from '@trinity/data-access/room-library';
import { AccountPickLabelComponent } from '../shared/account-pick-label/account-pick-label.component';
import { type AccountSummary } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';

/**
 * The mobile stand-in for the user panel's "Accounts in view" submenu. Below the `md`
 * breakpoint the user panel is a bar across the bottom of the viewport, so a flyout anchored
 * beside the account menu would land back on top of the menu.
 *
 * Writes through {@link SelectedRoomLibraryService} directly, like the other dialogs in this
 * feature: each tick applies immediately and the dialog stays open, matching the submenu,
 * rather than inventing a batch-and-commit contract. These writes do not pass through
 * `RoomsPage`, so they are invisible to anyone reading `rooms.page.html`.
 */
@Component({
  selector: 'trn-account-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './account-picker.component.html',
  styleUrl: './account-picker.component.scss',
  imports: [
    AccountPickLabelComponent,
    TrnButton,
    TrnIconComponent,
    TrnLockedSelectionDirective,
    TrnDialogActions,
    TrnDialogShellComponent,
  ],
})
export class AccountPickerComponent {
  private readonly selected = inject(SelectedRoomLibraryService);
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly destroyRef = inject(DestroyRef);

  readonly accounts = input<AccountSummary[]>([]);

  /** The account being acted as — always shown, so its row is locked. */
  readonly activeUserId = input<string | null>(null);

  /** First account that can be changed; focus skips the locked active account. */
  readonly firstFocusableAccountId = computed(
    () => this.accounts().find(({ userId }) => !this.isLocked(userId))?.userId,
  );

  isShown(userId: string): boolean {
    return this.selected.view().accountIds.has(userId);
  }

  /**
   * The active account is always shown, so its row is disabled rather than pre-ticked: the
   * service refuses to drop it, and a tickable row that does nothing would drift from state.
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

  close(): void {
    this.dialogRef.close();
  }
}
