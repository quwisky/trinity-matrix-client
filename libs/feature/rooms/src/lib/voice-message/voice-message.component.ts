import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { MediaService } from '@trinity/data-access/media';
import { type MediaPayload } from '@trinity/util/matrix';
import { TrnIconComponent } from '@trinity/helm/icon';

/** Bars whose height is scaled from a `[0, 1024]` waveform amplitude. */
const WAVEFORM_FULL = 1024;
/** Shortest bar (percent) so a near-silent sample is still visible. */
const MIN_BAR_HEIGHT = 12;

/**
 * A compact player for an MSC3245 voice message: a play/pause button, the recorded
 * waveform (bars filled up to the playback position), and a running time. Resolves the
 * clip's bytes through {@link MediaService} (the same authenticated/decrypting path as
 * other media) and plays them via a hidden `<audio>` element.
 */
@Component({
  selector: 'trn-voice-message',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent],
  templateUrl: './voice-message.component.html',
  styleUrl: './voice-message.component.scss',
})
export class VoiceMessageComponent {
  readonly media = input.required<MediaPayload>();

  private readonly mediaService = inject(MediaService);
  private readonly audio = viewChild<ElementRef<HTMLAudioElement>>('audio');

  /** Resolved (blob) URL for the audio, or null while loading. */
  readonly src = signal<string | null>(null);
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

  /** The URL currently pinned in the media cache (so eviction can't revoke it). */
  private pinnedUrl: string | null = null;

  constructor() {
    effect((onCleanup) => {
      const media = this.media();
      this.src.set(null);
      const sub: Subscription = this.mediaService
        .resolveMedia(media, 'full')
        .subscribe((url) => {
          // Pin the clip's object URL while it's bound to <audio> — the shared media
          // cache would otherwise evict/revoke it under pressure mid-playback.
          this.repin(url);
          this.src.set(url);
        });
      onCleanup(() => {
        sub.unsubscribe();
        this.repin(null);
      });
    });
  }

  private repin(url: string | null): void {
    if (url === this.pinnedUrl) {
      return;
    }
    this.mediaService.unpin(this.pinnedUrl);
    this.mediaService.pin(url);
    this.pinnedUrl = url;
  }

  barHeight(amplitude: number): number {
    return Math.max(MIN_BAR_HEIGHT, (amplitude / WAVEFORM_FULL) * 100);
  }

  toggle(): void {
    const el = this.audio()?.nativeElement;
    if (!el) {
      return;
    }
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
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
  }
}

/** Format seconds as `m:ss`. */
function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
