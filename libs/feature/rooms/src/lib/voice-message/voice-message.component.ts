import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TrnIconButton } from '@trinity/components/controls';
import { Subscription, finalize } from 'rxjs';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { TrnIconComponent } from '@trinity/components/foundations';

/** The fetched clip: whose it is, its pinned URL once resolved, and the resolve. */
interface OpenClip {
  readonly media: PresentedMediaReference;
  url: string | null;
  sub: Subscription;
}

/** Bars whose height is scaled from a `[0, 1024]` waveform amplitude. */
const WAVEFORM_FULL = 1024;
/** Shortest bar (percent) so a near-silent sample is still visible. */
const MIN_BAR_HEIGHT = 12;

/**
 * A compact player for an MSC3245 voice message: a play/pause button, the recorded
 * waveform (bars filled up to the playback position), and a running time. The waveform and
 * length come from the event, so nothing is downloaded until the reader first presses play;
 * the clip's bytes are then resolved through {@link MediaPipeline} (the same
 * authenticated/decrypting path as other media) and played via a hidden `<audio>` element.
 * Once the clip has played to its end, or the row goes, it is dropped from the media cache;
 * playing it again fetches it again.
 */
@Component({
  selector: 'trn-voice-message',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconButton, TrnIconComponent],
  templateUrl: './voice-message.component.html',
  styleUrl: './voice-message.component.scss',
})
export class VoiceMessageComponent {
  readonly media = input.required<PresentedMediaReference>();

  private readonly mediaPipeline = inject(MediaPipeline);
  private readonly audio = viewChild<ElementRef<HTMLAudioElement>>('audio');

  /** Resolved (blob) URL for the audio; null until the reader plays it, and after it ends. */
  readonly src = signal<string | null>(null);
  /** The clip is being fetched after a press of play. */
  readonly loading = signal(false);
  readonly playing = signal(false);
  /** Elapsed playback in seconds (drives the timer + waveform fill). */
  private readonly elapsed = signal(0);

  /** Waveform amplitudes (`[0, 1024]`); empty when the sender sent none. */
  readonly bars = computed(() => this.media().waveform ?? []);

  /** Total clip length in seconds (from the event's declared duration). */
  private readonly durationSec = computed(() =>
    Math.round((this.media().durationMs ?? 0) / 1000),
  );

  /** Fraction of the clip played so far, in `[0, 1]`. */
  private readonly fraction = computed(() => {
    const total = this.durationSec();
    return total > 0 ? Math.min(1, this.elapsed() / total) : 0;
  });

  /** How many leading bars to render as "played". */
  readonly playedBars = computed(() =>
    Math.round(this.fraction() * this.bars().length),
  );

  /** The time to show: elapsed while playing, otherwise the total length. */
  readonly timeLabel = computed(() =>
    formatTime(this.playing() ? this.elapsed() : this.durationSec()),
  );

  /**
   * The fetched clip: the message it belongs to (rows are reused), its URL once resolved
   * (pinned while bound to `<audio>`), and the resolve.
   */
  private clip: OpenClip | null = null;

  constructor() {
    effect(() => {
      this.media();
      // A reused row shows another message: the previous one's clip goes.
      untracked(() => this.dropClip());
    });
    inject(DestroyRef).onDestroy(() => this.dropClip());
  }

  barHeight(amplitude: number): number {
    return Math.max(MIN_BAR_HEIGHT, (amplitude / WAVEFORM_FULL) * 100);
  }

  toggle(): void {
    if (this.loading()) {
      return;
    }
    const el = this.audio()?.nativeElement;
    if (!el) {
      this.load();
    } else if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  }

  /** The fetched clip can play: start it, as the press that fetched it asked. */
  onLoaded(): void {
    void this.audio()?.nativeElement.play();
  }

  onPlay(): void {
    this.playing.set(true);
  }

  onPause(): void {
    this.playing.set(false);
  }

  onTimeUpdate(): void {
    const el = this.audio()?.nativeElement;
    this.elapsed.set(Math.floor(el?.currentTime ?? 0));
  }

  onEnded(): void {
    this.playing.set(false);
    this.elapsed.set(0);
    this.dropClip();
  }

  /** Fetch the clip on the first press of play; it starts once loaded ({@link onLoaded}). */
  private load(): void {
    const clip: OpenClip = {
      media: this.media(),
      url: null,
      sub: Subscription.EMPTY,
    };
    this.clip = clip;
    this.loading.set(true);
    clip.sub = this.mediaPipeline
      .resolveMedia(clip.media, 'full')
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (url) => {
          // Pinned while bound to <audio>: the shared media cache would otherwise
          // evict/revoke it under pressure mid-playback.
          this.mediaPipeline.pin(url);
          clip.url = url;
          this.src.set(url);
        },
        // A failed fetch leaves nothing to keep, so the next press tries again.
        error: () => {
          if (this.clip === clip) this.clip = null;
        },
      });
  }

  /** Free the clip: cancel its fetch or drop its bytes, and unbind it from `<audio>`. */
  private dropClip(): void {
    const clip = this.clip;
    if (!clip) return;
    this.clip = null;
    // Unsubscribe first: a drop cancels a fetch only once nobody waits for it.
    clip.sub.unsubscribe();
    this.mediaPipeline.drop(clip.media, 'full', clip.url);
    this.src.set(null);
    this.playing.set(false);
    this.elapsed.set(0);
  }
}

/** Format seconds as `m:ss`. */
function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
