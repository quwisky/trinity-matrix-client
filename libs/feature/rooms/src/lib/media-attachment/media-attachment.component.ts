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
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Observable, Subscription, catchError } from 'rxjs';
import { runWithBusy } from '@trinity/util/ui';
import { MediaBubbleComponent } from '../media-bubble/media-bubble.component';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { MediaSaveService } from './media-save.service';
import { TimelineMediaGate } from '../shared/timeline-media-gate';
import {
  MediaViewerLauncher,
  type MediaViewerOutcome,
} from './media-viewer-launcher';

/** A full-size rendition this row opened: whose it is, its pinned URL once resolved, the resolve. */
interface OpenRendition {
  readonly media: PresentedMediaReference;
  url: string | null;
  sub: Subscription;
}

/**
 * Smart wrapper bridging the timeline's opaque media reference to the presentational
 * {@link MediaBubbleComponent}: resolves the thumbnail object URL via
 * {@link MediaPipeline}, pins it on screen so
 * the cache won't revoke it, and drives full-resolution view + download. The full-resolution
 * viewer is {@link MediaViewerLauncher}'s, shared with the inline images of message bodies.
 *
 * A video or audio clip is the exception to "resolve on render": the whole file would be
 * fetched, decrypted and pinned for every row on screen, so only a video's bundled thumbnail
 * (its poster) is resolved up front and the clip itself waits for {@link play}.
 *
 * In a timeline that loads images after fast scrolling (Settings › Experimental), the
 * thumbnail or poster waits for the list's {@link TimelineMediaGate}: until the row is near
 * the viewport and the list is no longer flinging. One still loading when the row goes is
 * cancelled, so a row the reader only passed leaves no blob, decode or upload behind.
 *
 * Full-size renditions are large and rarely needed twice, so they are dropped from the media
 * cache as soon as they are closed instead of waiting for the LRU: the lightbox image when the
 * lightbox closes ({@link MediaViewerLauncher}'s job), a clip when its playback ends (the player
 * returns to its play control), when the row is recycled for another message, and when the row
 * is destroyed.
 */
@Component({
  selector: 'trn-media-attachment',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MediaBubbleComponent],
  providers: [MediaViewerLauncher],
  templateUrl: './media-attachment.component.html',
})
export class MediaAttachmentComponent {
  readonly media = input.required<PresentedMediaReference>();

  private readonly mediaPipeline = inject(MediaPipeline);
  private readonly viewer = inject(MediaViewerLauncher);
  private readonly mediaSave = inject(MediaSaveService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The timeline's gate for image loads; absent outside a message list. */
  private readonly gate = inject(TimelineMediaGate, { optional: true });

  readonly src = signal<string | null>(null);
  /** A video's bundled thumbnail, shown behind its play button until the clip is played. */
  readonly poster = signal<string | null>(null);
  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly hasError = computed(() => this.errorMsg() !== null);

  /** Currently-pinned thumbnail or poster URL (so it survives cache eviction while shown). */
  private pinnedUrl: string | null = null;
  /** The thumbnail or poster resolve. */
  private mediaSub?: Subscription;
  /** Withdraws the thumbnail or poster still waiting for the {@link gate}. */
  private cancelWait: () => void = () => undefined;
  /**
   * The thumbnail or poster resolve still in flight while the {@link gate} is on, to cancel
   * if its row goes first. Null once it has a URL (the cache keeps that for the next row).
   */
  private pending: PresentedMediaReference | null = null;
  /** The media the effect last set this row up for. */
  private current: PresentedMediaReference | null = null;
  /**
   * The played clip: the message it belongs to (rows are recycled, so not necessarily the
   * current one), its pinned URL once resolved, and the resolve.
   */
  private clip: OpenRendition | null = null;

  constructor() {
    // Re-resolve whenever the bound message changes — instances are recycled
    // across `@for` rows, so each new `media` re-fetches and re-pins.
    effect(() => {
      const media = this.media();
      const previous = this.current;
      this.current = media;
      // Under the gate, a receipt or reaction re-projects the message with a new reference to
      // the same file: keep the thumbnail shown or still loading rather than cancel and fetch it
      // again (an encrypted original is a full download and decrypt each time).
      if (
        previous &&
        this.gate?.enabled &&
        this.mediaPipeline.sameMedia(previous, media)
      ) {
        return;
      }
      // A row that already shows its image is re-rendering its message (an edit, a receipt,
      // a reaction): load at once rather than blank it mid-scroll. Read before the reset.
      const shown = this.pinnedUrl !== null;
      this.releaseThumbnail();
      // A clip playing in a recycled row belongs to the previous message: closing it.
      untracked(() => this.dropClip());
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
        this.whenReady(shown, () =>
          this.resolveThumbnail(
            media,
            this.resolve(media, 'thumbnail'),
            (url) => this.src.set(url),
          ),
        );
      } else if (media.kind === 'video' && media.hasThumbnail) {
        // Never the 'thumbnail' variant without a bundled one: it would resolve the whole video.
        // A missing or broken poster is cosmetic, so its failure is not the bubble's error.
        this.whenReady(shown, () =>
          this.resolveThumbnail(
            media,
            this.mediaPipeline.resolveMedia(media, 'thumbnail').pipe(
              takeUntilDestroyed(this.destroyRef),
              catchError(() => EMPTY),
            ),
            (url) => this.poster.set(url),
          ),
        );
      }
    });

    // The lightbox outlives this element; MediaViewerLauncher, provided here, closes it (or
    // cancels the full image still loading for it) when this component is destroyed.
    this.destroyRef.onDestroy(() => {
      this.releaseThumbnail();
      this.repin(null);
      this.dropClip();
    });
  }

  /** Load a video or audio clip on the reader's first press of play; the bubble then plays it. */
  play(): void {
    const { kind } = this.media();
    if ((kind !== 'video' && kind !== 'audio') || this.clip || this.loading()) {
      return;
    }
    // The poster keeps its own pin: the player returns to it when playback ends.
    const clip: OpenRendition = {
      media: this.media(),
      url: null,
      sub: Subscription.EMPTY,
    };
    this.clip = clip;
    clip.sub = this.resolve(clip.media, 'full').subscribe({
      next: (url) => {
        this.mediaPipeline.pin(url);
        clip.url = url;
        this.src.set(url);
      },
      // A failed resolve completes empty (its error is shown): let a later press retry.
      complete: () => {
        if (this.clip === clip && clip.url === null) this.clip = null;
      },
    });
  }

  /** Playback reached the end: free the clip and return the player to its play control. */
  playbackEnded(): void {
    this.dropClip();
  }

  /** Open the full-resolution image over the app, in a modal dialog. */
  openLightbox(): void {
    if (this.media().kind !== 'image') {
      return;
    }
    this.viewer
      .open(this.media())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => this.onViewerOutcome(outcome));
  }

  /** Close the lightbox if it is open. */
  closeLightbox(): void {
    this.viewer.close();
  }

  /** Save the full-resolution attachment — native share sheet or web download. */
  download(): void {
    this.mediaSave.save(this.media());
  }

  private onViewerOutcome(outcome: MediaViewerOutcome): void {
    switch (outcome) {
      case 'opened':
      case 'busy':
        return;
      case 'failed':
        this.errorMsg.set('Could not open image');
        return;
      default: {
        const unhandled: never = outcome;
        void unhandled;
      }
    }
  }

  /** Start `load` now, or once the timeline's gate lets this row's image load. */
  private whenReady(shown: boolean, load: () => void): void {
    if (!this.gate || shown) {
      load();
      return;
    }
    this.cancelWait = this.gate.whenReady(this.host.nativeElement, load);
  }

  /** Resolve the thumbnail or poster, pin it and hand it to `show`. */
  private resolveThumbnail(
    media: PresentedMediaReference,
    resolve: Observable<string>,
    show: (url: string) => void,
  ): void {
    // Only with the gate on is a row that goes mid-load cancelled; off, it loads as before.
    const cancellable = this.gate?.enabled ?? false;
    this.pending = cancellable ? media : null;
    this.mediaSub = resolve.subscribe((url) => {
      this.pending = null;
      this.repin(url);
      show(url);
    });
  }

  /**
   * Stop waiting for or resolving the current thumbnail or poster. A resolve still in flight
   * under the gate is dropped too, after letting go of it, so it is cancelled unless another
   * row waits for the same bytes.
   */
  private releaseThumbnail(): void {
    this.cancelWait();
    this.cancelWait = () => undefined;
    this.mediaSub?.unsubscribe();
    const pending = this.pending;
    this.pending = null;
    if (pending) this.mediaPipeline.drop(pending, 'thumbnail', null);
  }

  /** Resolve one rendition with the busy/error convention. */
  private resolve(
    media: PresentedMediaReference,
    variant: 'thumbnail' | 'full',
  ): Observable<string> {
    return runWithBusy(this.mediaPipeline.resolveMedia(media, variant), {
      busy: this.loading,
      error: this.errorMsg,
      destroyRef: this.destroyRef,
    });
  }

  /**
   * Swap the pinned thumbnail URL: unpin the previous, pin the next. Pins are counted, so the
   * URL already held is not pinned twice.
   */
  private repin(url: string | null): void {
    if (url === this.pinnedUrl) return;
    this.mediaPipeline.unpin(this.pinnedUrl);
    this.pinnedUrl = url;
    this.mediaPipeline.pin(url);
  }

  /** Close the played clip, if any: cancel or drop it and show the play control again. */
  private dropClip(): void {
    const clip = this.clip;
    if (!clip) return;
    this.clip = null;
    // Unsubscribe first: a drop cancels a resolve only once nobody waits for it.
    clip.sub.unsubscribe();
    this.mediaPipeline.drop(clip.media, 'full', clip.url);
    if (clip.url && this.src() === clip.url) this.src.set(null);
  }
}
