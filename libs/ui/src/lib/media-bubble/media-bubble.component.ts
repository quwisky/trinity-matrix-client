import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';

/** Renderable media category (mirrors `@trinity/core` MediaKind). */
export type MediaBubbleKind = 'image' | 'file' | 'video' | 'audio';

/**
 * Presentational media attachment: renders an image/video/audio inline or a
 * download file-card, driven entirely by inputs (a resolved `src` object URL plus
 * metadata) — it performs no fetching/decryption and has no `@trinity/core`
 * dependency. A smart wrapper resolves the URL and feeds `loading`/`error`/`src`.
 */
@Component({
  selector: 'trn-media-bubble',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (showError()) {
      <button
        type="button"
        class="media media--file media--error"
        (click)="download.emit()"
      >
        <span class="media__icon" aria-hidden="true">!</span>
        <span class="media__meta">
          <span class="media__name">{{ filename() }}</span>
          <span class="media__sub">Couldn’t load — download</span>
        </span>
      </button>
    } @else if (kind() === 'image') {
      <button
        type="button"
        class="media media--image"
        [style.aspect-ratio]="aspectRatio()"
        [attr.aria-label]="'Open image ' + filename()"
        (click)="openLightbox.emit()"
      >
        @if (src()) {
          <img
            class="media__img"
            [src]="src()"
            [alt]="filename()"
            (error)="imgFailed.set(true)"
          />
        } @else {
          <span class="media__skeleton" aria-hidden="true"></span>
        }
      </button>
    } @else if (kind() === 'video') {
      @if (src()) {
        <video class="media media--video" controls [src]="src()"></video>
      } @else {
        <span
          class="media media--video media__skeleton"
          aria-hidden="true"
        ></span>
      }
    } @else if (kind() === 'audio') {
      @if (src()) {
        <audio class="media media--audio" controls [src]="src()"></audio>
      } @else {
        <span class="media__loading">Loading audio…</span>
      }
    } @else {
      <button
        type="button"
        class="media media--file"
        [attr.aria-label]="'Download ' + filename()"
        (click)="download.emit()"
      >
        <span class="media__icon" aria-hidden="true">↓</span>
        <span class="media__meta">
          <span class="media__name">{{ filename() }}</span>
          <span class="media__sub">{{ subtitle() }}</span>
        </span>
      </button>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        max-width: min(20rem, 100%);
      }
      .media {
        display: block;
        border: 0;
        padding: 0;
        margin: 0;
        font: inherit;
        color: inherit;
        cursor: pointer;
      }
      .media--image {
        width: 100%;
        max-height: 20rem;
        border-radius: 0.5rem;
        overflow: hidden;
        background: var(--ion-color-step-100, #f1f1f3);
      }
      .media__img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .media__skeleton {
        display: block;
        width: 100%;
        height: 100%;
        min-height: 8rem;
        background: var(--ion-color-step-100, #f1f1f3);
      }
      .media--video,
      .media--audio {
        width: 100%;
        border-radius: 0.5rem;
      }
      .media--video {
        max-height: 20rem;
        background: #000;
      }
      .media--file {
        display: flex;
        align-items: center;
        gap: 0.625rem;
        padding: 0.625rem 0.75rem;
        border-radius: 0.5rem;
        background: var(--ion-color-step-100, #f1f1f3);
        text-align: left;
        width: 100%;
      }
      .media--error {
        background: var(--ion-color-danger-tint, #f6d7d7);
      }
      .media__icon {
        flex: 0 0 auto;
        width: 2rem;
        height: 2rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 0.375rem;
        background: var(--ion-color-step-200, #e3e3e6);
        font-weight: 700;
      }
      .media__meta {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .media__name {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .media__sub {
        font-size: 0.8125rem;
        opacity: 0.7;
      }
      .media__loading {
        font-size: 0.8125rem;
        opacity: 0.7;
      }
    `,
  ],
  host: {
    'data-testid': 'media-bubble',
    '[attr.data-media-kind]': 'kind()',
    '[attr.data-media-state]': 'state()',
  },
})
export class MediaBubbleComponent {
  readonly kind = input<MediaBubbleKind>('file');
  /** Resolved `blob:`/`https:` URL, or null while loading. */
  readonly src = input<string | null>(null);
  readonly filename = input('attachment');
  readonly mimeType = input('application/octet-stream');
  readonly size = input<number | undefined>(undefined);
  readonly width = input<number | undefined>(undefined);
  readonly height = input<number | undefined>(undefined);
  readonly loading = input(false);
  readonly error = input(false);

  readonly openLightbox = output<void>();
  readonly download = output<void>();

  /** A local <img>-decode failure, combined with the input `error`. */
  readonly imgFailed = signal(false);

  readonly showError = computed(() => this.error() || this.imgFailed());

  /** Coarse render state, surfaced as `data-media-state` for tests/styling. */
  readonly state = computed<'loading' | 'ready' | 'error'>(() => {
    if (this.showError()) {
      return 'error';
    }
    return this.loading() || !this.src() ? 'loading' : 'ready';
  });

  /** CSS aspect-ratio from intrinsic dimensions to avoid layout shift. */
  readonly aspectRatio = computed(() => {
    const w = this.width();
    const h = this.height();
    return w && h ? `${w} / ${h}` : null;
  });

  /** File-card subtitle: human-readable size, falling back to the MIME type. */
  readonly subtitle = computed(
    () => formatSize(this.size()) ?? this.mimeType(),
  );

  constructor() {
    // Reset the per-image failure flag when the source changes (instances are
    // reused across @for rows).
    effect(() => {
      this.src();
      this.imgFailed.set(false);
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
