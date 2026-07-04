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
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, finalize, switchMap } from 'rxjs';
import { MediaBubbleComponent, runWithBusy } from '@trinity/ui';
import { MediaService, type MediaPayload } from '@trinity/core';
import { FileSaveService } from '../media-save/file-save.service';

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
        #lightbox
        class="lightbox"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        [attr.aria-label]="media().filename"
        (click)="closeLightbox()"
        (keydown.escape)="closeLightbox()"
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
  private readonly fileSave = inject(FileSaveService);
  private readonly destroyRef = inject(DestroyRef);

  readonly src = signal<string | null>(null);
  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly hasError = computed(() => this.errorMsg() !== null);
  readonly lightboxSrc = signal<string | null>(null);
  /** Guards against a second save starting while one is in flight (native Share
   * rejects a concurrent invocation, and it would write the file twice). */
  private readonly saving = signal(false);

  /** Currently-pinned thumbnail URL (so it survives cache eviction while shown). */
  private pinnedUrl: string | null = null;
  /** Currently-pinned full-resolution URL while the lightbox is open. */
  private lightboxPinnedUrl: string | null = null;
  private thumbnailSub?: Subscription;
  private readonly lightboxEl = viewChild<ElementRef<HTMLElement>>('lightbox');
  /** The element to return focus to when the lightbox closes (its trigger). */
  private lightboxReturnFocus: HTMLElement | null = null;

  constructor() {
    // Re-resolve whenever the bound message changes — instances are recycled
    // across `@for` rows, so each new `media` re-fetches and re-pins.
    effect(() => {
      const media = this.media();
      this.thumbnailSub?.unsubscribe();
      this.src.set(null);
      this.errorMsg.set(null);
      this.repin(null);
      // A recycled row may carry an open lightbox from the previous message —
      // unpin its full URL and close it so it can't leak or show stale bytes.
      // restoreFocus:false — this is a background close, not a user action.
      this.closeLightbox(false);
      // A file card is a pure download affordance — it never binds `src`. Skip
      // thumbnail resolution for it: otherwise an encrypted file would be fetched
      // and fully AES-decrypted into pinned memory on every render, just to be
      // discarded (an OOM/privacy hazard when scrolling a room of attachments).
      if (media.kind === 'file') {
        return;
      }
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

    // Move focus into the lightbox when it opens, so Escape works and screen
    // readers enter the dialog; closeLightbox() returns focus to the trigger.
    effect(() => {
      this.lightboxEl()?.nativeElement.focus();
    });

    this.destroyRef.onDestroy(() => {
      this.repin(null);
      this.pinLightbox(null);
    });
  }

  /** Open the full-resolution image in an inline lightbox. */
  openLightbox(): void {
    if (this.media().kind !== 'image') {
      return;
    }
    // Remember the trigger so focus returns to it on close.
    this.lightboxReturnFocus = document.activeElement as HTMLElement | null;
    this.mediaService
      .resolveMedia(this.media(), 'full')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (url) => {
          // Pin the full URL like the thumbnail: a burst of live media
          // (store() → evict(), 64-entry cap) would otherwise revoke it while
          // it's still on screen. Unpinned on close / destroy.
          this.pinLightbox(url);
          this.lightboxSrc.set(url);
        },
        error: () => this.errorMsg.set('Could not open image'),
      });
  }

  closeLightbox(restoreFocus = true): void {
    this.lightboxSrc.set(null);
    this.pinLightbox(null);
    // Return focus to the trigger only on a genuine user close (Escape / backdrop
    // click). Skip it when a row recycle force-closes in the background: the
    // captured element is recycled and now belongs to a different message, so
    // restoring would move focus (and scroll) to an unrelated media button.
    // preventScroll keeps the restore from jumping the timeline.
    if (restoreFocus) {
      this.lightboxReturnFocus?.focus?.({ preventScroll: true });
    }
    this.lightboxReturnFocus = null;
  }

  /** Save the full-resolution attachment — native share sheet or web download. */
  download(): void {
    if (this.saving()) {
      return; // a save is already in flight (avoid a concurrent native share)
    }
    this.saving.set(true);
    this.mediaService
      .downloadMedia(this.media())
      .pipe(
        switchMap(({ blob, filename }) => this.fileSave.save(blob, filename)),
        finalize(() => this.saving.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
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

  /** Swap the pinned full-resolution URL (lightbox): unpin the previous, pin the next. */
  private pinLightbox(url: string | null): void {
    if (this.lightboxPinnedUrl && this.lightboxPinnedUrl !== url) {
      this.mediaService.unpin(this.lightboxPinnedUrl);
    }
    this.lightboxPinnedUrl = url;
    this.mediaService.pin(url);
  }
}
