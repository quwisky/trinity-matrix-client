import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TrnProgressComponent } from '@trinity/components/progress';
import { TrnIconComponent } from '@trinity/components/icon';
import { type StagedAttachment } from '../staged-attachment';

/**
 * The strip above the composer input: an upload progress bar while an attachment is in flight,
 * and every file staged for sending, each removable on its own.
 *
 * Presentational — it injects nothing and holds no state; `ComposerAttachmentsService` owns
 * both, and the composer passes the two upload derivations down rather than re-deriving them
 * here so there stays one definition of "determinate". The host is `display: contents`, so the
 * blocks remain direct children of the composer element and the layout is untouched.
 */
@Component({
  selector: 'trn-composer-attachment-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent, TrnProgressComponent],
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
  /** Everything staged, in the order it will be sent. */
  readonly staged = input<readonly StagedAttachment[]>([]);

  /** The × on one staged attachment was pressed; carries its id. */
  readonly removeStaged = output<string>();
}
