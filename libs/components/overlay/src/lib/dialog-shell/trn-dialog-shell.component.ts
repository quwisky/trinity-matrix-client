import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  computed,
  contentChild,
  inject,
  input,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { outputFromObservable } from '@angular/core/rxjs-interop';
import {
  TRN_BUTTON_ROW_CONTEXT,
  TrnButton,
} from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { Subject } from 'rxjs';
import { TrnDialogRef, dialogTitleId } from '../dialog/trn-dialog-ref';
import { TrnInsetGroup, TrnInsetRow } from '../inset-group/trn-inset-group';
import { TrnSheetFrameComponent } from '../sheet-frame/trn-sheet-frame.component';
import { TrnOverlaySurfaceDirective } from '../surface/trn-overlay-surface.directive';
import type {
  TrnOverlaySurfaceLayout,
  TrnOverlaySurfaceSize,
} from '../surface/trn-overlay-surface-recipe';

/**
 * Marks the element whose children are the dialog's footer actions. In a sheet they become the
 * rows of one inset card, top to bottom in source order.
 */
@Directive({
  selector: '[trnDialogActions]',
  providers: [
    {
      provide: TRN_BUTTON_ROW_CONTEXT,
      useFactory: () => {
        const ref = inject(TrnDialogRef, { optional: true });
        return computed(() => ref?.presentation === 'sheet');
      },
    },
  ],
  host: {
    '[class]':
      "sheet() ? sheetClasses : 'flex flex-wrap items-center justify-end gap-2'",
  },
})
export class TrnDialogActions {
  protected readonly sheet = inject(TRN_BUTTON_ROW_CONTEXT);
  protected readonly sheetClasses =
    'isolate flex flex-col rounded-[var(--trinity-radius-xl)] bg-[color:var(--trinity-neutral-fill-surface)] divide-y divide-[color:var(--trinity-border-sheet-divider)] overflow-hidden';
}

/**
 * The one dialog frame: a titled header with a close X, a scrolling body, and a footer band
 * for projected `[trnDialogActions]`.
 *
 * The layout follows the opening dialog's {@link TrnDialogRef.presentation}: a centred card,
 * a bottom sheet through `trn-sheet-frame` (handle and swipe), or a fullscreen surface. A sheet
 * centres its title, sets the actions as card rows and swaps the X for a Cancel block.
 */
@Component({
  selector: 'trn-dialog-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    TrnButton,
    TrnIconComponent,
    TrnInsetGroup,
    TrnInsetRow,
    TrnOverlaySurfaceDirective,
    TrnSheetFrameComponent,
  ],
  templateUrl: './trn-dialog-shell.component.html',
  styleUrl: './trn-dialog-shell.component.scss',
  host: {
    '[attr.data-presentation]': 'layout()',
    '[attr.data-sheet-handle]': "handled() ? '' : null",
    '[style.--trn-overlay-block-start]': 'blockStart',
  },
})
export class TrnDialogShellComponent {
  private readonly ref = inject(TrnDialogRef, { optional: true });
  private readonly closeRequests = new Subject<void>();

  /** The opener labels its dialog container with this id; a bare shell mints its own. */
  protected readonly titleId = this.ref?.titleId ?? dialogTitleId();
  /** A top-anchored dialog's offset, which the card's height cap subtracts. */
  protected readonly blockStart = this.ref?.blockStart ?? null;
  protected readonly actions = contentChild(TrnDialogActions);
  protected readonly layout = computed<TrnOverlaySurfaceLayout>(() => {
    const presentation = this.ref?.presentation;
    return presentation === 'sheet' || presentation === 'fullscreen'
      ? presentation
      : 'dialog';
  });

  /** A sheet the dialog service opened renders through the sheet frame, handle and swipe included. */
  protected readonly framed = computed(() => this.layout() === 'sheet');
  /** The frame draws its handle unless the sheet was opened `disableClose`. */
  protected readonly handled = computed(
    () => this.framed() && !this.ref?.disableClose,
  );

  /** A sheet trades the X for a Cancel block under its actions. */
  protected readonly sheetCancelShown = computed(
    () => this.framed() && this.closable() && this.sheetCancel(),
  );

  readonly title = input.required<string>();
  readonly description = input<string>();
  readonly closable = input(true);
  /** The X's accessible name; "Close" unless the host names what it closes. */
  readonly closeLabel = input('Close');
  readonly closeTestId = input('dialog-close');
  /** The sheet Cancel block's visible text. */
  readonly cancelText = input('Cancel');
  /** False for a sheet that closes on selection and needs no Cancel block. */
  readonly sheetCancel = input(true);
  /** Keep the `h2` for screen readers, which still name the dialog by it, but hide it. */
  readonly titleHidden = input(false);
  readonly size = input<TrnOverlaySurfaceSize>('md');
  /** Extra classes for the scrolling body, e.g. `p-0` for content that fills it edge to edge. */
  readonly bodyClass = input('');
  /**
   * The X, or a sheet's Cancel block, was pressed. Bind it to run your own close path; left
   * unbound, the shell dismisses its dialog without a result, which runs the opener's
   * `dismissGuard` like Escape does.
   */
  readonly closed = outputFromObservable(this.closeRequests);

  protected requestClose(): void {
    if (this.closeRequests.observed) {
      this.closeRequests.next();
    } else {
      this.ref?.close();
    }
  }
}
