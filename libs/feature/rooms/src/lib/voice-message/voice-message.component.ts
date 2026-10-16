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
/** Narrowest bar, and the gap between bars; the gap matches `.voice__wave` in the styles. */
const BAR_PX = 2;
const BAR_GAP_PX = 2;

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
  private readonly wave = viewChild<ElementRef<HTMLElement>>('wave');
  /** The wave's laid-out width in px; null until it has been measured. */
  private readonly waveWidth = signal<number | null>(null);

  /** Resolved (blob) URL for the audio; null until the reader plays it, and after it ends. */
  readonly src = signal<string | null>(null);
  /** The clip is being fetched after a press of play. */
  readonly loading = signal(false);
  /** The last attempt to fetch the clip failed; Play tries again. */
  readonly failed = signal(false);
  readonly playing = signal(false);
  /** Elapsed playback in seconds (drives the timer + waveform fill). */
  private readonly elapsed = signal(0);

  /** The sender's waveform amplitudes (`[0, 1024]`); empty when the sender sent none. */
  private readonly samples = computed(() => this.media().waveform ?? []);

  /**
   * The wave's natural width: every sample as a narrowest bar. A wide bubble sizes itself
   * to this (up to its cap); a narrow one shrinks the wave instead of pushing out the time.
   */
  readonly waveNaturalWidth = computed(() =>
    Math.max(0, this.samples().length * (BAR_PX + BAR_GAP_PX) - BAR_GAP_PX),
  );

  /**
   * How many bars fit the measured wave (all of them until it is measured). A number, so a
   * resize that fits the same count changes nothing downstream.
   */
  private readonly barCount = computed(() => {
    const total = this.samples().length;
    const width = this.waveWidth();
    if (width === null || width <= 0) return total;
    const fit = Math.floor((width + BAR_GAP_PX) / (BAR_PX + BAR_GAP_PX));
    return Math.min(total, Math.max(1, fit));
  });

  /** The bars drawn: the waveform, sampled down to as many bars as fit the wave. */
  readonly bars = computed(() =>
    resampleWaveform(this.samples(), this.barCount()),
  );

  /** Total clip length in seconds (from the event's declared duration). */
  private readonly durationSec = computed(() =>
    Math.round((this.media().durationMs ?? 0) / 1000),
  );

  /** Fraction of the clip played so far, in `[0, 1]`. */
  private readonly fraction = computed(() => {
    const total = this.durationSec();
    return total > 0 ? Math.min(1, this.elapsed() / total) : 0;
  });

  /** How many leading bars (of those drawn) to render as "played". */
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
      const media = this.media();
      // A reused row shows another message: the previous one's clip goes. A receipt, a
      // reaction or the remote echo re-projects the same message with a new reference to the
      // same file: its clip keeps loading or playing.
      untracked(() => {
        const clip = this.clip;
        if (clip && this.mediaPipeline.sameMedia(clip.media, media)) return;
        this.dropClip();
        this.failed.set(false);
      });
    });
    inject(DestroyRef).onDestroy(() => this.dropClip());
    // The wave flexes with the bubble, which a narrow screen squeezes; measure it so it
    // draws only the bars that fit and the time beside it is never pushed out.
    effect((onCleanup) => {
      const el = this.wave()?.nativeElement;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(([entry]) => {
        if (entry) this.waveWidth.set(entry.contentRect.width);
      });
      observer.observe(el);
      onCleanup(() => observer.disconnect());
    });
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
      this.start(el);
    } else {
      el.pause();
    }
  }

  /** The fetched clip can play: start it, as the press that fetched it asked. */
  onLoaded(): void {
    const el = this.audio()?.nativeElement;
    if (el) this.start(el);
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

  /**
   * Start playback. A host may refuse (autoplay policy after a long fetch); the reader then
   * presses Play again, so the refusal is not an error.
   */
  private start(el: HTMLAudioElement): void {
    el.play().catch(() => undefined);
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
    this.failed.set(false);
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
          if (this.clip !== clip) return;
          this.clip = null;
          this.failed.set(true);
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

/**
 * Sample `samples` down to at most `count` bars, each the peak of its share of the
 * waveform so short loud moments survive. A waveform that already fits is returned as is.
 */
function resampleWaveform(
  samples: readonly number[],
  count: number,
): readonly number[] {
  if (samples.length <= count) return samples;
  return Array.from({ length: count }, (_, i) =>
    Math.max(
      ...samples.slice(
        Math.floor((i * samples.length) / count),
        Math.floor(((i + 1) * samples.length) / count),
      ),
    ),
  );
}

/** Format seconds as `m:ss`. */
function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
