import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { DialogRef } from '@trinity/kit/overlay';
import { TrnButton } from '@trinity/kit/button';
import { AccountScopeService } from '@trinity/data-access/rooms';
import { AvatarComponent } from '@trinity/ui';
import { type AccountSummary } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';

/**
 * The mobile stand-in for the user panel's "Show accounts" submenu.
 *
 * Below the `md` breakpoint the sidebar is a full-screen page and the user panel is a bar
 * across the bottom of the viewport, so a flyout anchored beside the account menu has nowhere
 * to go — it would land back on top of the menu, which is the bug this exists to avoid.
 *
 * Writes through {@link AccountScopeService} directly, as the other dialogs in this feature
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
  imports: [AvatarComponent, TrnButton],
})
export class AccountPickerComponent {
  private readonly scope = inject(AccountScopeService);
  private readonly dialogRef =
    inject<DialogRef<void, AccountPickerComponent>>(DialogRef);

  /** Every signed-in account (populated from the dialog's `inputs`). */
  readonly accounts = input<AccountSummary[]>([]);

  /** The account being acted as — always shown, so its row is locked. */
  readonly activeUserId = input<string | null>(null);

  /** Whether `userId` is currently mixed into the view. Live, so a tick re-renders its row. */
  isShown(userId: string): boolean {
    return this.scope.selected().has(userId);
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
      this.scope.toggle(userId);
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
