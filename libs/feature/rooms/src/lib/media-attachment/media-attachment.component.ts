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
import { Subscription, finalize, switchMap } from 'rxjs';
import { runWithBusy } from '@trinity/util/ui';
import { MediaBubbleComponent } from '@trinity/components/media-bubble';
import {
  TrnDialogService,
  type TrnDialogRef,
} from '@trinity/components/overlay';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { FileSaveService } from '@trinity/platform-native';
import { LightboxComponent } from './lightbox/lightbox.component';

/**
 * Smart wrapper bridging the timeline's opaque media reference to the presentational
 * {@link MediaBubbleComponent}: resolves the thumbnail object URL via
 * {@link MediaPipeline}, pins it on screen so
 * the cache won't revoke it, and drives full-resolution view + download.
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
  private readonly dialogs = inject(TrnDialogService);
  private readonly fileSave = inject(FileSaveService);
  private readonly destroyRef = inject(DestroyRef);

  readonly src = signal<string | null>(null);
  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly hasError = computed(() => this.errorMsg() !== null);
  /** Guards against a second save starting while one is in flight (native Share
   * rejects a concurrent invocation, and it would write the file twice). */
  private readonly saving = signal(false);

  /** Currently-pinned thumbnail URL (so it survives cache eviction while shown). */
  private pinnedUrl: string | null = null;
  /** Currently-pinned full-resolution URL while the lightbox is open. */
  private lightboxPinnedUrl: string | null = null;
  private thumbnailSub?: Subscription;
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
      this.thumbnailSub?.unsubscribe();
      this.src.set(null);
      this.errorMsg.set(null);
      this.repin(null);
      // Note what is NOT here any more: a force-close of the lightbox. While it rendered
      // inside this row, a recycled instance would have shown the previous message's image,
      // so the row had to slam it shut and skip the focus restore to avoid moving focus to
      // an unrelated button. An overlay is not inside the row — it holds its own URL, pinned
      // for as long as it is open — so a message arriving under it is no longer its problem,
      // and the image the reader opened stays open.
      // A file card is a pure download affordance — it never binds `src`. Skip
      // thumbnail resolution for it: otherwise an encrypted file would be fetched
      // and fully AES-decrypted into pinned memory on every render, just to be
      // discarded (an OOM/privacy hazard when scrolling a room of attachments).
      if (media.kind === 'file') {
        return;
      }
      this.thumbnailSub = runWithBusy(
        this.mediaPipeline.resolveMedia(media, 'thumbnail'),
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

    this.destroyRef.onDestroy(() => {
      this.repin(null);
      // The overlay outlives this component's element, so closing it here is not tidiness:
      // the full-resolution URL is unpinned on the way out and would be revoked under an
      // image still on screen.
      this.closeLightbox();
    });
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
              inputs: { src: url, filename: this.media().filename },
              ariaLabel: this.media().filename,
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
    if (this.saving()) {
      return; // a save is already in flight (avoid a concurrent native share)
    }
    this.saving.set(true);
    this.mediaPipeline
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
