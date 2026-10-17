import { Injectable, inject } from '@angular/core';
import { type SwitcherSelection } from '@trinity/application/search';
import { TrnSurfaceService } from '@trinity/components/overlay';
import { defer, finalize, of, type Observable } from 'rxjs';
import { QuickSwitcherComponent } from './quick-switcher.component';

/**
 * Presents the {@link QuickSwitcherComponent} as a {@link TrnSurfaceService} dialog and
 * resolves the chosen {@link SwitcherSelection}, or `null` when cancelled, mirroring
 * {@link UserPickerService}. A re-entrancy guard makes a repeated Ctrl/Cmd+K while it is
 * open a no-op.
 */
@Injectable({ providedIn: 'root' })
export class QuickSwitcherService {
  private readonly dialog = inject(TrnSurfaceService);
  private open = false;

  /**
   * Open the switcher; resolves the chosen selection, or null if cancelled/already open.
   *
   * `activeAccountOnly` restricts the list to the active account: a caller that ACTS on the
   * target without switching accounts (forwarding a message) must not be offered a room the
   * active account isn't in.
   */
  pick$(
    opts: { activeAccountOnly?: boolean } = {},
  ): Observable<SwitcherSelection | null> {
    return defer(() => {
      if (this.open) {
        return of(null); // already showing — ignore the repeat subscription
      }
      this.open = true;
      return this.dialog
        .openAndWait$<SwitcherSelection, QuickSwitcherComponent>(
          QuickSwitcherComponent,
          {
            inputs: { activeAccountOnly: opts.activeAccountOnly ?? false },
            // Open-and-type is the whole point of a quick switcher, so focus lands on the
            // search field rather than CDK's first tabbable element (the shell's close button).
            autoFocus: '[data-autofocus]',
          },
        )
        .pipe(finalize(() => (this.open = false)));
    });
  }
}
