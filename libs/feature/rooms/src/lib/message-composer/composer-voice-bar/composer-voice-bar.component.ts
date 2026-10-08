import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TrnIconButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';

/**
 * The recording bar that replaces the composer's input row while a voice clip is captured.
 *
 * Presentational: the composer owns the recorder and decides what cancel and send do. The host
 * is `display: contents`, so the bar remains a direct child of the composer element.
 */
@Component({
  selector: 'trn-composer-voice-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconButton, TrnIconComponent],
  templateUrl: './composer-voice-bar.component.html',
  styleUrl: './composer-voice-bar.component.scss',
})
export class ComposerVoiceBarComponent {
  private readonly cancelButton =
    viewChild.required<ElementRef<HTMLButtonElement>>('cancelButton');

  /** Elapsed recording time, already formatted. */
  readonly timeLabel = input.required<string>();
  readonly sendBlocked = input(false);

  readonly cancelRecording = output<void>();
  readonly sendRecording = output<void>();

  /** Land keyboard focus on cancel, the safe default for a bar that just appeared. */
  focusCancel(): void {
    this.cancelButton().nativeElement.focus();
  }
}
