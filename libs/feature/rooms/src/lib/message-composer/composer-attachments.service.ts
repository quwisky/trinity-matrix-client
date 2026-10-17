import {
  DestroyRef,
  Injectable,
  Injector,
  computed,
  inject,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  catchError,
  defaultIfEmpty,
  distinctUntilChanged,
  finalize,
  firstValueFrom,
  map,
  of,
  switchMap,
  take,
  timeout,
  type Observable,
} from 'rxjs';
import { TrnToastService } from '@trinity/components/overlay';
import {
  AppSettingsService,
  CapturePermissionDeniedError,
  CaptureTooLargeError,
  MediaPickerService,
  NoCameraError,
  PrivacySettingsService,
  captureModeFor,
  isInstalledNativePlatform,
  isMobileOs,
  type CaptureKind,
  type CaptureMode,
  type CapturePermission,
} from '@trinity/platform-native';
import {
  GifService,
  GifSettingsService,
  type GifResult,
} from '@trinity/data-access/gif';
import { MediaPipeline, type MediaHints } from '@trinity/data-access/media';
import { ComposerVoiceRecording } from './composer-voice-recording';
import { CreatePollService } from '../poll/create-poll.service';
import { LocationShareService } from '../location-share/location-share.service';
import {
  releaseAttachment,
  stageAttachment,
  type StagedAttachment,
} from './staged-attachment';
import { type BatchProgress } from '../shared/send-media-batch';
import {
  effectiveUploadLimit,
  tooLargeMessage,
  type UploadLimit,
} from './upload-limit';

/**
 * What the attachment workflows need back from the composer that owns them: its input state, and
 * the actions only it can take (it owns the textarea, the reply banner and the outputs). Passed
 * once via {@link ComposerAttachmentsService.connect} and called synchronously.
 */
export interface ComposerAttachmentsHost {
  /** Active room/thread id — a recording is abandoned if it changes mid-acquisition. */
  readonly roomId: Signal<string | null>;
  /** Account the composer sends as — whose homeserver's upload limit applies. */
  readonly accountId: Signal<string | null>;
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
  /** Close the expression panel — a chosen GIF has arrived and is on its way. */
  closePicker(): void;
  /** Open the composer's hidden file input (no native gallery picker available). */
  openFileDialog(): void;
  /** Open the hidden capture input for a photo or a video (mobile web). */
  openCaptureInput(kind: CaptureKind): void;
}

/**
 * Every way something other than typed text gets into a message: a picked, pasted or dropped
 * file staged for a caption, a GIF, a poll, a location and a voice clip.
 *
 * Provided by {@link MessageComposerComponent}, not root: the room and thread composers are alive
 * at once and each needs its own staged files, GIF grid and recording. The component scope also
 * makes `DestroyRef` the composer's own, so the recording timer, the mic and staged object URLs
 * are released with it.
 */
@Injectable()
export class ComposerAttachmentsService {
  private readonly picker = inject(MediaPickerService);
  private readonly toast = inject(TrnToastService);
  private readonly createPollSvc = inject(CreatePollService);
  private readonly locationShare = inject(LocationShareService);
  private readonly gifs = inject(GifService);
  private readonly gifSettings = inject(GifSettingsService);
  private readonly mediaPipeline = inject(MediaPipeline);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly appSettings = inject(AppSettingsService);
  /** True from a native capture's start until it settles (re-entry guard). */
  private capturing = false;
  /** The Android or iOS app, whose WebView gets the smaller fallback upload ceiling. */
  private readonly nativeMobile = isInstalledNativePlatform();

  /**
   * The composer these workflows act on. Deliberately not optional: an unwired service throws
   * rather than silently swallowing a send.
   */
  private host!: ComposerAttachmentsHost;
  private readonly voice: ComposerVoiceRecording;

  private readonly _staged = signal<readonly StagedAttachment[]>([]);
  /**
   * Picked/pasted/dropped attachments held for a caption and sent on the next submit, not
   * uploaded immediately; in staging order, which is the send order.
   *
   * Read-only outward: the object URLs inside are owned by this service and an outside write
   * would leak them.
   */
  readonly staged = this._staged.asReadonly();
  /** Whether anything is staged — the question nearly every caller actually asks. */
  readonly hasStaged = computed(() => this._staged().length > 0);
  /** True while a chosen GIF is being fetched, before its media upload starts. */
  readonly gifDownloading = signal(false);
  /** True while a voice message is being recorded. */
  readonly recordingVoice: WritableSignal<boolean>;
  /** `m:ss` label for the running recording timer. */
  readonly voiceTimeLabel: Signal<string>;
  /** The GIF affordance is offered only once a provider + API key are configured. */
  readonly gifEnabled = computed(() => this.gifSettings.configured());
  /** True while a location is being resolved and sent (drives the button's busy state). */
  readonly locationSharing = this.locationShare.sharing;
  /** How this host takes photos and videos; fixed for the life of the page. */
  readonly captureMode: CaptureMode = captureModeFor(
    this.picker.captureSupported === true,
    isMobileOs(),
  );
  /** Which permission a capture was refused, while its notice shows; else null. */
  readonly captureNotice = signal<CapturePermission | null>(null);
  /** The notice's sentence, also announced through the composer's persistent live region. */
  readonly captureNoticeMessage = computed(() =>
    captureNoticeCopy(this.captureNotice()),
  );
  /** Whether "Open settings" can take the user to Trinity's system settings page. */
  readonly canOpenSettings = this.appSettings.available;

  constructor() {
    this.destroyRef.onDestroy(() => this.clearStaged());
    this.voice = new ComposerVoiceRecording(() => this.host);
    this.recordingVoice = this.voice.recordingVoice;
    this.voiceTimeLabel = this.voice.voiceTimeLabel;
  }

  /** Whether this device can record voice (mic + MediaRecorder present). */
  get voiceSupported(): boolean {
    return this.voice.voiceSupported;
  }

  /** Begin recording a voice message; toasts and resets if the mic is unavailable. */
  startVoiceRecording(): Promise<void> {
    return this.voice.startVoiceRecording();
  }

  /** Stop recording and send the clip as a voice message. */
  stopVoiceRecording(): void {
    this.voice.stopVoiceRecording();
  }

  /** Abort the recording, discarding the clip. */
  cancelVoiceRecording(): void {
    this.voice.cancelVoiceRecording();
  }
  dismissCaptureNotice(): void {
    this.captureNotice.set(null);
  }

  openCaptureSettings(): void {
    this.captureNotice.set(null);
    this.appSettings
      .openAppSettings()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Bind the workflows to their composer. Called once, from its constructor. */
  connect(host: ComposerAttachmentsHost): void {
    this.host = host;
    this.prewarmUploadLimit();
  }

  /**
   * Ask for the active account's upload limit as soon as it is known, so a pick or capture
   * normally hits the media service's per-client cache. Only warms that cache: the size checks
   * still make their own bounded lookup, and a failure here is left to them.
   */
  private prewarmUploadLimit(): void {
    toObservable(this.host.accountId, { injector: this.injector })
      .pipe(
        distinctUntilChanged(),
        switchMap((accountId) =>
          this.mediaPipeline.uploadLimit(accountId).pipe(
            take(1),
            catchError(() => EMPTY),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  /** Attach button: native gallery picker on device, else the hidden file input. */
  attach(): void {
    if (this.picker.available) {
      // The picker refuses an oversized photo by reported size before reading it; the limit may
      // still be resolving.
      const limit = firstValueFrom(this.uploadLimit());
      this.picker
        .pickImages(limit.then((settled) => settled.bytes))
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: ({ files, oversized }) => {
            if (oversized > 0) {
              void limit.then((settled) =>
                this.showTooLarge(tooLargeMessage('file', settled, oversized)),
              );
            }
            this.stagePicked(files);
          },
          // A user-cancel resolves to null, so this is a denied photo permission or a picker
          // failure.
          error: (err: unknown) => void this.showAttachError(err),
        });
    } else {
      this.host.openFileDialog();
    }
  }

  /** Hidden file input change → stage every picked file, then reset for re-picking. */
  filePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.stagePicked(Array.from(input.files ?? []));
    input.value = ''; // let the same file be picked again
  }

  /** Take photo / Record video: the native camera on device, the capture input on a phone browser. */
  capture(kind: CaptureKind): void {
    if (this.host.editing()) return;
    if (this.captureMode === 'web') {
      // Synchronous, inside the tap: a browser only opens a file input from a user gesture.
      this.host.openCaptureInput(kind);
      return;
    }
    if (this.captureMode !== 'native' || this.capturing) return;
    this.capturing = true;
    this.captureNotice.set(null);
    const roomAtStart = this.host.roomId();
    const saveToGallery = this.privacy.saveCapturesToGallery();
    // The camera opens at once; the picker awaits the limit only once a capture comes back, so a
    // slow media-config request never delays the viewfinder. The lookup always settles to a
    // limit, so this promise never rejects unawaited when the capture is cancelled.
    const limit = firstValueFrom(this.uploadLimit());
    const options = {
      saveToGallery,
      maxBytes: limit.then((settled) => settled.bytes),
    };
    (kind === 'photo'
      ? this.picker.capturePhoto(options)
      : this.picker.captureVideo(options)
    )
      .pipe(
        finalize(() => (this.capturing = false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (captured) => {
          // A capture belongs to the room it was started in, as a recording does.
          if (!captured || this.host.roomId() !== roomAtStart) return;
          this.stageCapture(captured.file, captured.hints);
        },
        error: (err: unknown) => this.showCaptureError(kind, err, limit),
      });
  }

  /** A capture input's change → stage its one file, if it is within the upload limit. */
  captureInputPicked(event: Event, kind: CaptureKind): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = ''; // the same capture can be retaken
    if (!file) return;
    const roomAtStart = this.host.roomId();
    this.uploadLimit()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((limit) => {
        if (this.host.roomId() !== roomAtStart) return;
        if (file.size > limit.bytes) {
          this.showTooLarge(tooLargeMessage(kind, limit));
          return;
        }
        this.stageCapture(file);
      });
  }

  /** Put a capture into the composer as a pending attachment, through the picked-file path. */
  stageCapture(file: File, hints?: MediaHints): StagedAttachment | null {
    if (this.host.editing()) return null;
    return this.stageAll([file], hints)[0] ?? null;
  }

  /**
   * Stage a pasted clipboard image through the same media path as the picker. Most engines put
   * pasted images in `files`; some (older WebKit) expose them only as `items` of kind `file`.
   * Text paste is left untouched.
   */
  paste(event: ClipboardEvent): void {
    // While editing, attachments are disabled (an edit can't become media), so let the paste
    // fall through to the textarea. An upload in flight is not a reason to refuse: a send takes
    // the whole batch at once, so anything staged meanwhile waits for the next press.
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
      this.stagePicked(images);
    }
  }

  /** Drop every staged attachment (Escape, room change, or after they're sent). */
  clearStaged(): void {
    for (const attachment of this._staged()) {
      releaseAttachment(attachment, this.mediaPipeline);
    }
    this._staged.set([]);
  }

  /**
   * Flag these items as failed. Anything not named keeps the flag it already has.
   *
   * Scoped deliberately, because a caller only knows its own send: one retried file's outcome
   * must say nothing about other files that failed alongside it, and a GIF (synthetic id that
   * matches nothing staged) must say nothing about any of them.
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

  /** Drop one staged attachment (its × button), keeping the rest. */
  removeStaged(id: string): void {
    const current = this._staged();
    const doomed = current.find((attachment) => attachment.id === id);
    if (!doomed) {
      return; // unknown id: leave the array identity alone rather than re-rendering the strip
    }
    releaseAttachment(doomed, this.mediaPipeline);
    this._staged.set(current.filter((attachment) => attachment !== doomed));
  }

  /**
   * Download the chosen GIF and send it at once through the media path, which serves rooms and
   * threads, encrypted or not.
   */
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
          this.host.closePicker();
          // A media send carries no reply relation; end any active reply so its banner doesn't
          // linger over the next message.
          this.host.endReply();
          const [attachment] = this.stageAll([file]);
          if (attachment) this.host.sendMedia(attachment, '');
        },
        error: () => {
          this.gifDownloading.set(false);
          this.toast.show('Could not load that GIF.', {
            duration: 4000,
            variant: 'danger',
          });
        },
      });
  }

  /** Open the create-poll dialog (starts a poll in the active room on confirm). */
  openPollDialog(): void {
    this.createPollSvc
      .open$()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Share the device's current location to the active room. */
  shareLocation(): void {
    this.locationShare.share();
  }

  /**
   * Stage files from a source outside the composer's own controls (a drop on the room).
   *
   * Same refusal as {@link paste}: an edit cannot become media. An upload in flight is not a
   * refusal; the batch goes out on the next press, so these join the queue.
   */
  stageExternal(files: readonly File[]): void {
    if (this.host.editing()) {
      return;
    }
    this.stagePicked(files);
  }

  /**
   * Stage files the user chose (picked, pasted or dropped) that are within the upload limit,
   * refusing the rest by their reported size before anything reads them — a long video can be
   * hundreds of MB, and sending reads it whole into the WebView. Like a capture, the files
   * belong to the room they were chosen in.
   */
  private stagePicked(files: readonly File[]): void {
    if (!files.length) {
      return;
    }
    const roomAtStart = this.host.roomId();
    this.uploadLimit()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((limit) => {
        // Re-checked once the limit is in: the room may have changed, or an edit begun.
        if (this.host.roomId() !== roomAtStart || this.host.editing()) return;
        const fitting = files.filter((file) => file.size <= limit.bytes);
        const refused = files.length - fitting.length;
        if (refused > 0) {
          this.showTooLarge(tooLargeMessage('file', limit, refused));
        }
        this.stageAll(fitting);
      });
  }

  /** Hold files for a caption instead of sending; appends, so a second pick adds, not replaces. */
  private stageAll(
    files: readonly File[],
    hints?: MediaHints,
  ): readonly StagedAttachment[] {
    if (!files.length) {
      return [];
    }
    const added = files
      .map((file) => stageAttachment(file, this.mediaPipeline, hints))
      .filter(
        (attachment): attachment is StagedAttachment => attachment !== null,
      );
    if (!added.length) {
      this.toast.show('Empty attachments cannot be sent.', {
        duration: 4000,
        variant: 'danger',
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
      { duration: 4000, variant: 'danger' },
    );
  }

  /**
   * The upload limit for the composer's account, once; always emits. Bounded: the media-config
   * request has no timeout of its own, and a hung one must never hold up a capture or a pick —
   * after {@link UPLOAD_LIMIT_WAIT_MS}, or on a failed or empty lookup, the homeserver's limit
   * is treated as unknown and this device's fallback ceiling applies.
   */
  private uploadLimit(): Observable<UploadLimit> {
    return this.mediaPipeline.uploadLimit(this.host.accountId()).pipe(
      take(1),
      timeout({ first: UPLOAD_LIMIT_WAIT_MS, with: () => of(null) }),
      catchError(() => of(null)),
      defaultIfEmpty(null),
      map((bytes) => effectiveUploadLimit(bytes, this.nativeMobile)),
    );
  }

  /**
   * Denials become the inline notice; everything else a toast naming the cause. An over-limit
   * capture names the limit it was held to, which `limit` has settled to by the time it fails.
   */
  private showCaptureError(
    kind: CaptureKind,
    err: unknown,
    limit: Promise<UploadLimit>,
  ): void {
    if (err instanceof CapturePermissionDeniedError) {
      this.captureNotice.set(err.permission);
      return;
    }
    if (err instanceof CaptureTooLargeError) {
      void limit.then((settled) =>
        this.showTooLarge(tooLargeMessage(kind, settled)),
      );
      return;
    }
    this.toast.show(
      err instanceof NoCameraError
        ? 'This device has no camera.'
        : kind === 'photo'
          ? 'Could not take a photo. Try again.'
          : 'Could not record a video. Try again.',
      { duration: 4000, variant: 'danger' },
    );
  }

  private showTooLarge(message: string): void {
    this.toast.show(message, { duration: 6000, variant: 'danger' });
  }
}

/** How long a size check waits for the homeserver's upload limit before going without it. */
const UPLOAD_LIMIT_WAIT_MS = 3000;

function captureNoticeCopy(permission: CapturePermission | null): string {
  switch (permission) {
    case 'camera':
      return "Trinity can't use the camera. Allow camera access in your device settings.";
    case 'photos':
      return "Trinity can't save to your photo library. Allow photo access in your device settings, or turn off saving under Privacy.";
    default:
      return '';
  }
}
