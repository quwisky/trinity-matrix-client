import {
  Directive,
  ElementRef,
  Injector,
  OnDestroy,
  effect,
  inject,
  input,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnToastService } from '@trinity/components/overlay';
import { MediaPipeline, MediaService } from '@trinity/data-access/media';
import type { MediaPayload } from '@trinity/util/matrix';
import { latestGuard } from '@trinity/util/ui';
import { Subscription, fromEvent, take } from 'rxjs';
import {
  MediaViewerLauncher,
  type MediaViewerOutcome,
} from '../media-attachment/media-viewer-launcher';
import { SpoilerRevealDirective } from '../spoiler/spoiler-reveal.directive';
import { InlineImageVisibility } from './inline-image-visibility';

const MAX_INLINE_EMOTES = 50;
/** Inline images one message may fetch (spec A2), counted apart from emoji. */
const MAX_INLINE_IMAGES = 10;
/** Tallest an inline image is drawn, in CSS pixels; rendered-markdown.scss holds the same cap. */
const IMAGE_MAX_HEIGHT_PX = 300;
/** Largest sender `width`/`height` trusted to reserve a box. */
const MAX_RESERVED_PX = 10_000;
/** A sender size as the only form trusted: 1–5 digits, nothing else. */
const SENDER_SIZE = /^\d{1,5}$/;
/** A plain `mxc://server/media-id`, the shape the SDK accepts. */
const MXC_URI = /^mxc:\/\/[^/\s]+\/[\w-]+$/;
const CONCEALED = '.mx-spoiler:not(.is-revealed)';
const INLINE_IMAGES = 'img.mx-emoticon, img.mx-image';

type InlineKind = 'emote' | 'image';

/** One inline image as the sanitized string declares it. */
interface Declaration {
  readonly kind: InlineKind;
  readonly mxc: string;
  readonly alt: string;
}

/**
 * Resolves the inline `mxc://` images of a sanitized body — MSC2545 custom emoji and, since
 * spec A2, ordinary images — through authenticated media, without the browser ever seeing an
 * `mxc:` URL. `sanitizeMatrixHtml` moved each source to `data-mx-src`, which Angular strips at
 * the leaf, so the sources are re-read from the sanitized string — parsed once, and only when it
 * declares one — and paired with the live elements in document order. Emoji resolve at once
 * (cap 50). Images (cap 10) wait until they come within one viewport of view and, inside a
 * concealed spoiler, until it is revealed; the sender's `width`/`height` reserve their box, no
 * taller than 300px. Click, Enter or Space on an image opens the full image in the shared
 * viewer; an image inside a link is left to the link.
 */
@Directive({
  selector: '[trnInlineMxcImages]',
  providers: [MediaViewerLauncher],
  host: {
    '(click)': 'onActivate($event)',
    '(keydown.enter)': 'onActivate($event)',
    '(keydown.space)': 'onActivate($event)',
  },
})
export class InlineMxcImagesDirective implements OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly media = inject(MediaService);
  private readonly visibility = inject(InlineImageVisibility);
  // The viewer, MediaPipeline and the toast are needed only on activation, so they are
  // resolved then, not for every body rendered.
  private readonly injector = inject(Injector);
  private readonly spoilers = inject(SpoilerRevealDirective, {
    optional: true,
    self: true,
  });
  /** Everything tied to the current body: resolves, decode listeners, visibility waits. */
  private subscriptions = new Subscription();
  /**
   * Viewer requests outlive a re-render of the body (an edit arriving while the full image
   * loads must not swallow the reader's tap); they end with the directive. The launcher, a
   * provider of this directive, is destroyed first and cancels or closes on its own; this
   * only covers the reverse order.
   */
  private readonly viewerRequests = new Subscription();
  /** One entry per pin taken: the same emoji twice in a body pins its shared URL twice. */
  private pinned: string[] = [];
  /** Images on screen and what they show, for the viewer. */
  private readonly images = new Map<HTMLImageElement, Declaration>();
  /** Images inside a concealed spoiler, with what to start once it is revealed. */
  private readonly concealed = new Map<HTMLImageElement, () => void>();
  private readonly reveal = latestGuard();

  readonly source = input('', { alias: 'trnInlineMxcImages' });

  constructor() {
    this.spoilers?.revealed
      .pipe(takeUntilDestroyed())
      .subscribe((spoiler) => this.startRevealed(spoiler));
    effect(() => {
      const source = this.source();
      const token = this.reveal.next();
      this.release();
      queueMicrotask(() => {
        if (this.reveal.isCurrent(token)) this.resolve(source);
      });
    });
  }

  ngOnDestroy(): void {
    this.reveal.invalidate();
    this.release();
    this.viewerRequests.unsubscribe();
  }

  /** Click, Enter or Space on an inline image (not one inside a link) opens the viewer. */
  onActivate(event: Event): void {
    // The spoiler directive, composed first, consumed this activation to reveal.
    if (event.defaultPrevented) {
      return;
    }
    const host = this.host.nativeElement;
    const image = (event.target as Element | null)?.closest('img.mx-image');
    if (!(image instanceof HTMLImageElement) || !host.contains(image)) {
      return;
    }
    const link = image.closest('a');
    if (link && host.contains(link)) {
      return;
    }
    const declaration = this.images.get(image);
    if (!declaration) {
      return;
    }
    event.preventDefault();
    const reference = this.injector
      .get(MediaPipeline)
      .present(payloadFor(declaration));
    this.viewerRequests.add(
      this.injector
        .get(MediaViewerLauncher)
        .open(reference)
        .subscribe((outcome) => this.onViewerOutcome(outcome)),
    );
  }

  private onViewerOutcome(outcome: MediaViewerOutcome): void {
    switch (outcome) {
      case 'opened':
      case 'busy':
        return;
      case 'failed':
        this.injector
          .get(TrnToastService)
          .show('Couldn’t open this image. Try again.', { variant: 'danger' });
        return;
      default: {
        const unhandled: never = outcome;
        void unhandled;
      }
    }
  }

  private resolve(sourceHtml: string): void {
    // Most bodies declare no inline image, and parsing every one of them is real work.
    const source = sourceHtml.includes('data-mx-src')
      ? new DOMParser().parseFromString(sourceHtml, 'text/html')
      : null;
    const declarations = [
      ...(source?.querySelectorAll(INLINE_IMAGES) ?? []),
    ].map(declarationOf);
    const targets = [
      ...this.host.nativeElement.querySelectorAll<HTMLImageElement>(
        INLINE_IMAGES,
      ),
    ];
    let emotes = 0;
    let images = 0;
    targets.forEach((target, index) => {
      const kind: InlineKind = target.classList.contains('mx-image')
        ? 'image'
        : 'emote';
      const withinCap =
        kind === 'emote'
          ? ++emotes <= MAX_INLINE_EMOTES
          : ++images <= MAX_INLINE_IMAGES;
      const declaration = declarations[index];
      if (
        !declaration ||
        declaration.kind !== kind ||
        !MXC_URI.test(declaration.mxc) ||
        !withinCap
      ) {
        fallBack(target, declaration?.alt ?? fallbackAlt(target, kind));
        return;
      }
      target.removeAttribute('src');
      if (kind === 'emote') {
        this.load(target, declaration);
        return;
      }
      this.images.set(target, declaration);
      reserveBox(target);
      target.classList.add('mx-image--loading');
      const start = (): void => {
        this.subscriptions.add(
          this.visibility.whenNear(target, () =>
            this.load(target, declaration),
          ),
        );
      };
      if (target.closest(CONCEALED)) {
        this.concealed.set(target, start);
      } else {
        start();
      }
    });
  }

  /** Resolve, pin and show one image; on any failure it becomes its alt text. */
  private load(target: HTMLImageElement, declaration: Declaration): void {
    this.subscriptions.add(
      this.media.resolveMedia(payloadFor(declaration), 'thumbnail').subscribe({
        next: (url) => {
          this.media.pin(url);
          this.pinned.push(url);
          this.subscriptions.add(
            fromEvent(target, 'error')
              .pipe(take(1))
              .subscribe(() => {
                const at = this.pinned.indexOf(url);
                if (at >= 0) {
                  this.pinned.splice(at, 1);
                  this.media.unpin(url);
                }
                this.forget(target);
                fallBack(target, declaration.alt);
              }),
          );
          this.subscriptions.add(
            fromEvent(target, 'load')
              .pipe(take(1))
              .subscribe(() => target.classList.remove('mx-image--loading')),
          );
          target.src = url;
        },
        error: () => {
          this.forget(target);
          fallBack(target, declaration.alt);
        },
      }),
    );
  }

  /** Start the images a just-revealed spoiler was holding back. */
  private startRevealed(spoiler: HTMLElement): void {
    for (const [image, start] of this.concealed) {
      if (spoiler.contains(image) && !image.closest(CONCEALED)) {
        this.concealed.delete(image);
        start();
      }
    }
  }

  private forget(image: HTMLImageElement): void {
    this.images.delete(image);
    this.concealed.delete(image);
  }

  private release(): void {
    this.subscriptions.unsubscribe();
    this.subscriptions = new Subscription();
    for (const url of this.pinned) this.media.unpin(url);
    this.pinned = [];
    this.images.clear();
    this.concealed.clear();
  }
}

function declarationOf(image: Element): Declaration {
  const kind: InlineKind = image.classList.contains('mx-image')
    ? 'image'
    : 'emote';
  return {
    kind,
    mxc: image.getAttribute('data-mx-src') ?? '',
    alt: image.getAttribute('alt') ?? defaultAlt(kind),
  };
}

function defaultAlt(kind: InlineKind): string {
  return kind === 'emote' ? 'custom emoji' : 'Image';
}

function fallbackAlt(image: HTMLImageElement, kind: InlineKind): string {
  return image.alt || defaultAlt(kind);
}

function payloadFor({ mxc, alt }: Declaration): MediaPayload {
  return {
    kind: 'image',
    mxc,
    file: null,
    filename: alt,
    mimeType: 'image/png',
    thumbnailMxc: null,
    thumbnailFile: null,
  };
}

/** Replace an image with its alt text, as a failed emoji always has been. */
function fallBack(image: HTMLImageElement, alt: string): void {
  image.replaceWith(image.ownerDocument.createTextNode(alt));
}

/** A sender's `width` or `height`, if it is a plain integer from 1 to {@link MAX_RESERVED_PX}. */
function senderSize(value: string | null): number | null {
  if (value === null || !SENDER_SIZE.test(value)) {
    return null;
  }
  const size = Number(value);
  return size >= 1 && size <= MAX_RESERVED_PX ? size : null;
}

/**
 * Cap the image at {@link IMAGE_MAX_HEIGHT_PX} and reserve the box a sender's `width` and
 * `height` describe, so the row does not jump when the image arrives: the same aspect ratio,
 * no taller than the cap; CSS `max-width: 100%` then fits it to the body. The attributes go
 * either way, so a sender's `height="20000"` is never drawn as a presentational hint, and the
 * reserved width is rounded down so the box cannot round past the cap.
 */
function reserveBox(image: HTMLImageElement): void {
  const width = senderSize(image.getAttribute('width'));
  const height = senderSize(image.getAttribute('height'));
  image.removeAttribute('width');
  image.removeAttribute('height');
  image.style.maxHeight = `${IMAGE_MAX_HEIGHT_PX}px`;
  if (width === null || height === null) {
    return;
  }
  const capped = Math.min(width, (IMAGE_MAX_HEIGHT_PX * width) / height);
  image.style.setProperty('aspect-ratio', `${width} / ${height}`);
  image.style.width = `${Math.floor(capped * 100) / 100}px`;
}
