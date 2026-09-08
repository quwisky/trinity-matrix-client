import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnDialogService } from '@trinity/components/overlay';
import { asapScheduler, finalize, scheduled, switchMap } from 'rxjs';
import { AccountPickerComponent } from './account-picker.component';
import { type AccountSummary } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';

/** The accounts to list, and which one is being acted as. */
export interface AccountPickerOptions {
  accounts: AccountSummary[];
  activeUserId: string | null;
}

/**
 * Presents {@link AccountPickerComponent} — the narrow-layout stand-in for the user panel's
 * "Accounts in view" submenu, which has nowhere to fly out to below the `md` breakpoint.
 *
 * Presentation only: the dialog applies each tick itself, so there is no result to hand back.
 * Mirrors {@link ReactionsDialogService}, including the re-entrancy guard that makes a repeat
 * trigger a no-op rather than stacking dialogs.
 */
@Injectable({ providedIn: 'root' })
export class AccountPickerService {
  private readonly dialog = inject(TrnDialogService);
  private readonly destroyRef = inject(DestroyRef);
  private showing = false;

  /** Show the picker until it is dismissed. */
  open({ accounts, activeUserId }: AccountPickerOptions): void {
    if (this.showing) {
      return; // already open — ignore the repeat trigger
    }
    this.showing = true;
    // Yield a microtask before presenting. The dropdown item that raised this is still inside
    // CdkMenuItem.trigger(), which emits `triggered` and only THEN calls
    // menuStack.closeAll({ focusParentTrigger: true }). Opening synchronously would have CDK
    // capture the menu row it is about to destroy as the focus-restore target, so dismissing
    // the dialog would drop focus to <body>; after the yield it captures the user-panel button
    // the menu has just restored focus to, and focus returns there.
    scheduled([undefined], asapScheduler)
      .pipe(
        switchMap(() =>
          this.dialog.openAndWait$<void, AccountPickerComponent>(
            AccountPickerComponent,
            {
              ariaLabel: 'Accounts in view',
              inputs: { accounts, activeUserId },
              // Land on the first changeable account rather than the locked active row or
              // CDK's first tabbable element, which is the Done button when none can change.
              autoFocus: '[data-autofocus]',
            },
          ),
        ),
        finalize(() => (this.showing = false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({ error: () => undefined });
  }
}
