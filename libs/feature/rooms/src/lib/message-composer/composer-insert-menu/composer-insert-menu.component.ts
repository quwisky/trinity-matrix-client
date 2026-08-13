import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import {
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';
import { HlmSpinner } from '@trinity/helm/spinner';
import { HlmTooltip } from '@trinity/helm/tooltip';
import { TrnIconComponent } from '@trinity/helm/icon';

/**
 * The composer's `+`: every way something other than typed text gets into a message.
 *
 * A dropdown tray when there is more than one action to offer, a plain attach button when
 * there is not (see {@link hasMenu}). Presentational — the workflows behind the actions live in
 * `ComposerAttachmentsService`, and the host is `display: contents` so the button stays a
 * direct flex item of the composer's input row.
 */
@Component({
  selector: 'trn-composer-insert-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnIconComponent,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuTrigger,
    HlmSpinner,
    HlmTooltip,
  ],
  templateUrl: './composer-insert-menu.component.html',
  styleUrl: './composer-insert-menu.component.scss',
})
export class ComposerInsertMenuComponent {
  /** Whether the `+` opens a tray rather than acting as a plain attach button. */
  readonly hasMenu = input(false);
  /** Edit mode disables the whole tray — an edit can't become an attachment. */
  readonly editing = input(false);
  /** Whether an attachment upload is in flight (blocks another attachment only). */
  readonly uploading = input(false);
  /** Whether a GIF provider + API key are configured. */
  readonly gifEnabled = input(false);
  /** Whether a chosen GIF is being fetched. */
  readonly gifDownloading = input(false);
  /** Whether the room-scoped rich actions (poll, location, voice) are offered. */
  readonly richActions = input(false);
  /** Whether this device can record voice (mic + MediaRecorder present). */
  readonly voiceSupported = input(false);
  /** Whether a voice message is already being recorded. */
  readonly recording = input(false);
  /** Whether a location is being resolved and sent. */
  readonly locationSharing = input(false);

  readonly attachFile = output<void>();
  readonly pickGif = output<void>();
  readonly createPoll = output<void>();
  readonly shareLocation = output<void>();
  readonly recordVoice = output<void>();
}
