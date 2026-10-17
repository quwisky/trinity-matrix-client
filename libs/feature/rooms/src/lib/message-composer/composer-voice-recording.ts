import {
  computed,
  signal,
  type DestroyRef,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnToastService } from '@trinity/components/overlay';
import { VoiceRecorderService } from '@trinity/platform-native';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import type { ComposerAttachmentsHost } from './composer-attachments.service';

/**
 * The voice-clip workflow of {@link ComposerAttachmentsService}: the microphone, the recording
 * timer and the send. Not injectable; the service constructs it and passes its own `DestroyRef`,
 * so the timer and the mic are released with the composer.
 */
export class ComposerVoiceRecording {
  /** Elapsed recording time in seconds, for the live timer. */
  private readonly voiceElapsed = signal(0);
  /** Interval handle for the recording timer, cleared on stop/cancel/destroy. */
  private voiceTimer: ReturnType<typeof setInterval> | null = null;
  /** True between a start() call and its mic-acquisition resolving (re-entry guard). */
  private voiceStarting = false;
  /** Set on teardown so an in-flight mic acquisition can abort instead of orphaning. */
  private destroyed = false;

  /** True while a voice message is being recorded. */
  readonly recordingVoice: WritableSignal<boolean> = signal(false);
  /** `m:ss` label for the running recording timer. */
  readonly voiceTimeLabel: Signal<string> = computed(() => {
    const total = this.voiceElapsed();
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  });

  constructor(
    private readonly voiceRecorder: VoiceRecorderService,
    private readonly toast: TrnToastService,
    private readonly timelineActions: TimelineActionsService,
    private readonly destroyRef: DestroyRef,
    private readonly host: () => ComposerAttachmentsHost,
  ) {
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

  /** Begin recording a voice message; toasts and resets if the mic is unavailable. */
  async startVoiceRecording(): Promise<void> {
    // Guard re-entry: `recordingVoice` isn't set until the async mic acquisition resolves, so a
    // second click would open a second mic stream and orphan the first. `voiceStarting` closes
    // that window synchronously.
    if (this.recordingVoice() || this.voiceStarting) {
      return;
    }
    this.voiceStarting = true;
    const roomAtStart = this.host().roomId();
    try {
      await this.voiceRecorder.start();
    } catch {
      this.voiceStarting = false;
      this.toast.show('Could not access the microphone.', {
        duration: 4000,
        variant: 'danger',
      });
      return;
    }
    this.voiceStarting = false;
    // The view may have been torn down, or the room switched, during acquisition: don't leave
    // a stream open, and never bind the clip to a room the user has since left.
    if (this.destroyed || this.host().roomId() !== roomAtStart) {
      this.voiceRecorder.cancel();
      return;
    }
    this.recordingVoice.set(true);
    // Recording replaces the input, so leave preview before the recording controls take over.
    this.host().leavePreview();
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
        // A voice message is standalone: drop any active reply, as media does.
        this.host().endReply();
        this.timelineActions
          .sendVoiceMessage(recording)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            error: () =>
              this.toast.show('Could not send that voice message.', {
                duration: 4000,
                variant: 'danger',
              }),
          });
      })
      // Zoneless: an unhandled rejection here would go nowhere at all.
      .catch(() =>
        this.toast.show('Could not finish that voice recording.', {
          duration: 4000,
          variant: 'danger',
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
}
