import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TrnIconButton } from '@trinity/components/button';
import { TrnProgressComponent } from '@trinity/components/progress';
import { TrnIconComponent } from '@trinity/components/icon';
import { type BatchProgress } from '../../shared/send-media-batch';
import { type StagedAttachment } from '../staged-attachment';

/**
 * The strip above the composer input: an upload progress bar while an attachment is in flight,
 * and every file staged for sending, each removable on its own.
 *
 * Presentational — it injects nothing and holds no state; `ComposerAttachmentsService` owns
 * both. The host is `display: contents`, so the blocks remain direct children of the composer
 * element and the layout is untouched.
 */
@Component({
  selector: 'trn-composer-attachment-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconButton, TrnIconComponent, TrnProgressComponent],
  templateUrl: './composer-attachment-strip.component.html',
  styleUrl: './composer-attachment-strip.component.scss',
})
export class ComposerAttachmentStripComponent {
  /** Which file of how many is uploading and how far along, or null when idle. */
  readonly uploadProgress = input<BatchProgress | null>(null);
  /**
   * The name of the file the bar is uploading, when the host knows it.
   *
   * The bar sits above rows that are still staged, so without a name it reads as though it
   * describes them — it describes the one currently going out.
   */
  readonly uploadLabel = input<string | null>(null);
  /**
   * Whether a retry would be accepted. False while any send is in flight — the composer
   * refuses one then, and a button that looks pressable and does nothing is worse than a
   * disabled one.
   */
  readonly canRetry = input(true);
  /** Everything staged, in the order it will be sent. */
  readonly staged = input<readonly StagedAttachment[]>([]);

  /** The × on one staged attachment was pressed; carries its id. */
  readonly removeStaged = output<string>();

  /** The retry on one failed attachment was pressed; carries its id. */
  readonly retryStaged = output<string>();

  /** False until the first real fraction lands, so the bar starts indeterminate. */
  protected readonly determinate = computed(
    () => (this.uploadProgress()?.fraction ?? 0) > 0,
  );

  protected readonly percent = computed(() =>
    Math.round((this.uploadProgress()?.fraction ?? 0) * 100),
  );

  /**
   * What the bar says it is uploading: `holiday.png (2 of 5)`, and the best available subset
   * of that when the name or the batch is missing.
   *
   * The counter only appears for a real batch — "1 of 1" on a single file is noise, and it is
   * also what every pre-batch caller produces.
   */
  protected readonly subject = computed(() => {
    const progress = this.uploadProgress();
    const name = this.uploadLabel();
    const counter =
      progress && progress.total > 1
        ? `${progress.index} of ${progress.total}`
        : null;
    if (name && counter) {
      return `${name} (${counter})`;
    }
    return name ?? counter ?? 'attachment';
  });
}
