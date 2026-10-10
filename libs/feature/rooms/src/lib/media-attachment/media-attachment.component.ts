import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  type WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Subscription, catchError } from 'rxjs';
import { runWithBusy } from '@trinity/util/ui';
import { MediaBubbleComponent } from '../media-bubble/media-bubble.component';
import {
  TrnSurfaceService,
  type TrnDialogRef,
} from '@trinity/components/overlay';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { MediaSaveService } from './media-save.service';
import { LightboxComponent } from './lightbox/lightbox.component';

/**
 * Smart wrapper bridging the timeline's opaque media reference to the presentational
 * {@link MediaBubbleComponent}: resolves the thumbnail object URL via
 * {@link MediaPipeline}, pins it on screen so
 * the cache won't revoke it, and drives full-resolution view + download.
 *
 * A video or audio clip is the exception to "resolve on render": the whole file would be
 * fetched, decrypted and pinned for every row on screen, so only a video's bundled thumbnail
 * (its poster) is resolved up front and the clip itself waits for {@link play}.
 */
@Component({
  selector: 'trn-media-attachment',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MediaBubbleComponent],
  templateUrl: './media-attachment.component.html',
})
export class MediaAttachmentComponent {
  readonly media = input.required<PresentedMediaReference>();

  private readonly mediaPipeline = inject(MediaPipeline);
  private readonly dialogs = inject(TrnSurfaceService);
  private readonly mediaSave = inject(MediaSaveService);
  private readonly destroyRef = inject(DestroyRef);

  readonly src = signal<string | null>(null);
  /** A video's bundled thumbnail, shown behind its play button until the clip is played. */
  readonly poster = signal<string | null>(null);
  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly hasError = computed(() => this.errorMsg() !== null);

  /** Currently-pinned thumbnail URL (so it survives cache eviction while shown). */
  private pinnedUrl: string | null = null;
  /** Currently-pinned full-resolution URL while the lightbox is open. */
  private lightboxPinnedUrl: string | null = null;
  /** The poster or full-file resolve in flight; at most one, so a late poster cannot unpin a clip. */
  private mediaSub?: Subscription;
  private lightboxRef: TrnDialogRef<void> | null = null;
  /**
   * Whether a lightbox is open or on its way.
   *
   * The guard is not defensive tidiness. `resolveMedia` hands every caller the SAME
   * in-flight observable, so a second tap while the full-resolution bytes are still
   * arriving reaches `next` twice: two dialogs open, `lightboxRef` keeps only the second,
   * and closing THAT one unpins a URL the first is still displaying — after which the
   * cache is free to revoke it under a visible image. The inline version this replaced was
   * idempotent by accident (setting a signal twice is one lightbox); an overlay is not.
   */
  private lightboxPending = false;

  constructor() {
    // Re-resolve whenever the bound message changes — instances are recycled
    // across `@for` rows, so each new `media` re-fetches and re-pins.
    effect(() => {
      const media = this.media();
      this.mediaSub?.unsubscribe();
      this.src.set(null);
      this.poster.set(null);
      this.errorMsg.set(null);
      this.repin(null);
      // Note what is NOT here any more: a force-close of the lightbox. While it rendered
      // inside this row, a recycled instance would have shown the previous message's image,
      // so the row had to slam it shut and skip the focus restore to avoid moving focus to
      // an unrelated button. An overlay is not inside the row — it holds its own URL, pinned
      // for as long as it is open — so a message arriving under it is no longer its problem,
      // and the image the reader opened stays open.
      // A file card is a pure download affordance — it never binds `src`, so it resolves
      // nothing: an encrypted file would otherwise be fetched and fully AES-decrypted into
      // pinned memory on every render, just to be discarded (an OOM/privacy hazard when
      // scrolling a room of attachments). Video and audio get the same treatment below.
      if (media.kind === 'image') {
        // Only an image may stand in with its thumbnail: a <video>/<audio> plays its src, and a
        // bundled thumbnail is a still JPEG.
        this.mediaSub = this.resolveInto(media, 'thumbnail', this.src);
      } else if (media.kind === 'video' && media.hasThumbnail) {
        // Never the 'thumbnail' variant without a bundled one: it would resolve the whole video.
        // A missing or broken poster is cosmetic, so its failure is not the bubble's error.
        this.mediaSub = this.mediaPipeline
          .resolveMedia(media, 'thumbnail')
          .pipe(
            takeUntilDestroyed(this.destroyRef),
            catchError(() => EMPTY),
          )
          .subscribe((url) => {
            this.repin(url);
            this.poster.set(url);
          });
      }
    });

    this.destroyRef.onDestroy(() => {
      this.repin(null);
      // The overlay outlives this component's element, so closing it here is not tidiness:
      // the full-resolution URL is unpinned on the way out and would be revoked under an
      // image still on screen.
      this.closeLightbox();
    });
  }

  /** Load a video or audio clip on the reader's first press of play; the bubble then plays it. */
  play(): void {
    const { kind } = this.media();
    if (
      (kind !== 'video' && kind !== 'audio') ||
      this.src() ||
      this.loading()
    ) {
      return;
    }
    // Replaces any poster still in flight; the full URL takes over the single pin below.
    this.mediaSub?.unsubscribe();
    this.mediaSub = this.resolveInto(this.media(), 'full', this.src);
  }

  /** Open the full-resolution image over the app, in a modal dialog. */
  openLightbox(): void {
    if (this.media().kind !== 'image' || this.lightboxPending) {
      return;
    }
    this.lightboxPending = true;
    this.mediaPipeline
      .resolveMedia(this.media(), 'full')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (url) => {
          // Pin the full URL like the thumbnail: a burst of live media
          // (store() → evict(), 64-entry cap) would otherwise revoke it while
          // it's still on screen. Unpinned on close / destroy.
          this.pinLightbox(url);
          this.lightboxRef = this.dialogs.open<void, LightboxComponent>(
            LightboxComponent,
            {
              inputs: {
                src: url,
                filename: this.media().filename,
                media: this.media(),
              },
              ariaLabel: this.media().filename,
              kind: this.dialogs.prefersSheet() ? 'fullscreen' : 'auto',
              // Keep the full viewer container as the initial focus target. The visible close
              // button remains keyboard reachable, while Escape/backdrop dismissal stay intact.
              autoFocus: 'dialog',
            },
          );
          this.lightboxRef.closed.subscribe(() => {
            this.pinLightbox(null);
            this.lightboxRef = null;
            this.lightboxPending = false;
          });
        },
        error: () => {
          this.lightboxPending = false;
          this.errorMsg.set('Could not open image');
        },
      });
  }

  /**
   * Close the lightbox if it is open.
   *
   * Unpinning is the `closed` subscription's job rather than this method's, so that a close
   * the CDK performs on its own — Escape, a backdrop click — releases the URL too. This is
   * only the programmatic route.
   */
  closeLightbox(): void {
    this.lightboxRef?.close();
  }

  /** Save the full-resolution attachment — native share sheet or web download. */
  download(): void {
    this.mediaSave.save(this.media());
  }

  /** Resolve one rendition with the busy/error convention, pinning and publishing the URL. */
  private resolveInto(
    media: PresentedMediaReference,
    variant: 'thumbnail' | 'full',
    target: WritableSignal<string | null>,
  ): Subscription {
    return runWithBusy(this.mediaPipeline.resolveMedia(media, variant), {
      busy: this.loading,
      error: this.errorMsg,
      destroyRef: this.destroyRef,
    }).subscribe((url) => {
      this.repin(url);
      target.set(url);
    });
  }

  /** Swap the pinned thumbnail URL: unpin the previous, pin the next. */
  private repin(url: string | null): void {
    if (this.pinnedUrl && this.pinnedUrl !== url) {
      this.mediaPipeline.unpin(this.pinnedUrl);
    }
    this.pinnedUrl = url;
    this.mediaPipeline.pin(url);
  }

  /** Swap the pinned full-resolution URL (lightbox): unpin the previous, pin the next. */
  private pinLightbox(url: string | null): void {
    if (this.lightboxPinnedUrl && this.lightboxPinnedUrl !== url) {
      this.mediaPipeline.unpin(this.lightboxPinnedUrl);
    }
    this.lightboxPinnedUrl = url;
    this.mediaPipeline.pin(url);
  }
}
