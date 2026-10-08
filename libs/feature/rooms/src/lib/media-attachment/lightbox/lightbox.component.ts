import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnDialogRef } from '@trinity/components/overlay';
import { type PresentedMediaReference } from '@trinity/data-access/media';
import { MediaSaveService } from '../media-save.service';

/**
 * A full-resolution image, filling the viewport over a dark backdrop.
 *
 * Opened through {@link TrnSurfaceService} rather than rendered inline in the timeline row
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
  /** The attachment being viewed; what the download button saves. */
  readonly media = input.required<PresentedMediaReference>();

  private readonly mediaSave = inject(MediaSaveService);
  /** Whether THIS item is being saved; other items' saves do not affect the button. */
  protected readonly busy = computed(() =>
    this.mediaSave.isSaving(this.media()),
  );

  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);

  /** Save without letting the click reach the host, which closes the viewer on any click. */
  protected download(event: Event): void {
    event.stopPropagation();
    // Kept enabled (aria-disabled) while busy so keyboard focus stays put and a tap still
    // stops here instead of falling through to the close-on-click host.
    if (!this.busy()) this.mediaSave.save(this.media());
  }

  protected close(): void {
    this.dialogRef.close();
  }
}
