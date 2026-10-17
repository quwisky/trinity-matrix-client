import { TrnIconComponent } from '@trinity/components/foundations';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { formatMediaDuration } from '../shared/format-media-duration';

/** Renderable media category (mirrors `MediaKind` in `@trinity/util/matrix`). */
export type MediaBubbleKind = 'image' | 'file' | 'video' | 'audio';

/**
 * The metadata a media bubble renders. A structural subset of `MediaPayload`,
 * redeclared locally so this presentational leaf stays free of Matrix utilities;
 * the smart wrapper passes its `MediaPayload` straight in (extra fields are ignored).
 */
export interface MediaBubbleItem {
  kind: MediaBubbleKind;
  filename: string;
  mimeType: string;
  size?: number;
  width?: number;
  height?: number;
  /** Declared length of a video or audio clip, shown before its bytes are loaded. */
  durationMs?: number;
}

/**
 * What to reserve when an event does not say. 16 / 9 is the shape most shared media is
 * closest to, and being wrong here costs a small reflow rather than a full-height one.
 */
const DEFAULT_MEDIA_RATIO = '16 / 9';

/**
 * Presentational media attachment: renders an image/video/audio inline or a
 * download file-card, driven entirely by inputs (a resolved `src` object URL plus
 * metadata) — it performs no fetching/decryption and has no `@trinity/core`
 * dependency. A smart wrapper resolves the URL and feeds `loading`/`error`/`src`.
 *
 * A video or audio clip has no `src` until the reader asks for it: it shows a play control
 * (a poster for video) and emits {@link playRequested}, because fetching and decrypting the whole file
 * for every row that merely scrolls past costs far more memory than the row is worth.
 */
@Component({
  selector: 'trn-media-bubble',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent],
  templateUrl: './media-bubble.component.html',
  styleUrl: './media-bubble.component.scss',
  host: {
    'data-testid': 'media-bubble',
    '[attr.data-media-kind]': 'kind()',
    '[attr.data-media-state]': 'state()',
  },
})
export class MediaBubbleComponent {
  /** The media item to render (metadata only — no bytes). */
  readonly item = input.required<MediaBubbleItem>();
  /** Resolved `blob:`/`https:` URL, or null while loading (or, for video/audio, until played). */
  readonly src = input<string | null>(null);
  /** Still shown behind a video's play button; null draws a neutral placeholder. */
  readonly poster = input<string | null>(null);
  readonly loading = input(false);
  readonly error = input(false);

  readonly openLightbox = output<void>();
  readonly download = output<void>();
  /** The reader asked to play a video or audio clip that has not been loaded yet. */
  readonly playRequested = output<void>();
  /** A clip played to its end; the wrapper may take its `src` away to free the bytes. */
  readonly playbackEnded = output<void>();

  private readonly injector = inject(Injector);
  /** A clip's play control (video poster or audio row), present while it has no `src`. */
  private readonly playButton =
    viewChild<ElementRef<HTMLButtonElement>>('playButton');

  /** Terse accessors so the template needn't unwrap `item()` repeatedly. */
  readonly kind = computed(() => this.item().kind);
  readonly filename = computed(() => this.item().filename);

  /** A local <img>-decode failure, combined with the input `error`. */
  readonly imgFailed = signal(false);

  /**
   * The real shape, once the element can report it. The fallback below is only a
   * RESERVATION made before anything is known; left bound after load, an image whose event
   * omits `info.w`/`info.h` would be letterboxed into 16 / 9 permanently.
   */
  private readonly loadedRatio = signal<string | null>(null);

  /** Record the intrinsic shape an <img> or <video> reports once it has decoded. */
  onNaturalSize(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.loadedRatio.set(`${width} / ${height}`);
    }
  }

  readonly showError = computed(() => this.error() || this.imgFailed());

  /** Coarse render state, surfaced as `data-media-state` for tests/styling. */
  readonly state = computed<'idle' | 'loading' | 'ready' | 'error'>(() => {
    if (this.showError()) {
      return 'error';
    }
    if (this.loading()) {
      return 'loading';
    }
    if (this.src()) {
      return 'ready';
    }
    // A clip waits for the reader; anything else with no src is still on its way.
    return this.kind() === 'video' || this.kind() === 'audio'
      ? 'idle'
      : 'loading';
  });

  /**
   * CSS aspect-ratio from intrinsic dimensions, so the box is the right size before the
   * bytes arrive. Falls back to 16 / 9 rather than nothing: events often omit `info.w`/`h`
   * (an encrypted attachment may carry none), and reserving nothing makes the row jump from
   * one line to full height on decode.
   */
  readonly aspectRatio = computed(() => {
    const w = this.item().width;
    const h = this.item().height;
    if (w && h) {
      return `${w} / ${h}`;
    }
    // What the file itself says, if it has said anything yet; otherwise the reservation.
    return this.loadedRatio() ?? DEFAULT_MEDIA_RATIO;
  });

  /**
   * Only an image whose size the event states may load lazily: its box is reserved, so
   * deferring the decode moves nothing. Without `info.w`/`info.h` the 16 / 9 guess is
   * corrected on load; deferring that would shift rows the virtual list has already
   * measured while the reader scrolls, so those stay eager.
   */
  readonly hasIntrinsicSize = computed(
    () => !!this.item().width && !!this.item().height,
  );

  /** File-card subtitle: human-readable size, falling back to the MIME type. */
  readonly subtitle = computed(
    () => formatSize(this.item().size) ?? this.item().mimeType,
  );

  /** Declared length and size of a clip, e.g. `1:23 · 5.0 MB`; empty when the event says neither. */
  readonly playMeta = computed(() => {
    const { durationMs, size } = this.item();
    return [formatMediaDuration(durationMs), formatSize(size)]
      .filter(Boolean)
      .join(' · ');
  });

  /** Press on a clip's play control; ignored while the file is already on its way. */
  requestPlay(): void {
    if (!this.loading()) {
      this.playRequested.emit();
    }
  }

  /**
   * A clip played to its end. The wrapper may take its `src` away, which removes the player;
   * if the reader's focus was on it, it moves to the play control that replaces it rather
   * than falling back to the page.
   */
  onEnded(media: HTMLMediaElement): void {
    const hadFocus = media.ownerDocument.activeElement === media;
    this.playbackEnded.emit();
    if (hadFocus) {
      const doc = media.ownerDocument;
      afterNextRender(
        () => {
          // Only if focus fell to the page with the player: a reader who has moved on keeps
          // their place.
          const active = doc.activeElement;
          if (active === null || active === doc.body) {
            this.playButton()?.nativeElement.focus();
          }
        },
        { injector: this.injector },
      );
    }
  }

  /**
   * Start a clip the reader asked for once its source can be played. A host may still refuse
   * (autoplay policy after a long fetch); the native controls are then the way to start it.
   */
  startPlayback(media: HTMLMediaElement): void {
    media.play().catch(() => undefined);
  }

  constructor() {
    // Reset the failure flag when the source changes (instances are reused across @for rows).
    effect(() => {
      this.src();
      this.imgFailed.set(false);
      // The measured shape belongs to the previous file; rows are reused, so keeping it would
      // size one attachment to another's proportions.
      this.loadedRatio.set(null);
    });
  }
}

/** Format a byte count as a short human-readable string, or null if unknown. */
function formatSize(bytes: number | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value);
  return `${rounded} ${units[unit]}`;
}
