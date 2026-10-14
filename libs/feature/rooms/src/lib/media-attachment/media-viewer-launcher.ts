import { Injectable, OnDestroy, inject } from '@angular/core';
import {
  TrnSurfaceService,
  type TrnDialogRef,
} from '@trinity/components/overlay';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { Observable, Subscription, finalize, take } from 'rxjs';
import { LightboxComponent } from './lightbox/lightbox.component';

/** How a request to view an image ended. */
export type MediaViewerOutcome = 'opened' | 'busy' | 'failed';

/** The full-resolution image the viewer shows or is loading: whose it is, its URL once resolved, the resolve. */
interface OpenRendition {
  readonly media: PresentedMediaReference;
  url: string | null;
  sub: Subscription;
}

/**
 * Opens one image at full resolution in the lightbox, shared by message attachments and the
 * inline images of formatted bodies. Provide it per consumer (`providers: [MediaViewerLauncher]`):
 * the overlay outlives the element that opened it, so the launcher closes its dialog when that
 * consumer is destroyed, or cancels the full image if it is still loading.
 *
 * The full image is pinned while the viewer is open and dropped from the media cache as soon
 * as it closes: it is large and rarely needed twice, so it does not wait for the LRU.
 */
@Injectable()
export class MediaViewerLauncher implements OnDestroy {
  private readonly pipeline = inject(MediaPipeline);
  private readonly dialogs = inject(TrnSurfaceService);
  /**
   * The image the viewer shows or is loading; at most one, and set for as long as a viewer is
   * open or on its way.
   *
   * The one-at-a-time guard is not defensive tidiness. `resolveMedia` hands every caller the
   * SAME in-flight observable, so a second tap while the full-resolution bytes are still
   * arriving would open a second dialog, `ref` would keep only the second, and closing THAT one
   * would drop a URL the first is still displaying — after which the cache is free to revoke it
   * under a visible image.
   */
  private lightbox: OpenRendition | null = null;
  private ref: TrnDialogRef<void> | null = null;

  /**
   * Resolve the full image and open the lightbox: one outcome, then complete. Unsubscribing
   * before the viewer opens cancels the resolve; a close or destroy in that window ends the
   * request without an outcome.
   */
  open(media: PresentedMediaReference): Observable<MediaViewerOutcome> {
    return new Observable<MediaViewerOutcome>((subscriber) => {
      if (this.lightbox) {
        subscriber.next('busy');
        subscriber.complete();
        return undefined;
      }
      const lightbox: OpenRendition = {
        media,
        url: null,
        sub: Subscription.EMPTY,
      };
      this.lightbox = lightbox;
      const settle = (outcome: MediaViewerOutcome): void => {
        subscriber.next(outcome);
        subscriber.complete();
      };
      const failed = (): void => {
        if (this.lightbox === lightbox) this.lightbox = null;
        settle('failed');
      };
      lightbox.sub = this.pipeline
        .resolveMedia(media, 'full')
        .pipe(
          take(1),
          // Cancelled before it resolved: the request ends with it.
          finalize(() => subscriber.complete()),
        )
        .subscribe({
          next: (url) => {
            this.show(lightbox, url);
            settle('opened');
          },
          error: failed,
          complete: () => {
            if (lightbox.url === null) failed();
          },
        });
      // Abandoned by its caller before the viewer opened: cancel the resolve too.
      return () => {
        if (this.lightbox === lightbox && !this.ref) this.dropLightbox();
      };
    });
  }

  /**
   * Close the lightbox if it is open.
   *
   * Dropping the image is the `closed` subscription's job rather than this method's, so that
   * a close the CDK performs on its own — Escape, a backdrop click — releases the URL too.
   */
  close(): void {
    this.ref?.close();
  }

  ngOnDestroy(): void {
    // The overlay outlives its owner's element, so closing it here is not tidiness: the full
    // image would otherwise stay pinned with nobody left to release it.
    if (this.ref) {
      this.ref.close();
    } else {
      // Nothing to close while the full image is still on its way: cancel that instead.
      this.dropLightbox();
    }
  }

  private show(lightbox: OpenRendition, url: string): void {
    const { media } = lightbox;
    // Pinned like a thumbnail: a burst of live media (the cache's eviction) would otherwise
    // revoke it while it is on screen. Dropped on close.
    this.pipeline.pin(url);
    lightbox.url = url;
    this.ref = this.dialogs.open<void, LightboxComponent>(LightboxComponent, {
      inputs: { src: url, filename: media.filename, media },
      ariaLabel: media.filename,
      kind: this.dialogs.prefersSheet() ? 'fullscreen' : 'auto',
      // Keep the full viewer container as the initial focus target. The visible close button
      // remains keyboard reachable, while Escape/backdrop dismissal stay intact.
      autoFocus: 'dialog',
    });
    this.ref.closed.subscribe(() => {
      this.ref = null;
      this.dropLightbox();
    });
  }

  /** Drop the full-resolution image, or cancel it while it is still loading. */
  private dropLightbox(): void {
    const lightbox = this.lightbox;
    if (!lightbox) return;
    this.lightbox = null;
    // Unsubscribe first: a drop cancels a resolve only once nobody waits for it.
    lightbox.sub.unsubscribe();
    this.pipeline.drop(lightbox.media, 'full', lightbox.url);
  }
}
