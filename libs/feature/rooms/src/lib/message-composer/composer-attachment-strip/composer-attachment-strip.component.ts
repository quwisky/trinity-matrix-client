import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TrnProgress, TrnProgressIndicator } from '@trinity/kit/progress';
import { TrnIconComponent } from '@trinity/kit/icon';

/**
 * The strip above the composer input: an upload progress bar while an attachment is in flight,
 * and the file staged for a caption.
 *
 * Presentational — it injects nothing and holds no state; `ComposerAttachmentsService` owns
 * both, and the composer passes the two upload derivations down rather than re-deriving them
 * here so there stays one definition of "determinate". The host is `display: contents`, so the
 * blocks remain direct children of the composer element and the layout is untouched.
 */
@Component({
  selector: 'trn-composer-attachment-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent, TrnProgress, TrnProgressIndicator],
  templateUrl: './composer-attachment-strip.component.html',
  styleUrl: './composer-attachment-strip.component.scss',
})
export class ComposerAttachmentStripComponent {
  /** Upload fraction in [0, 1] while an attachment uploads, else null (idle). */
  readonly uploadProgress = input<number | null>(null);
  /** Whether to show a determinate bar — false until the first real fraction lands. */
  readonly uploadDeterminate = input(false);
  /** Whole-percent upload progress for the determinate bar's label. */
  readonly uploadPercent = input(0);
  /** The attachment staged for a caption, or null when nothing is staged. */
  readonly pendingFile = input<File | null>(null);
  /** Object URL previewing a staged image, else null. */
  readonly pendingPreview = input<string | null>(null);

  /** The × on the staged attachment was pressed. */
  readonly removePending = output<void>();
}
