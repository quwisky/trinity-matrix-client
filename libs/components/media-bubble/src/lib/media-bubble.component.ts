import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { blurhashToDataUrl } from '@trinity/util/ui';

/** Renderable media category (mirrors `@trinity/core` MediaKind). */
export type MediaBubbleKind = 'image' | 'file' | 'video' | 'audio';

/**
 * The metadata a media bubble renders. A structural subset of `@trinity/core`'s
 * `MediaPayload`, redeclared locally so this presentational leaf keeps its "no
 * `@trinity/core` dependency" contract — the smart wrapper passes its `MediaPayload`
 * straight in (extra fields are ignored).
 */
export interface MediaBubbleItem {
  kind: MediaBubbleKind;
  filename: string;
  mimeType: string;
  size?: number;
  width?: number;
  height?: number;
  /** MSC2448 blurhash, painted behind the image until the real bytes arrive. */
  blurhash?: string;
}

/**
 * Presentational media attachment: renders an image/video/audio inline or a
 * download file-card, driven entirely by inputs (a resolved `src` object URL plus
 * metadata) — it performs no fetching/decryption and has no `@trinity/core`
 * dependency. A smart wrapper resolves the URL and feeds `loading`/`error`/`src`.
 */
/**
 * What to reserve when an event does not say. 16 / 9 is the shape most shared media is
 * closest to, and being wrong here costs a small reflow rather than a full-height one.
 */
const DEFAULT_MEDIA_RATIO = '16 / 9';

@Component({
  selector: 'trn-media-bubble',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
  /** Resolved `blob:`/`https:` URL, or null while loading. */
  readonly src = input<string | null>(null);
  readonly loading = input(false);
  readonly error = input(false);

  readonly openLightbox = output<void>();
  readonly download = output<void>();

  /** Terse accessors so the template needn't unwrap `item()` repeatedly. */
  readonly kind = computed(() => this.item().kind);
  private readonly blurhash = computed(() => this.item().blurhash);
  readonly filename = computed(() => this.item().filename);

  /** A local <img>-decode failure, combined with the input `error`. */
  readonly imgFailed = signal(false);

  /**
   * The real shape, once the bytes arrive and can be asked.
   *
   * The fallback below is a RESERVATION — a guess made before anything is known, so the row
   * does not jump. Left bound after the file has loaded it stops being a guess and becomes
   * the box: an image whose event omits `info.w`/`info.h` would be letterboxed into 16 / 9
   * permanently, which is worse than the jump it was preventing. So the moment the element
   * can report its own dimensions, they win.
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
  readonly state = computed<'loading' | 'ready' | 'error'>(() => {
    if (this.showError()) {
      return 'error';
    }
    return this.loading() || !this.src() ? 'loading' : 'ready';
  });

  /**
   * CSS aspect-ratio from intrinsic dimensions, so the box is the right size before the
   * bytes arrive and the timeline does not jump when they do.
   *
   * Falls back to 16 / 9 rather than to nothing. An event whose `info` omits `w`/`h` is
   * common — plenty of clients send it, and an encrypted attachment may carry no dimensions
   * at all — and reserving nothing means the row is one line tall until the image decodes
   * and then several hundred pixels tall afterwards, which is the layout shift this computed
   * exists to prevent. A wrong-but-reasonable reservation moves the content once by a little
   * instead of once by everything.
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
   * The blurhash placeholder as a ready-to-use `background-image` value, or null.
   *
   * Painted on the box itself rather than swapped out when the image arrives, so there is
   * no second state change to coordinate: the real bytes simply draw over it. It also stays
   * useful afterwards — `object-fit: contain` letterboxes an image whose true shape differs
   * from the 16 / 9 fallback, and blurred colour in those bars reads better than grey.
   *
   * Decoding needs a canvas, so under jsdom this is null and the ordinary skeleton shows.
   * That is the right degradation, and it is why the painting itself is asserted in a real
   * browser rather than in a component spec.
   */
  readonly placeholder = computed(() => {
    // Read through a signal over the HASH, not over `item()`. A row re-renders for all sorts
    // of reasons — a reaction, a receipt, an edit — and each gives `item()` a new identity
    // while the hash is unchanged, so a computed over `item()` would re-decode every time.
    //
    // It is per INSTANCE, not per hash: the windowed timeline recycles instances, so
    // scrolling away and back decodes the same picture again. That is deliberate — a 32x32
    // decode is microseconds and a shared cache would need eviction to avoid holding every
    // placeholder a long session ever saw.
    const url = blurhashToDataUrl(this.blurhash());
    return url ? `url("${url}")` : null;
  });

  /** File-card subtitle: human-readable size, falling back to the MIME type. */
  readonly subtitle = computed(
    () => formatSize(this.item().size) ?? this.item().mimeType,
  );

  constructor() {
    // Reset the per-image failure flag when the source changes (instances are
    // reused across @for rows).
    effect(() => {
      this.src();
      this.imgFailed.set(false);
      // The measured shape belongs to the previous file, and these instances are reused
      // across rows — keeping it would size one attachment to another one's proportions.
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
