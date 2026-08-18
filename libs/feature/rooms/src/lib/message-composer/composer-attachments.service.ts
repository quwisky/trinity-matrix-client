import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnToastService } from '@trinity/components/overlay';
import { VoiceRecorderService } from '@trinity/platform-native';
import {
  GifService,
  GifSettingsService,
  type GifResult,
} from '@trinity/data-access/gif';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import { MediaPickerService } from '../media-picker/media-picker.service';
import { CreatePollService } from '../poll/create-poll.service';
import { LocationShareService } from '../location-share/location-share.service';

/**
 * What the attachment workflows need back from the composer that owns them.
 *
 * Everything here is either a piece of the composer's own input state or an action only the
 * composer can take (it owns the textarea, the reply banner and the outputs). Passed once via
 * {@link ComposerAttachmentsService.connect} and called synchronously, so each workflow runs at
 * exactly the point in the tick it used to run at when it lived in the component.
 */
export interface ComposerAttachmentsHost {
  /** Active room/thread id — a recording is abandoned if it changes mid-acquisition. */
  readonly roomId: Signal<string | null>;
  /** Whether the composer is in edit mode (an edit can't become media). */
  readonly editing: Signal<boolean>;
  /** Upload fraction in [0, 1] while an attachment uploads, else null (idle). */
  readonly uploadProgress: Signal<number | null>;
  /** Send a file as a media message, with `caption` as its caption. */
  sendMedia(file: File, caption: string): void;
  /** End any active reply — a media or voice send carries no reply relation. */
  endReply(): void;
  /** Put the caret back in the textarea (a file was just staged for a caption). */
  focusInput(): void;
  /** Drop out of the preview back to the input. */
  leavePreview(): void;
  /** Open the composer's hidden file input (no native gallery picker available). */
  openFileDialog(): void;
}

/**
 * Every way something other than typed text gets into a message: a picked, pasted or
 * dropped-in file staged for a caption, a GIF, a poll, a location and a voice clip.
 *
 * Provided by {@link MessageComposerComponent} rather than in root: the room composer and the
 * thread composer are alive at once and each needs its own staged file, GIF grid and recording.
 * That component scope is also what makes `DestroyRef` here the composer's own, so the recording
 * timer, the mic and a staged image's object URL are all released when the composer goes away.
 */
@Injectable()
export class ComposerAttachmentsService {
  private readonly picker = inject(MediaPickerService);
  private readonly toast = inject(TrnToastService);
  private readonly createPollSvc = inject(CreatePollService);
  private readonly locationShare = inject(LocationShareService);
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly voiceRecorder = inject(VoiceRecorderService);
  private readonly gifs = inject(GifService);
  private readonly gifSettings = inject(GifSettingsService);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The composer these workflows act on. Deliberately not optional: an unwired service throws
   * here rather than silently swallowing a send, the same call the room shell's navigation
   * service makes for its focus handoff.
   */
  private host!: ComposerAttachmentsHost;

  /** Elapsed recording time in seconds, for the live timer. */
  private readonly voiceElapsed = signal(0);
  /** Interval handle for the recording timer, cleared on stop/cancel/destroy. */
  private voiceTimer: ReturnType<typeof setInterval> | null = null;
  /** True between a start() call and its mic-acquisition resolving (re-entry guard). */
  private voiceStarting = false;
  /** Set on teardown so an in-flight mic acquisition can abort instead of orphaning. */
  private destroyed = false;

  /** A picked/pasted attachment held for a caption, sent on the next submit
   * (Enter / send button) — not uploaded immediately. */
  readonly pendingFile = signal<File | null>(null);
  /** Object URL previewing a staged image, else null (revoked on clear/destroy). */
  readonly pendingPreview = signal<string | null>(null);
  /** Whether the GIF search grid is open (mutually exclusive with the emoji picker). */
  readonly gifPickerOpen = signal(false);
  /** True while a chosen GIF is being fetched, before its media upload starts. */
  readonly gifDownloading = signal(false);
  /** True while a voice message is being recorded. */
  readonly recordingVoice = signal(false);
  /** `m:ss` label for the running recording timer. */
  readonly voiceTimeLabel = computed(() => {
    const total = this.voiceElapsed();
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  });
  /** The GIF affordance is offered only once a provider + API key are configured. */
  readonly gifEnabled = computed(() => this.gifSettings.configured());
  /** True while a location is being resolved and sent (drives the button's busy state). */
  readonly locationSharing = this.locationShare.sharing;

  constructor() {
    // Revoke a staged image's preview object URL on teardown.
    this.destroyRef.onDestroy(() => this.setPreview(null));
    // Stop a running recording timer (and release the mic) if torn down mid-record.
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.clearVoiceTimer();
      if (this.recordingVoice() || this.voiceStarting) {
        this.voiceRecorder.cancel();
      }
    });
  }

  /** Whether this device can record voice (mic + MediaRecorder present). */
  get voiceSupported(): boolean {
    return this.voiceRecorder.supported;
  }

  /** Bind the workflows to their composer. Called once, from its constructor. */
  connect(host: ComposerAttachmentsHost): void {
    this.host = host;
  }

  /** Attach button: native gallery picker on device, else the hidden file input. */
  attach(): void {
    if (this.picker.available) {
      this.picker
        .pickImage()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (file) => {
            if (file) {
              this.stagePending(file);
            }
          },
          // A user-cancel resolves to null above; this catches a denied photo
          // permission (or a genuine picker failure) instead of leaving it
          // unhandled, and shows the reason.
          error: (err: unknown) => void this.showAttachError(err),
        });
    } else {
      this.host.openFileDialog();
    }
  }

  /** Hidden file input change → stage the picked file, then reset for re-picking. */
  filePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.stagePending(file);
    }
    input.value = ''; // let the same file be picked again
  }

  /**
   * Paste an image from the clipboard → send it as an attachment (Discord-style),
   * via the same media path as the picker. Pasted images land in `files` on most
   * engines; some (older WebKit) expose them only as `items` of kind `file`. Text
   * paste is left untouched.
   */
  paste(event: ClipboardEvent): void {
    // While editing, attachments are disabled (an edit can't become media), so
    // let the paste fall through to the textarea. Also one upload at a time.
    if (this.host.editing() || this.host.uploadProgress() !== null) {
      return;
    }
    const data = event.clipboardData;
    if (!data) {
      return;
    }
    let image: File | null =
      Array.from(data.files).find((f) => f.type.startsWith('image/')) ?? null;
    if (!image) {
      for (const item of Array.from(data.items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          image = item.getAsFile();
          break;
        }
      }
    }
    if (image) {
      event.preventDefault(); // don't also drop the raw image into the textarea
      this.stagePending(image);
    }
  }

  /** Drop the staged attachment (× button, Escape, or after it's sent). */
  clearPending(): void {
    this.setPreview(null);
    this.pendingFile.set(null);
  }

  /** Toggle the GIF grid. The caller closes the emoji picker (only one at a time). */
  toggleGifPicker(): void {
    this.gifPickerOpen.set(!this.gifPickerOpen());
  }

  /** A GIF was chosen → download it and send it through the media path (works in
   * rooms and threads, encrypted or not). Sends immediately, like other GIF UIs. */
  gifSelected(gif: GifResult): void {
    if (this.gifDownloading()) {
      return;
    }
    this.gifDownloading.set(true);
    this.gifs
      .download(gif)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (file) => {
          this.gifDownloading.set(false);
          this.gifPickerOpen.set(false);
          // A media send carries no reply relation (see the composer's submit());
          // close any active reply so its banner doesn't linger over the next message.
          this.host.endReply();
          this.host.sendMedia(file, '');
        },
        error: () => {
          this.gifDownloading.set(false);
          this.toast.show('Could not load that GIF.', {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  /** Open the create-poll dialog (starts a poll in the active room on confirm). */
  openPollDialog(): void {
    void this.createPollSvc.open();
  }

  /** Share the device's current location to the active room. */
  shareLocation(): void {
    this.locationShare.share();
  }

  /** Begin recording a voice message; toasts and resets if the mic is unavailable. */
  async startVoiceRecording(): Promise<void> {
    // Guard re-entry: `recordingVoice` isn't set until the async mic acquisition
    // resolves, so a second click before then would open a second mic stream and
    // orphan the first. `voiceStarting` closes that window synchronously.
    if (this.recordingVoice() || this.voiceStarting) {
      return;
    }
    this.voiceStarting = true;
    const roomAtStart = this.host.roomId();
    try {
      await this.voiceRecorder.start();
    } catch {
      this.voiceStarting = false;
      this.toast.show('Could not access the microphone.', {
        duration: 4000,
        variant: 'destructive',
      });
      return;
    }
    this.voiceStarting = false;
    // The view may have been torn down, or the room switched, during acquisition —
    // don't leave a stream open / timer ticking (and never bind the clip to a room
    // the user has since left).
    if (this.destroyed || this.host.roomId() !== roomAtStart) {
      this.voiceRecorder.cancel();
      return;
    }
    this.recordingVoice.set(true);
    // Recording replaces the toolbar, and the preview toggle lives on it — leaving the
    // preview up would strand it with no way back to the input.
    this.host.leavePreview();
    this.voiceElapsed.set(0);
    this.voiceTimer = setInterval(
      () => this.voiceElapsed.update((s) => s + 1),
      1000,
    );
  }

  /** Stop recording and send the clip as a voice message. */
  stopVoiceRecording(): void {
    if (!this.recordingVoice()) {
      return;
    }
    this.clearVoiceTimer();
    this.recordingVoice.set(false);
    void this.voiceRecorder
      .stop()
      .then((recording) => {
        if (!recording || recording.blob.size === 0) {
          return;
        }
        // A voice message is standalone; drop any active reply (as media does).
        this.host.endReply();
        this.timelineActions
          .sendVoiceMessage(recording)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            error: () =>
              this.toast.show('Could not send that voice message.', {
                duration: 4000,
                variant: 'destructive',
              }),
          });
      })
      // Zoneless: an unhandled rejection here would go nowhere at all.
      .catch(() =>
        this.toast.show('Could not finish that voice recording.', {
          duration: 4000,
          variant: 'destructive',
        }),
      );
  }

  /** Abort the recording, discarding the clip. */
  cancelVoiceRecording(): void {
    if (!this.recordingVoice()) {
      return;
    }
    this.clearVoiceTimer();
    this.recordingVoice.set(false);
    this.voiceRecorder.cancel();
  }

  private clearVoiceTimer(): void {
    if (this.voiceTimer !== null) {
      clearInterval(this.voiceTimer);
      this.voiceTimer = null;
    }
  }

  /** Hold a picked/pasted file for a caption instead of sending immediately.
   * A preview object URL is made for images and revoked when it's replaced. */
  private stagePending(file: File): void {
    this.setPreview(
      file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    );
    this.pendingFile.set(file);
    this.host.focusInput();
  }

  /** Swap the preview object URL, revoking the previous one. */
  private setPreview(url: string | null): void {
    const prev = this.pendingPreview();
    if (prev && prev !== url) {
      URL.revokeObjectURL(prev);
    }
    this.pendingPreview.set(url);
  }

  /** Surface a gallery-picker failure (notably denied photo access) as a toast. */
  private showAttachError(err: unknown): void {
    this.toast.show(
      err instanceof Error ? err.message : 'Could not open the gallery.',
      { duration: 4000, variant: 'destructive' },
    );
  }
}
