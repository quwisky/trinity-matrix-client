import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/helm/overlay';
import { JumpToDateComponent } from './jump-to-date.component';

/**
 * Presents {@link JumpToDateComponent} and resolves the chosen day's local midnight (epoch
 * ms), or `null` when cancelled. Mirrors {@link MessageSearchService}: the dialog plumbing
 * lives here so the shell stays thin and performs the jump itself with the returned value.
 *
 * A re-entrancy guard makes re-triggering while it is open a no-op rather than stacking
 * dialogs.
 */
@Injectable({ providedIn: 'root' })
export class JumpToDateService {
  private readonly dialog = inject(TrnDialogService);
  private open = false;

  /** Ask for a date; resolves its local midnight in epoch ms, or null. */
  async pick(): Promise<number | null> {
    if (this.open) {
      return null;
    }
    this.open = true;
    try {
      const chosen = await this.dialog.openAndWait<number, JumpToDateComponent>(
        JumpToDateComponent,
        { ariaLabel: 'Jump to date', autoFocus: '[data-autofocus]' },
      );
      return chosen ?? null;
    } finally {
      this.open = false;
    }
  }
}
