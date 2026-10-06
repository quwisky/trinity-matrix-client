import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  computed,
  contentChild,
  inject,
  input,
} from '@angular/core';
import { outputFromObservable } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { Subject } from 'rxjs';
import { TrnDialogRef, dialogTitleId } from '../dialog/trn-dialog-ref';
import { TrnOverlaySurfaceDirective } from '../surface/trn-overlay-surface.directive';
import type {
  TrnOverlaySurfaceLayout,
  TrnOverlaySurfaceSize,
} from '../surface/trn-overlay-surface-recipe';

/** Marks the element whose children are the dialog's footer actions. */
@Directive({
  selector: '[trnDialogActions]',
  host: { class: 'flex flex-wrap items-center justify-end gap-2' },
})
export class TrnDialogActions {}

/**
 * The one dialog frame: a titled header with a close X, a scrolling body, and a footer band
 * for projected `[trnDialogActions]`.
 *
 * The layout follows the opening dialog's {@link TrnDialogRef.presentation}: a centred card,
 * a bottom sheet with a handle on phones, or a fullscreen surface.
 */
@Component({
  selector: 'trn-dialog-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnIconComponent, TrnOverlaySurfaceDirective],
  templateUrl: './trn-dialog-shell.component.html',
  styleUrl: './trn-dialog-shell.component.scss',
  host: { '[attr.data-presentation]': 'layout()' },
})
export class TrnDialogShellComponent {
  private readonly ref = inject(TrnDialogRef, { optional: true });
  private readonly closeRequests = new Subject<void>();

  /** The opener labels its dialog container with this id; a bare shell mints its own. */
  protected readonly titleId = this.ref?.titleId ?? dialogTitleId();
  protected readonly actions = contentChild(TrnDialogActions);
  protected readonly layout = computed<TrnOverlaySurfaceLayout>(() => {
    const presentation = this.ref?.presentation;
    return presentation === 'sheet' || presentation === 'fullscreen'
      ? presentation
      : 'dialog';
  });

  readonly title = input.required<string>();
  readonly description = input<string>();
  readonly closable = input(true);
  /** Keep the `h2` for screen readers, which still name the dialog by it, but hide it. */
  readonly titleHidden = input(false);
  readonly size = input<TrnOverlaySurfaceSize>('md');
  /**
   * The X was pressed. Bind it to run your own close path; left unbound, the shell dismisses
   * its dialog without a result, which runs the opener's `dismissGuard` like Escape does.
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
