import {
  Directive,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
} from '@angular/core';
import { MediaService } from '@trinity/data-access/media';
import type { MediaPayload } from '@trinity/util/matrix';
import { Subscription, fromEvent, take } from 'rxjs';

const MAX_INLINE_EMOTES = 50;

/** Resolves sanitized MSC2545 inline `mxc://` images without exposing remote URLs. */
@Directive({ selector: '[trnInlineMxcImages]' })
export class InlineMxcImagesDirective implements OnDestroy {
  readonly source = input('', { alias: 'trnInlineMxcImages' });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly media = inject(MediaService);
  private subscriptions = new Subscription();
  private readonly pinned = new Set<string>();
  private generation = 0;

  constructor() {
    effect(() => {
      const source = this.source();
      const generation = ++this.generation;
      this.release();
      queueMicrotask(() => {
        if (generation === this.generation) this.resolve(source);
      });
    });
  }

  ngOnDestroy(): void {
    this.generation += 1;
    this.release();
  }

  private resolve(sourceHtml: string): void {
    const source = new DOMParser().parseFromString(sourceHtml, 'text/html');
    const declarations = [...source.querySelectorAll('img[data-mx-emoticon]')]
      .map((image) => ({
        mxc: image.getAttribute('src') ?? '',
        alt: image.getAttribute('alt') ?? 'custom emoji',
      }))
      .filter(({ mxc }) => /^mxc:\/\/[^/\s]+\/[^\s]+$/.test(mxc))
      .slice(0, MAX_INLINE_EMOTES);
    const targets = [
      ...this.host.nativeElement.querySelectorAll<HTMLImageElement>(
        'img.mx-emoticon',
      ),
    ].slice(0, MAX_INLINE_EMOTES);

    targets.forEach((target, index) => {
      const declaration = declarations[index];
      if (!declaration) {
        target.replaceWith(
          document.createTextNode(target.alt || 'custom emoji'),
        );
        return;
      }
      target.removeAttribute('src');
      const payload: MediaPayload = {
        kind: 'image',
        mxc: declaration.mxc,
        file: null,
        filename: declaration.alt,
        mimeType: 'image/png',
        thumbnailMxc: null,
        thumbnailFile: null,
      };
      this.subscriptions.add(
        this.media.resolveMedia(payload, 'thumbnail').subscribe({
          next: (url) => {
            this.media.pin(url);
            this.pinned.add(url);
            this.subscriptions.add(
              fromEvent(target, 'error')
                .pipe(take(1))
                .subscribe(() => {
                  if (this.pinned.delete(url)) this.media.unpin(url);
                  target.replaceWith(document.createTextNode(declaration.alt));
                }),
            );
            target.src = url;
          },
          error: () =>
            target.replaceWith(document.createTextNode(declaration.alt)),
        }),
      );
    });
  }

  private release(): void {
    this.subscriptions.unsubscribe();
    this.subscriptions = new Subscription();
    for (const url of this.pinned) this.media.unpin(url);
    this.pinned.clear();
  }
}
