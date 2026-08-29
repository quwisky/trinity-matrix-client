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
import {
  MediaPickerService,
  VoiceRecorderService,
} from '@trinity/platform-native';
import {
  GifService,
  GifSettingsService,
  type GifResult,
} from '@trinity/data-access/gif';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import { MediaPipeline } from '@trinity/data-access/media';
import { CreatePollService } from '../poll/create-poll.service';
import { LocationShareService } from '../location-share/location-share.service';
import {
  releaseAttachment,
  stageAttachment,
  type StagedAttachment,
} from './staged-attachment';
import { type BatchProgress } from '../shared/send-media-batch';

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
  /** Which file of how many is uploading and how far along, else null (idle). */
  readonly uploadProgress: Signal<BatchProgress | null>;
  /** Send a file as a media message, with `caption` as its caption. */
  sendMedia(attachment: StagedAttachment, caption: string): void;
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
  private readonly mediaPipeline = inject(MediaPipeline);
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

  private readonly _staged = signal<readonly StagedAttachment[]>([]);
  /**
   * Picked/pasted/dropped attachments held for a caption, sent on the next submit (Enter /
   * send button) — not uploaded immediately. In the order they were staged, which is the
   * order they are sent in.
   *
   * Read-only outward, unlike its scalar predecessors: the object URLs inside are owned by
   * this service and a write from outside would leak them.
   */
  readonly staged = this._staged.asReadonly();
  /** Whether anything is staged — the question nearly every caller actually asks. */
  readonly hasStaged = computed(() => this._staged().length > 0);
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
    // Revoke EVERY staged preview on teardown. The scalar version revoked exactly one, which
    // was sufficient only because at most one URL could be live at a time.
    this.destroyRef.onDestroy(() => this.clearStaged());
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
        .pickImages()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (files) => this.stageAll(files),
          // A user-cancel resolves to null above; this catches a denied photo
          // permission (or a genuine picker failure) instead of leaving it
          // unhandled, and shows the reason.
          error: (err: unknown) => void this.showAttachError(err),
        });
    } else {
      this.host.openFileDialog();
    }
  }

  /** Hidden file input change → stage every picked file, then reset for re-picking. */
  filePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.stageAll(Array.from(input.files ?? []));
    input.value = ''; // let the same file be picked again
  }

  /**
   * Paste an image from the clipboard → send it as an attachment (Discord-style),
   * via the same media path as the picker. Pasted images land in `files` on most
   * engines; some (older WebKit) expose them only as `items` of kind `file`. Text
   * paste is left untouched.
   */
  paste(event: ClipboardEvent): void {
    // While editing, attachments are disabled (an edit can't become media), so let the paste
    // fall through to the textarea. An upload in flight is NOT a reason to refuse any more:
    // a send takes the whole batch at once, so anything staged during one simply waits for
    // the next press instead of being lost to it.
    if (this.host.editing()) {
      return;
    }
    const data = event.clipboardData;
    if (!data) {
      return;
    }
    let images: File[] = Array.from(data.files).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (!images.length) {
      images = Array.from(data.items)
        .filter(
          (item) => item.kind === 'file' && item.type.startsWith('image/'),
        )
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
    }
    if (images.length) {
      event.preventDefault(); // don't also drop the raw image into the textarea
      this.stageAll(images);
    }
  }

  /** Drop every staged attachment (Escape, room change, or after they're sent). */
  clearStaged(): void {
    for (const attachment of this._staged()) {
      releaseAttachment(attachment, this.mediaPipeline);
    }
    this._staged.set([]);
  }

  /** Drop one staged attachment (its × button), keeping the rest. */
  /**
   * Flag these items as failed. Anything not named keeps the flag it already has.
   *
   * Scoped deliberately, because a caller only ever knows about its own send: reporting one
   * retried file's outcome must say nothing about the other files that failed alongside it,
   * and a GIF — dispatched with a synthetic id that matches nothing staged — must say nothing
   * about any of them.
   */
  markFailed(ids: readonly string[]): void {
    this.setFailedFlag(ids, true);
  }

  /** Clear the failed flag on these items. Anything not named keeps the flag it has. */
  clearFailed(ids: readonly string[]): void {
    this.setFailedFlag(ids, false);
  }

  private setFailedFlag(ids: readonly string[], failed: boolean): void {
    const targets = new Set(ids);
    this._staged.update(
      (current) =>
        current.some(
          (attachment) =>
            targets.has(attachment.id) && attachment.failed !== failed,
        )
          ? current.map((attachment) =>
              targets.has(attachment.id) && attachment.failed !== failed
                ? { ...attachment, failed }
                : attachment,
            )
          : current, // nothing changed: don't hand the strip a new array to re-render
    );
  }

  removeStaged(id: string): void {
    const current = this._staged();
    const doomed = current.find((attachment) => attachment.id === id);
    if (!doomed) {
      return; // unknown id: leave the array identity alone rather than re-rendering the strip
    }
    releaseAttachment(doomed, this.mediaPipeline);
    this._staged.set(current.filter((attachment) => attachment !== doomed));
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
          const [attachment] = this.stageAll([file]);
          if (attachment) this.host.sendMedia(attachment, '');
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

  /**
   * Hold picked/pasted files for a caption instead of sending immediately, appending to
   * whatever is already staged so a second pick adds rather than replaces.
   */
  /**
   * Stage files from a source outside the composer's own controls (a drop on the room).
   *
   * Same refusal as {@link paste}: an edit cannot become media. An upload in flight is not a
   * refusal — the batch goes out on the next press, so these simply join the queue.
   */
  stageExternal(files: readonly File[]): void {
    if (this.host.editing()) {
      return;
    }
    this.stageAll(files);
  }

  private stageAll(files: readonly File[]): readonly StagedAttachment[] {
    if (!files.length) {
      return [];
    }
    const added = files
      .map((file) => stageAttachment(file, this.mediaPipeline))
      .filter(
        (attachment): attachment is StagedAttachment => attachment !== null,
      );
    if (!added.length) {
      this.toast.show('Empty attachments cannot be sent.', {
        duration: 4000,
        variant: 'destructive',
      });
      return [];
    }
    this._staged.update((current) => [...current, ...added]);
    this.host.focusInput();
    return added;
  }

  /** Surface a gallery-picker failure (notably denied photo access) as a toast. */
  private showAttachError(err: unknown): void {
    this.toast.show(
      err instanceof Error ? err.message : 'Could not open the gallery.',
      { duration: 4000, variant: 'destructive' },
    );
  }
}
