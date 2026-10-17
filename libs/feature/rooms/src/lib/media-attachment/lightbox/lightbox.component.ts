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
 * Opened through {@link TrnSurfaceService}, not rendered inline in the timeline row, so it
 * gets the CDK dialog's focus trap, inert page behind it and top-of-stack overlay that a
 * row whose ancestors may clip it or open a stacking context cannot give.
 *
 * The viewer fills the dialog pane and closes on any click (`zoom-out`). Its padded
 * surround is therefore the usable backdrop; CDK's own backdrop sits behind the
 * full-viewport pane and still owns modal isolation.
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
    // Kept enabled (aria-disabled) while busy so focus stays put and a tap does not fall
    // through to the close-on-click host.
    if (!this.busy()) this.mediaSave.save(this.media());
  }

  protected close(): void {
    this.dialogRef.close();
  }
}
