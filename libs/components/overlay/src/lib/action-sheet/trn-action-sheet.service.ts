import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '../dialog/trn-dialog.service';
import { TrnActionSheetRef } from './trn-action-sheet-ref';
import {
  TrnActionListComponent,
  type ActionSheetData,
} from './trn-action-list.component';

export interface TrnActionSheetOptions {
  /** Let the opener own restoration when choosing a row launches another surface. */
  restoreFocus?: boolean;
  /** Present as a menu beside this element; a bottom sheet without one. */
  anchor?: HTMLElement;
}

/**
 * Opens {@link TrnActionListComponent}, internal to the overlay library: features call
 * `TrnSurfaceService.openActions()`, which decides whether an anchor applies.
 *
 * `open()` returns its handle: the message timeline destroys a row when it is redacted,
 * edited or scrolled out of the virtual window, and a list still standing over a dead row
 * offers actions that quietly do nothing. The opener closes it.
 */
@Injectable({ providedIn: 'root' })
export class TrnActionSheetService {
  private readonly dialogs = inject(TrnDialogService);

  open(
    data: ActionSheetData,
    ariaLabel?: string,
    options: TrnActionSheetOptions = {},
  ): TrnActionSheetRef {
    const ref = this.dialogs.open<void, TrnActionListComponent>(
      TrnActionListComponent,
      {
        inputs: { data },
        // CDK's role="dialog" has no name otherwise; the header is a caption, not a heading.
        ariaLabel: ariaLabel ?? data.header,
        restoreFocus: options.restoreFocus,
        // A menu takes focus itself, so the arrow keys work at once.
        ...(options.anchor
          ? { anchor: options.anchor, autoFocus: '[role="menu"]' }
          : { placement: 'bottom' as const }),
      },
    );
    return new TrnActionSheetRef(
      ref,
      () =>
        this.dialogs.componentOf<TrnActionListComponent>(ref)?.surface ?? null,
    );
  }
}
