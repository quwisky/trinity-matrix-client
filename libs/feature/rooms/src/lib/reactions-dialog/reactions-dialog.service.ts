import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { isMobileOs } from '@trinity/platform-native';
import { defer, EMPTY, finalize, map, type Observable } from 'rxjs';
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

  /** Cold command showing who reacted to `eventId`, opening on its first reaction. */
  open$(eventId: string): Observable<void> {
    return defer(() => {
      if (this.showing) {
        return EMPTY; // already open — ignore the repeat subscription
      }
      this.showing = true;
      const mobile = isMobileOs();
      return this.dialog
        .openAndWait$<void, ReactionsDialogComponent>(
          ReactionsDialogComponent,
          {
            ariaLabel: 'Reactions',
            placement: mobile ? 'bottom' : 'center',
            inputs: { eventId, sheet: mobile },
          },
        )
        .pipe(
          map(() => undefined),
          finalize(() => (this.showing = false)),
        );
    });
  }
}
