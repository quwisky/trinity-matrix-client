import { Injectable, inject } from '@angular/core';
import type { SwitcherSelection } from '@trinity/core';
import { TrnDialogService } from '@trinity/helm/overlay';
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

  /** Open the switcher; resolves the chosen selection, or null if cancelled/already open. */
  async pick(): Promise<SwitcherSelection | null> {
    if (this.open) {
      return null; // already showing — ignore the repeat trigger
    }
    this.open = true;
    try {
      return await this.dialog.openAndWait<
        SwitcherSelection,
        QuickSwitcherComponent
      >(QuickSwitcherComponent);
    } finally {
      this.open = false;
    }
  }
}
