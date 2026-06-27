import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { MediaBubbleComponent, runWithBusy } from '@trinity/ui';
import { MediaService, type MediaPayload } from '@trinity/core';

/**
 * Smart wrapper bridging the timeline's {@link MediaPayload} to the presentational
 * {@link MediaBubbleComponent}: resolves the thumbnail object URL via
 * {@link MediaService} (the only place that touches the SDK), pins it on screen so
 * the cache won't revoke it, and drives full-resolution view + download.
 */
@Component({
  selector: 'trn-media-attachment',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MediaBubbleComponent],
  template: `
    <trn-media-bubble
      [kind]="media().kind"
      [src]="src()"
      [filename]="media().filename"
      [mimeType]="media().mimeType"
      [size]="media().size"
      [width]="media().width"
      [height]="media().height"
      [loading]="loading()"
      [error]="hasError()"
      (openLightbox)="openLightbox()"
      (download)="download()"
    />

    @if (lightboxSrc(); as full) {
      <div
        class="lightbox"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="media().filename"
        (click)="closeLightbox()"
      >
        <img class="lightbox__img" [src]="full" [alt]="media().filename" />
      </div>
    }
  `,
  styles: [
    `
      .lightbox {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
        background: rgba(0, 0, 0, 0.85);
        cursor: zoom-out;
      }
      .lightbox__img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
    `,
  ],
})
export class MediaAttachmentComponent {
  readonly media = input.required<MediaPayload>();

  private readonly mediaService = inject(MediaService);
  private readonly destroyRef = inject(DestroyRef);

  readonly src = signal<string | null>(null);
  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly hasError = computed(() => this.errorMsg() !== null);
  readonly lightboxSrc = signal<string | null>(null);

  /** Currently-pinned thumbnail URL (so it survives cache eviction while shown). */
  private pinnedUrl: string | null = null;
  private thumbnailSub?: Subscription;

  constructor() {
    // Re-resolve whenever the bound message changes — instances are recycled
    // across `@for` rows, so each new `media` re-fetches and re-pins.
    effect(() => {
      const media = this.media();
      this.thumbnailSub?.unsubscribe();
      this.src.set(null);
      this.errorMsg.set(null);
      this.repin(null);
      this.thumbnailSub = runWithBusy(
        this.mediaService.resolveMedia(media, 'thumbnail'),
        {
          busy: this.loading,
          error: this.errorMsg,
          destroyRef: this.destroyRef,
        },
      ).subscribe((url) => {
        this.repin(url);
        this.src.set(url);
      });
    });

    this.destroyRef.onDestroy(() => this.repin(null));
  }

  /** Open the full-resolution image in an inline lightbox. */
  openLightbox(): void {
    if (this.media().kind !== 'image') {
      return;
    }
    this.mediaService
      .resolveMedia(this.media(), 'full')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (url) => this.lightboxSrc.set(url),
        error: () => this.errorMsg.set('Could not open image'),
      });
  }

  closeLightbox(): void {
    this.lightboxSrc.set(null);
  }

  /** Download/save the full-resolution attachment (web `<a download>`). */
  download(): void {
    this.mediaService
      .downloadMedia(this.media())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ blob, filename }) => saveBlob(blob, filename),
        error: () => this.errorMsg.set('Download failed'),
      });
  }

  /** Swap the pinned thumbnail URL: unpin the previous, pin the next. */
  private repin(url: string | null): void {
    if (this.pinnedUrl && this.pinnedUrl !== url) {
      this.mediaService.unpin(this.pinnedUrl);
    }
    this.pinnedUrl = url;
    this.mediaService.pin(url);
  }
}

/** Trigger a browser download of a blob via a transient object URL. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
