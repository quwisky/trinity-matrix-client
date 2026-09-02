import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { defer, finalize, of, type Observable } from 'rxjs';
import { JumpToDateComponent } from './jump-to-date.component';

/**
 * Presents {@link JumpToDateComponent} and resolves the chosen day's local midnight (epoch
 * ms), or `null` when cancelled. Mirrors the other one-shot dialogs: the plumbing
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
  pick$(): Observable<number | null> {
    return defer(() => {
      if (this.open) {
        return of(null);
      }
      this.open = true;
      return this.dialog
        .openAndWait$<number, JumpToDateComponent>(JumpToDateComponent, {
          ariaLabel: 'Jump to date',
          autoFocus: '[data-autofocus]',
        })
        .pipe(finalize(() => (this.open = false)));
    });
  }
}
