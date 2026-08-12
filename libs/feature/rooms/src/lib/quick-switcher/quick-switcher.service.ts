import { Injectable, inject } from '@angular/core';
import { type SwitcherSelection } from '@trinity/data-access/search';
import { TrnDialogService } from '@trinity/kit/overlay';
import { QuickSwitcherComponent } from './quick-switcher.component';

/**
 * Presents the {@link QuickSwitcherComponent} as a {@link TrnDialogService} dialog
 * and resolves the chosen {@link SwitcherSelection} (or `null` when cancelled).
 * Wraps the dialog so `RoomsPage` stays thin and performs the actual jump with the
 * returned selection — mirroring {@link UserPickerService}.
 *
 * A re-entrancy guard means a repeated Ctrl/Cmd+K while the switcher is already open
 * is a no-op rather than stacking dialogs.
 */
@Injectable({ providedIn: 'root' })
export class QuickSwitcherService {
  private readonly dialog = inject(TrnDialogService);
  private open = false;

  /**
   * Open the switcher; resolves the chosen selection, or null if cancelled/already open.
   *
   * `activeAccountOnly` restricts the list to the account currently in use. Jumping to a
   * room switches accounts first, so the full mixed corpus is right there — but a caller
   * that ACTS on the target without switching (forwarding a message) must not be offered a
   * room the active account isn't in.
   */
  async pick(
    opts: { activeAccountOnly?: boolean } = {},
  ): Promise<SwitcherSelection | null> {
    if (this.open) {
      return null; // already showing — ignore the repeat trigger
    }
    this.open = true;
    try {
      return await this.dialog.openAndWait<
        SwitcherSelection,
        QuickSwitcherComponent
      >(QuickSwitcherComponent, {
        ariaLabel: 'Jump to a room',
        inputs: { activeAccountOnly: opts.activeAccountOnly ?? false },
        // Open-and-type is the whole point of a quick switcher, so focus lands on the
        // search field rather than CDK's first tabbable element (the Cancel button).
        autoFocus: '[data-autofocus]',
      });
    } finally {
      this.open = false;
    }
  }
}
