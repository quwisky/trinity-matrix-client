import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { ReactionsDialogComponent } from './reactions-dialog.component';

/**
 * Presents {@link ReactionsDialogComponent} for a message — everyone who reacted,
 * grouped by emoji. Mirrors {@link EditHistoryDialogService}: presentation only, with
 * the component reading its own data.
 *
 * A re-entrancy guard makes a repeat trigger a no-op rather than stacking dialogs.
 */
@Injectable({ providedIn: 'root' })
export class ReactionsDialogService {
  private readonly dialog = inject(TrnDialogService);
  private showing = false;

  /** Show who reacted to `eventId`, opening on its first reaction. */
  async open(eventId: string): Promise<void> {
    if (this.showing) {
      return; // already open — ignore the repeat trigger
    }
    this.showing = true;
    try {
      await this.dialog.openAndWait<void, ReactionsDialogComponent>(
        ReactionsDialogComponent,
        { ariaLabel: 'Reactions', inputs: { eventId } },
      );
    } finally {
      this.showing = false;
    }
  }
}
