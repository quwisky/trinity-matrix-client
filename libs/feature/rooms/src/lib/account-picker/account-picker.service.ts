import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/kit/overlay';
import { AccountPickerComponent } from './account-picker.component';
import { type AccountSummary } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';

/** The accounts to list, and which one is being acted as. */
export interface AccountPickerOptions {
  accounts: AccountSummary[];
  activeUserId: string | null;
}

/**
 * Presents {@link AccountPickerComponent} — the narrow-layout stand-in for the user panel's
 * "Show accounts" submenu, which has nowhere to fly out to below the `md` breakpoint.
 *
 * Presentation only: the dialog applies each tick itself, so there is no result to hand back.
 * Mirrors {@link ReactionsDialogService}, including the re-entrancy guard that makes a repeat
 * trigger a no-op rather than stacking dialogs.
 */
@Injectable({ providedIn: 'root' })
export class AccountPickerService {
  private readonly dialog = inject(TrnDialogService);
  private showing = false;

  /** Show the picker; resolves when it is dismissed. */
  async open({ accounts, activeUserId }: AccountPickerOptions): Promise<void> {
    if (this.showing) {
      return; // already open — ignore the repeat trigger
    }
    this.showing = true;
    try {
      // Yield a microtask before presenting. The dropdown item that raised this is still
      // inside CdkMenuItem.trigger(), which emits `triggered` and only THEN calls
      // menuStack.closeAll({ focusParentTrigger: true }). Opening synchronously would have CDK
      // capture the menu row it is about to destroy as the focus-restore target, so dismissing
      // the dialog would drop focus to <body>; after the yield it captures the user-panel
      // button the menu has just restored focus to, and focus returns there.
      await Promise.resolve();
      await this.dialog.openAndWait<void, AccountPickerComponent>(
        AccountPickerComponent,
        {
          ariaLabel: 'Show accounts',
          inputs: { accounts, activeUserId },
          // Land on the first account rather than CDK's first tabbable element, which is
          // the Done button.
          autoFocus: '[data-autofocus]',
        },
      );
    } finally {
      this.showing = false;
    }
  }
}
