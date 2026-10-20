import {
  Directive,
  ElementRef,
  Injector,
  OnDestroy,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import { MediaPipeline, MediaService } from '@trinity/data-access/media';
import type { MediaPayload } from '@trinity/util/matrix';
import { latestGuard } from '@trinity/util/ui';
import { Subscription, filter, fromEvent, take } from 'rxjs';
import {
  MediaViewerLauncher,
  type MediaViewerOutcome,
} from '../media-attachment/media-viewer-launcher';
import { AddToMyEmojiService } from '../shared/add-to-my-emoji.service';
import { SpoilerRevealDirective } from '../spoiler/spoiler-reveal.directive';
import {
  IMAGE_ONLY_SPOILER,
  LOADING_PLACEHOLDER,
  conceal,
  markImageOnlySpoiler,
  reserveBox,
  unconceal,
} from './inline-image-box';
import { InlineImageVisibility } from './inline-image-visibility';

const MAX_INLINE_EMOTES = 50;
/** Inline images one message may fetch, counted apart from emoji. */
const MAX_INLINE_IMAGES = 10;
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
 * Resolves the inline `mxc://` images of a sanitized body (MSC2545 custom emoji and
 * ordinary images) through authenticated media, without the browser ever seeing an `mxc:`
 * URL. `sanitizeMatrixHtml` moved each source to `data-mx-src`, which Angular strips at the
 * leaf, so the sources are re-read from the sanitized string and paired with the live
 * elements in document order. Emoji resolve at once (cap 50), or inside a concealed
 * spoiler once it is revealed: hidden is not enough, because the fetch itself tells the
 * media server the emoji was shown. Images (cap 10) wait until they come within one
 * viewport of view and, inside a concealed spoiler, until it is revealed. Click, Enter or
 * Space on an image opens the full image in the shared viewer; an image inside a link is
 * left to the link. A shown emoji not yet in the personal pack is a button whose menu offers
 * "Add to my emoji".
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
  private readonly adder = inject(AddToMyEmojiService);
  private readonly visibility = inject(InlineImageVisibility);
  // The viewer, MediaPipeline and toast are resolved on activation, not per rendered body.
  private readonly injector = inject(Injector);
  private readonly spoilers = inject(SpoilerRevealDirective, {
    optional: true,
    self: true,
  });
  /** Everything tied to the current body: resolves, decode listeners, visibility waits. */
  private subscriptions = new Subscription();
  /**
   * Viewer requests outlive a re-render of the body (an edit arriving while the full image
   * loads must not swallow the tap); they end with the directive. The launcher is destroyed
   * first and cancels on its own; this covers the reverse order.
   */
  private readonly viewerRequests = new Subscription();
  /** One entry per pin taken: the same emoji twice in a body pins its shared URL twice. */
  private pinned: string[] = [];
  /** Emoji on screen and what they show, for "Add to my emoji". */
  private readonly emotes = new Map<HTMLImageElement, Declaration>();
  /** Images on screen and what they show, for the viewer. */
  private readonly images = new Map<HTMLImageElement, Declaration>();
  /** Images inside a concealed spoiler, with what to start once it is revealed. */
  private readonly concealed = new Map<HTMLImageElement, () => void>();
  /** Emoji inside a concealed spoiler, with their load to start once it is revealed. */
  private readonly concealedEmotes = new Map<HTMLImageElement, () => void>();
  private readonly reveal = latestGuard();

  readonly source = input('', { alias: 'trnInlineMxcImages' });

  constructor() {
    this.spoilers?.revealed
      .pipe(takeUntilDestroyed())
      .subscribe((spoiler) => this.startRevealed(spoiler));
    effect(() => {
      this.adder.owned();
      untracked(() =>
        this.emotes.forEach((d, emote) => mark(emote, this.offers(emote, d))),
      );
    });
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
    const emote = (event.target as Element | null)?.closest('img.mx-emoticon');
    if (emote instanceof HTMLImageElement && host.contains(emote)) {
      this.offerEmote(event, emote);
      return;
    }
    const image = (event.target as Element | null)?.closest('img.mx-image');
    if (!(image instanceof HTMLImageElement) || !host.contains(image)) {
      return;
    }
    // A link wins (the render pass gave this image no button role), and an image an outer
    // spoiler still conceals opens nothing: a click there only revealed an inner one.
    const link = image.closest('a[href]');
    if ((link && host.contains(link)) || image.closest(CONCEALED)) {
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

  private offerEmote(event: Event, emote: HTMLImageElement): void {
    const declaration = this.emotes.get(emote);
    if (!declaration || !this.offers(emote, declaration)) {
      return;
    }
    event.preventDefault();
    const name = declaration.alt.replace(/^:|:$/g, '');
    this.injector.get(TrnSurfaceService).openActions(
      {
        header: declaration.alt,
        buttons: [
          {
            text: 'Add to my emoji',
            icon: 'smile',
            handler: () =>
              this.adder.add(
                { kind: 'existing', url: declaration.mxc, body: name },
                name,
              ),
          },
          { text: 'Cancel', role: 'cancel' },
        ],
      },
      { anchor: emote, ariaLabel: declaration.alt },
    );
  }

  /** An emoji inside a link is left to the link, as an image is. */
  private offers(emote: HTMLImageElement, { mxc }: Declaration): boolean {
    const link = emote.closest('a[href]');
    return (
      this.adder.canAdd(mxc) &&
      !(link && this.host.nativeElement.contains(link))
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
    // Most bodies declare no inline image; parsing every one is real work.
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
        const load = (): void => this.load(target, declaration);
        if (target.closest(CONCEALED)) {
          this.concealedEmotes.set(target, load);
        } else {
          load();
        }
        return;
      }
      this.images.set(target, declaration);
      reserveBox(target);
      target.classList.add('mx-image--loading');
      // Something decodable until the thumbnail arrives: an image with no source draws the
      // browser's broken-image icon.
      target.src = LOADING_PLACEHOLDER;
      const start = (): void => {
        this.subscriptions.add(
          this.visibility.whenNear(target, () =>
            this.load(target, declaration),
          ),
        );
      };
      if (target.closest(CONCEALED)) {
        conceal(target);
        markImageOnlySpoiler(target, this.host.nativeElement);
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
          // Only the thumbnail's own events count, not the placeholder's.
          const own = filter(() => target.getAttribute('src') === url);
          this.subscriptions.add(
            fromEvent(target, 'error')
              .pipe(own, take(1))
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
              .pipe(own, take(1))
              .subscribe(() => target.classList.remove('mx-image--loading')),
          );
          target.src = url;
          if (declaration.kind === 'emote') {
            this.emotes.set(target, declaration);
            mark(target, this.offers(target, declaration));
          }
        },
        error: () => {
          this.forget(target);
          fallBack(target, declaration.alt);
        },
      }),
    );
  }

  /**
   * Start the images and emoji a just-revealed spoiler was holding back; an image a nested
   * spoiler still conceals gets that spoiler's bar instead, and an emoji keeps waiting.
   */
  private startRevealed(spoiler: HTMLElement): void {
    spoiler.classList.remove(IMAGE_ONLY_SPOILER);
    for (const [emote, load] of this.concealedEmotes) {
      if (spoiler.contains(emote) && !emote.closest(CONCEALED)) {
        this.concealedEmotes.delete(emote);
        load();
      }
    }
    for (const [image, start] of this.concealed) {
      if (!spoiler.contains(image)) continue;
      if (image.closest(CONCEALED)) {
        markImageOnlySpoiler(image, this.host.nativeElement);
        continue;
      }
      this.concealed.delete(image);
      unconceal(image);
      start();
    }
  }

  private forget(image: HTMLImageElement): void {
    this.emotes.delete(image);
    this.images.delete(image);
    this.concealed.delete(image);
    this.concealedEmotes.delete(image);
  }

  private release(): void {
    this.subscriptions.unsubscribe();
    this.subscriptions = new Subscription();
    for (const url of this.pinned) this.media.unpin(url);
    this.pinned = [];
    this.emotes.clear();
    this.images.clear();
    this.concealed.clear();
    this.concealedEmotes.clear();
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
    // Unknown: an inline image declares no type; claiming PNG would flatten an animated GIF
    // the full view downscales.
    mimeType: 'application/octet-stream',
    thumbnailMxc: null,
    thumbnailFile: null,
  };
}

/** Make an emoji a button for its "Add to my emoji" menu, or plain again. */
function mark(emote: HTMLImageElement, offered: boolean): void {
  if (offered) {
    emote.setAttribute('role', 'button');
    emote.setAttribute('aria-haspopup', 'menu');
    emote.tabIndex = 0;
  } else {
    emote.removeAttribute('role');
    emote.removeAttribute('aria-haspopup');
    emote.removeAttribute('tabindex');
  }
}

/** Replace an image with its alt text, as a failed emoji always has been. */
function fallBack(image: HTMLImageElement, alt: string): void {
  image.replaceWith(image.ownerDocument.createTextNode(alt));
}
