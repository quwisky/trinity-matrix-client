import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { TrnButton } from '@trinity/components/button';
import { TrnIconComponent } from '@trinity/components/icon';
import { TrnDialogRef } from '@trinity/components/overlay';

/**
 * A full-resolution image, filling the viewport over a dark backdrop.
 *
 * Opened through {@link TrnDialogService} rather than rendered inline in the timeline row
 * that owns the attachment, which is what the row used to do. That version worked, and every
 * part of it that worked was hand-rolled: a `position: fixed` element at `z-index: 1000`, a
 * `tabindex="-1"` host focused by an effect, an Escape binding, and a remembered element to
 * hand focus back to. All four are the CDK dialog's job, and the CDK's versions are better —
 * a real focus trap rather than one focused element, the page behind it inert, and an overlay
 * at the top of the stacking order rather than one living inside a row whose ancestors are
 * free to clip it or open a stacking context around it.
 *
 * The viewer fills the dialog pane and closes on any click, which is what `zoom-out` has
 * always promised. Its padded surround is therefore the usable backdrop; CDK's own backdrop
 * sits physically behind the full-viewport pane and still owns modal isolation.
 */
@Component({
  selector: 'trn-lightbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnIconComponent],
  host: {
    class: 'lightbox',
    '(click)': 'close()',
  },
  templateUrl: './lightbox.component.html',
  styleUrl: './lightbox.component.scss',
})
export class LightboxComponent {
  readonly src = input.required<string>();
  readonly filename = input<string>('');

  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);

  protected close(): void {
    this.dialogRef.close();
  }
}
