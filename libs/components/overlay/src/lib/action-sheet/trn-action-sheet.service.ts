import {
  DestroyRef,
  Injectable,
  Injector,
  afterNextRender,
  inject,
} from '@angular/core';
import { TrnDialogService } from '../dialog/trn-dialog.service';
import { TrnToastService } from '../toast/trn-toast.service';
import { TrnActionSheetRef } from './trn-action-sheet-ref';
import type {
  ActionSheetData,
  TrnActionListComponent,
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
 *
 * The list and its menu code load on first use, so they stay out of the startup bundle. Once
 * loaded, a list opens within the call, as it did when the code was bundled.
 */
@Injectable({ providedIn: 'root' })
export class TrnActionSheetService {
  private readonly dialogs = inject(TrnDialogService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private list: typeof TrnActionListComponent | undefined;
  private chunk: Promise<typeof TrnActionListComponent> | undefined;

  constructor() {
    // Fetched once the first screen is up, so the first menu opens at once and one opened
    // after the network is lost still opens; a failure here is retried by the next open.
    afterNextRender(() => void this.load().catch(() => undefined));
  }

  open(
    data: ActionSheetData,
    ariaLabel?: string,
    options: TrnActionSheetOptions = {},
  ): TrnActionSheetRef {
    const sheet = new TrnActionSheetRef(options.anchor ? 'popover' : 'sheet');
    const present = (list: typeof TrnActionListComponent): void => {
      const ref = this.dialogs.open<void, TrnActionListComponent>(list, {
        inputs: { data, label: ariaLabel },
        // CDK's role="dialog" has no name otherwise; the header is a caption, not a heading.
        ariaLabel: ariaLabel ?? data.header,
        restoreFocus: options.restoreFocus,
        // A menu takes focus itself, so the arrow keys work at once.
        ...(options.anchor
          ? { anchor: options.anchor, autoFocus: '[role="menu"]' }
          : { placement: 'bottom' as const }),
      });
      sheet.attach(
        ref,
        () =>
          this.dialogs.componentOf<TrnActionListComponent>(ref)?.surface ??
          null,
      );
    };
    if (this.list) {
      present(this.list);
      return sheet;
    }
    this.load().then(
      (list) => {
        if (!sheet.isClosed && !this.destroyRef.destroyed) present(list);
      },
      () => {
        if (sheet.isClosed || this.destroyRef.destroyed) return;
        sheet.close();
        // Resolved here, not at construction: the toast service adds a live region to <body>.
        this.injector
          .get(TrnToastService)
          .show('Could not open the menu. Please try again.', {
            duration: 5000,
            variant: 'danger',
          });
      },
    );
    return sheet;
  }

  /** One fetch shared by the warm-up and every open; a failed one is forgotten so the next retries. */
  private load(): Promise<typeof TrnActionListComponent> {
    return (this.chunk ??= import('./trn-action-list.component').then(
      (module) => (this.list = module.TrnActionListComponent),
      (error: unknown) => {
        this.chunk = undefined;
        throw error;
      },
    ));
  }
}
