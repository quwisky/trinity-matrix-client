import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  TrnSurfaceService,
  TrnToastService,
  type ActionSheetButton,
} from '@trinity/components/overlay';
import {
  MediaPipeline,
  MediaService,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MediaViewerLauncher,
  type MediaViewerOutcome,
} from '../media-attachment/media-viewer-launcher';
import { AddToMyEmojiService } from '../shared/add-to-my-emoji.service';
import { SpoilerRevealDirective } from '../spoiler/spoiler-reveal.directive';
import { LOADING_PLACEHOLDER } from './inline-image-box';
import { InlineMxcImagesDirective } from './inline-mxc-images.directive';

@Component({
  imports: [InlineMxcImagesDirective, SpoilerRevealDirective],
  template: `<div
    class="body"
    trnSpoilerReveal
    [innerHTML]="html()"
    [trnInlineMxcImages]="html()"
  ></div>`,
})
class HostComponent {
  readonly html = signal('');
}

/** A controllable IntersectionObserver: `enter()` reports a target as within reach. */
class FakeIntersectionObserver {
  static readonly instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  static enter(target: Element): void {
    for (const observer of FakeIntersectionObserver.instances) {
      if (!observer.targets.has(target)) continue;
      observer.callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
    }
  }
}

describe('InlineMxcImagesDirective', () => {
  let resolved: Subject<string>;
  const media = { resolveMedia: vi.fn(), pin: vi.fn(), unpin: vi.fn() };
  const pipeline = {
    present: vi.fn(
      (payload: { mxc: string }) =>
        ({
          id: `presented-${payload.mxc}`,
          kind: 'image',
        }) as unknown as PresentedMediaReference,
    ),
  };
  const launcher = {
    open: vi.fn(() => of<MediaViewerOutcome>('opened')),
    close: vi.fn(),
  };
  const toast = { show: vi.fn() };

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resolved = new Subject<string>();
    media.resolveMedia.mockReset().mockReturnValue(resolved);
    media.pin.mockReset();
    media.unpin.mockReset();
    pipeline.present.mockClear();
    launcher.open.mockClear();
    toast.show.mockReset();
    FakeIntersectionObserver.instances.length = 0;
    TestBed.overrideDirective(InlineMxcImagesDirective, {
      set: {
        providers: [{ provide: MediaViewerLauncher, useValue: launcher }],
      },
    });
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        { provide: MediaService, useValue: media },
        { provide: MediaPipeline, useValue: pipeline },
        { provide: TrnToastService, useValue: toast },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Render `html` as the body string, exactly (pass it through sanitizeMatrixHtml first). */
  async function render(html: string) {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.html.set(html);
    fixture.detectChanges();
    await Promise.resolve();
    const host = fixture.nativeElement.querySelector('.body') as HTMLElement;
    return { fixture, host };
  }

  describe('custom emoji', () => {
    const wave = () =>
      sanitizeMatrixHtml(
        '<img data-mx-emoticon src="mxc://hs/wave" alt=":wave:">',
      );

    it('resolves mxc through MediaService and pins the displayed blob', async () => {
      const { host } = await render(wave());

      expect(media.resolveMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mxc: 'mxc://hs/wave' }),
        'thumbnail',
      );
      resolved.next('blob:wave');
      expect(host.querySelector('img')?.src).toBe('blob:wave');
      expect(media.pin).toHaveBeenCalledWith('blob:wave');
    });

    it('falls back to alt text when media resolution fails', async () => {
      const { host } = await render(wave());

      resolved.error(new Error('offline'));

      expect(host.textContent).toContain(':wave:');
      expect(host.querySelector('img')).toBeNull();
    });

    it('unpins resolved media on teardown', async () => {
      const { fixture } = await render(wave());
      resolved.next('blob:wave');

      fixture.destroy();

      expect(media.unpin).toHaveBeenCalledWith('blob:wave');
    });

    it('unpins and falls back when the resolved bytes cannot decode', async () => {
      const { host } = await render(wave());
      resolved.next('blob:wave');

      host.querySelector('img')!.dispatchEvent(new Event('error'));

      expect(media.unpin).toHaveBeenCalledWith('blob:wave');
      expect(host.textContent).toContain(':wave:');
      expect(host.querySelector('img')).toBeNull();
    });

    it('does not parse a body that declares no inline image', async () => {
      const body = '<p>plain <b>text</b></p>';
      const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');

      await render(body);

      // Angular's own sanitizer also parses, but never the bare body.
      expect(parse).not.toHaveBeenCalledWith(body, 'text/html');
      expect(media.resolveMedia).not.toHaveBeenCalled();
    });

    it('releases each of its pins when the same emoji appears twice, since pins are counted per view', async () => {
      const wave =
        '<img class="mx-emoticon" data-mx-emoticon data-mx-src="mxc://hs/wave" alt=":wave:">';
      const { fixture, host } = await render(`${wave} and ${wave}`);
      resolved.next('blob:wave'); // both images share the one cached URL

      // One image fails to decode, then the message goes.
      host.querySelector('img')!.dispatchEvent(new Event('error'));
      fixture.destroy();

      const count = (spy: typeof media.pin) =>
        spy.mock.calls.filter(([url]) => url === 'blob:wave').length;
      expect(count(media.pin)).toBe(2);
      expect(count(media.unpin)).toBe(2);
    });

    it('shows a source that is not a plain mxc id as its alt text', async () => {
      const { host } = await render(
        '<img class="mx-emoticon" data-mx-emoticon data-mx-src="mxc://hs/a.b?c" alt=":odd:">',
      );

      expect(media.resolveMedia).not.toHaveBeenCalled();
      expect(host.textContent).toBe(':odd:');
    });
  });

  describe('Add to my emoji', () => {
    const owned = signal<ReadonlySet<string> | null>(new Set());
    const adder = {
      owned,
      canAdd: (mxc: string) => owned()?.has(mxc) === false,
      add: vi.fn(),
    };
    let buttons: readonly ActionSheetButton[] = [];
    const surfaces = {
      openActions: vi.fn((data: { buttons: readonly ActionSheetButton[] }) => {
        buttons = data.buttons;
        return {};
      }),
    };
    const wave = () =>
      sanitizeMatrixHtml(
        '<img data-mx-emoticon src="mxc://hs/wave" alt=":wave:">',
      );

    beforeEach(() => {
      owned.set(new Set());
      adder.add.mockReset();
      surfaces.openActions.mockClear();
      TestBed.overrideProvider(AddToMyEmojiService, { useValue: adder });
      TestBed.overrideProvider(TrnSurfaceService, { useValue: surfaces });
    });

    it('shown for a custom emoji in a message', async () => {
      const { host } = await render(wave());
      resolved.next('blob:wave');
      const emote = host.querySelector('img')!;

      expect(emote.getAttribute('role')).toBe('button');
      expect(emote.tabIndex).toBe(0);
      emote.click();

      expect(surfaces.openActions).toHaveBeenCalledWith(
        expect.objectContaining({ header: ':wave:' }),
        expect.objectContaining({ anchor: emote, ariaLabel: ':wave:' }),
      );
      buttons.find((b) => b.text === 'Add to my emoji')!.handler!();
      expect(adder.add).toHaveBeenCalledWith(
        { kind: 'existing', url: 'mxc://hs/wave', body: 'wave' },
        'wave',
      );
    });

    it('hidden when that mxc is already in the pack', async () => {
      const { fixture, host } = await render(wave());
      resolved.next('blob:wave');
      const emote = host.querySelector('img')!;

      owned.set(new Set(['mxc://hs/wave']));
      fixture.detectChanges();

      expect(emote.getAttribute('role')).toBeNull();
      expect(emote.hasAttribute('tabindex')).toBe(false);
      emote.click();
      expect(surfaces.openActions).not.toHaveBeenCalled();
    });
  });

  describe('inline images', () => {
    beforeEach(() => {
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    });

    it('waits until the image is within one viewport before fetching', async () => {
      const { host } = await render(
        sanitizeMatrixHtml('<img src="mxc://hs/pic" alt="pic">'),
      );
      const image = host.querySelector('img')!;

      expect(media.resolveMedia).not.toHaveBeenCalled();
      expect(FakeIntersectionObserver.instances[0]?.options?.rootMargin).toBe(
        '100% 0px',
      );

      FakeIntersectionObserver.enter(image);

      expect(media.resolveMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mxc: 'mxc://hs/pic' }),
        'thumbnail',
      );
      resolved.next('blob:pic');
      expect(image.src).toBe('blob:pic');
    });

    it('draws a transparent placeholder, never pinned, until the thumbnail loads', async () => {
      const { host } = await render(
        sanitizeMatrixHtml('<img src="mxc://hs/pic" alt="pic">'),
      );
      const image = host.querySelector('img')!;

      expect(image.getAttribute('src')).toBe(LOADING_PLACEHOLDER);
      expect(image.getAttribute('aria-label')).toBe('View image: pic');
      // The placeholder's own load and error are not the thumbnail's.
      image.dispatchEvent(new Event('load'));
      image.dispatchEvent(new Event('error'));
      expect(image.isConnected).toBe(true);
      expect(image.classList.contains('mx-image--loading')).toBe(true);

      FakeIntersectionObserver.enter(image);
      resolved.next('blob:pic');
      expect(image.getAttribute('src')).toBe('blob:pic');
      expect(media.pin).toHaveBeenCalledExactlyOnceWith('blob:pic');

      image.dispatchEvent(new Event('load'));
      expect(image.classList.contains('mx-image--loading')).toBe(false);
    });

    it('shares one observer per scroll root', async () => {
      const { host } = await render(
        sanitizeMatrixHtml(
          '<img src="mxc://hs/a" alt="a"><img src="mxc://hs/b" alt="b">',
        ),
      );

      expect(FakeIntersectionObserver.instances).toHaveLength(1);
      expect(FakeIntersectionObserver.instances[0].targets).toEqual(
        new Set(host.querySelectorAll('img')),
      );
    });

    it('stops waiting for an image whose message goes away', async () => {
      const { fixture } = await render(
        sanitizeMatrixHtml('<img src="mxc://hs/pic" alt="pic">'),
      );

      fixture.destroy();

      expect(FakeIntersectionObserver.instances[0].targets.size).toBe(0);
    });

    it('fetches at most 10 images and shows the rest as their alt text', async () => {
      // Hand-written past the render pass's own cap, as a stale cached string could be.
      const body = Array.from(
        { length: 12 },
        (_, i) =>
          `<img class="mx-image" data-mx-src="mxc://hs/i${i}" alt="i${i}">`,
      ).join('');
      const { host } = await render(body);

      for (const image of host.querySelectorAll('img')) {
        FakeIntersectionObserver.enter(image);
      }

      expect(media.resolveMedia).toHaveBeenCalledTimes(10);
      expect(host.querySelectorAll('img')).toHaveLength(10);
      expect(host.textContent).toBe('i10i11');
    });

    it('fetches no emoji inside a concealed spoiler until it is revealed', async () => {
      const { host } = await render(
        sanitizeMatrixHtml(
          '<span data-mx-spoiler>secret <img data-mx-emoticon src="mxc://hs/wave" alt=":wave:"></span>',
        ),
      );
      // Hidden by the spoiler, but a fetch would still tell the media server it was shown.
      expect(media.resolveMedia).not.toHaveBeenCalled();

      host.querySelector<HTMLElement>('.mx-spoiler')!.click();

      expect(media.resolveMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mxc: 'mxc://hs/wave' }),
        'thumbnail',
      );
    });

    it('fetches an emoji in nested spoilers only once the innermost is revealed', async () => {
      const { host } = await render(
        sanitizeMatrixHtml(
          '<span data-mx-spoiler>outer <span data-mx-spoiler>inner <img data-mx-emoticon src="mxc://hs/wave" alt=":wave:"></span></span>',
        ),
      );
      const [outer, inner] = host.querySelectorAll<HTMLElement>('.mx-spoiler');

      outer.click();
      expect(media.resolveMedia).not.toHaveBeenCalled();
      inner.click();

      expect(media.resolveMedia).toHaveBeenCalledTimes(1);
    });

    it('does not fetch inside a concealed spoiler until it is revealed', async () => {
      const { host } = await render(
        sanitizeMatrixHtml(
          '<span data-mx-spoiler>look <img src="mxc://hs/secret" alt="secret"></span>',
        ),
      );
      const image = host.querySelector('img')!;

      FakeIntersectionObserver.enter(image);
      expect(media.resolveMedia).not.toHaveBeenCalled();

      host.querySelector<HTMLElement>('.mx-spoiler')!.click();
      FakeIntersectionObserver.enter(image);

      expect(media.resolveMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mxc: 'mxc://hs/secret' }),
        'thumbnail',
      );
    });

    it('replaces an image that fails with its alt text', async () => {
      media.resolveMedia.mockReturnValue(throwError(() => new Error('gone')));
      const { host } = await render(
        sanitizeMatrixHtml('<img src="mxc://hs/pic" alt="the picture">'),
      );

      FakeIntersectionObserver.enter(host.querySelector('img')!);

      expect(host.querySelector('img')).toBeNull();
      expect(host.textContent).toBe('the picture');
    });

    it('releases the pin of an image that cannot decode', async () => {
      const { host } = await render(
        sanitizeMatrixHtml('<img src="mxc://hs/pic" alt="pic">'),
      );
      const image = host.querySelector('img')!;
      FakeIntersectionObserver.enter(image);
      resolved.next('blob:pic');

      image.dispatchEvent(new Event('error'));

      expect(media.unpin).toHaveBeenCalledExactlyOnceWith('blob:pic');
      expect(host.textContent).toBe('pic');
    });

    it('reserves the sender’s box within the stylesheet’s height cap', async () => {
      const { host } = await render(
        sanitizeMatrixHtml(
          '<img src="mxc://hs/pic" width="1200" height="900" alt="pic">',
        ),
      );
      const image = host.querySelector('img')!;

      expect(image.style.aspectRatio).toBe('1200 / 900');
      expect(image.style.width).toBe(
        'min(1200px, calc(var(--trinity-message-image-max-height) * 1200 / 900))',
      );
    });

    it('never draws a sender’s height as a presentational hint', async () => {
      const { host } = await render(
        sanitizeMatrixHtml(
          '<img src="mxc://hs/pic" width="10" height="20000" alt="pic">',
        ),
      );
      const image = host.querySelector('img')!;

      // No 20000px box, loaded or not. The cap itself is the stylesheet's alone (the Inline
      // images journey measures it in a browser), so nothing inline repeats it.
      expect(image.hasAttribute('height')).toBe(false);
      expect(image.hasAttribute('width')).toBe(false);
      expect(image.style.height).toBe('');
      expect(image.style.width).toBe('');
      expect(image.style.maxHeight).toBe('');
    });

    it('opens the full image on click, Enter and Space', async () => {
      const { host } = await render(
        sanitizeMatrixHtml('<img src="mxc://hs/pic" alt="pic">'),
      );
      const image = host.querySelector('img')!;

      image.click();
      image.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      const space = new KeyboardEvent('keydown', {
        key: ' ',
        bubbles: true,
        cancelable: true,
      });
      image.dispatchEvent(space);

      expect(launcher.open).toHaveBeenCalledTimes(3);
      expect(pipeline.present).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'image',
          mxc: 'mxc://hs/pic',
          filename: 'pic',
        }),
      );
      // Space does not also scroll the page.
      expect(space.defaultPrevented).toBe(true);
    });

    it('follows the link instead of opening the viewer', async () => {
      const { host } = await render(
        sanitizeMatrixHtml(
          '<a href="https://example.org/full"><img src="mxc://hs/thumb" alt="thumb"></a>',
        ),
      );
      const image = host.querySelector('img')!;
      // jsdom would otherwise try to navigate.
      host
        .querySelector('a')!
        .addEventListener('click', (event) => event.preventDefault());

      const click = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      });
      image.dispatchEvent(click);

      expect(launcher.open).not.toHaveBeenCalled();
      expect(image.hasAttribute('role')).toBe(false);
    });

    it('opens the viewer for an image inside a link with no href', async () => {
      const { host } = await render(
        sanitizeMatrixHtml('<a><img src="mxc://hs/pic" alt="pic"></a>'),
      );
      const image = host.querySelector('img')!;

      image.click();

      expect(image.getAttribute('role')).toBe('button');
      expect(launcher.open).toHaveBeenCalledTimes(1);
    });

    describe('inside nested spoilers', () => {
      const nested = () =>
        sanitizeMatrixHtml(
          '<span data-mx-spoiler>outer <span data-mx-spoiler>inner <img src="mxc://hs/pic" alt="pic"></span></span>',
        );

      it('opens nothing while an outer spoiler still conceals the image', async () => {
        const { host } = await render(nested());
        const image = host.querySelector('img')!;

        image.click(); // reveals the inner spoiler only
        image.click();
        for (const key of ['Enter', ' ']) {
          image.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true }),
          );
        }

        expect(host.querySelectorAll('.mx-spoiler.is-revealed')).toHaveLength(
          1,
        );
        expect(launcher.open).not.toHaveBeenCalled();
      });

      it('opens the image once every spoiler around it is revealed', async () => {
        const { host } = await render(nested());
        const image = host.querySelector('img')!;
        const [outer, inner] =
          host.querySelectorAll<HTMLElement>('.mx-spoiler');

        inner.click();
        outer.click();
        image.click();

        expect(launcher.open).toHaveBeenCalledTimes(1);
      });
    });

    describe('in a spoiler that holds only images', () => {
      const IMAGE_ONLY = 'mx-spoiler--image-only';

      it('marks the spoiler so it still draws a bar, and loads the image on reveal', async () => {
        const { host } = await render(
          sanitizeMatrixHtml(
            '<span data-mx-spoiler> <img src="mxc://hs/secret" alt="secret"> </span>',
          ),
        );
        const spoiler = host.querySelector<HTMLElement>('.mx-spoiler')!;
        const image = host.querySelector('img')!;

        expect(spoiler.classList.contains(IMAGE_ONLY)).toBe(true);

        spoiler.click();
        FakeIntersectionObserver.enter(image);

        expect(spoiler.classList.contains(IMAGE_ONLY)).toBe(false);
        expect(media.resolveMedia).toHaveBeenCalledWith(
          expect.objectContaining({ mxc: 'mxc://hs/secret' }),
          'thumbnail',
        );
      });

      it('leaves a spoiler with text of its own unmarked', async () => {
        const { host } = await render(
          sanitizeMatrixHtml(
            '<span data-mx-spoiler>look <img src="mxc://hs/secret" alt="secret"></span>',
          ),
        );

        expect(
          host.querySelector('.mx-spoiler')!.classList.contains(IMAGE_ONLY),
        ).toBe(false);
      });

      it('marks one nested spoiler at a time, outermost first', async () => {
        const { host } = await render(
          sanitizeMatrixHtml(
            '<span data-mx-spoiler><span data-mx-spoiler><img src="mxc://hs/secret" alt="secret"></span></span>',
          ),
        );
        const [outer, inner] =
          host.querySelectorAll<HTMLElement>('.mx-spoiler');
        const image = host.querySelector('img')!;

        expect(outer.classList.contains(IMAGE_ONLY)).toBe(true);
        expect(inner.classList.contains(IMAGE_ONLY)).toBe(false);

        outer.click();
        expect(outer.classList.contains(IMAGE_ONLY)).toBe(false);
        expect(inner.classList.contains(IMAGE_ONLY)).toBe(true);
        FakeIntersectionObserver.enter(image);
        expect(media.resolveMedia).not.toHaveBeenCalled();

        inner.click();
        FakeIntersectionObserver.enter(image);
        expect(inner.classList.contains(IMAGE_ONLY)).toBe(false);
        expect(media.resolveMedia).toHaveBeenCalledTimes(1);
      });
    });

    it('keeps a concealed image out of the tab order and unnamed until revealed', async () => {
      const { host } = await render(
        sanitizeMatrixHtml(
          '<span data-mx-spoiler>look <img src="mxc://hs/secret" alt="secret"></span>',
        ),
      );
      const image = host.querySelector('img')!;

      expect(image.getAttribute('tabindex')).toBe('-1');
      expect(image.getAttribute('aria-hidden')).toBe('true');

      host.querySelector<HTMLElement>('.mx-spoiler')!.click();

      expect(image.getAttribute('tabindex')).toBe('0');
      expect(image.hasAttribute('aria-hidden')).toBe(false);
      expect(image.getAttribute('role')).toBe('button');
      expect(image.getAttribute('aria-label')).toBe('View image: secret');
    });

    it('leaves an image outside any spoiler reachable and named', async () => {
      const { host } = await render(
        sanitizeMatrixHtml('<img src="mxc://hs/pic" alt="pic">'),
      );
      const image = host.querySelector('img')!;

      expect(image.getAttribute('tabindex')).toBe('0');
      expect(image.hasAttribute('aria-hidden')).toBe(false);
      expect(image.getAttribute('aria-label')).toBe('View image: pic');
    });

    it('cancels the wait and releases the pin of an image when the body re-renders', async () => {
      const { fixture, host } = await render(
        sanitizeMatrixHtml(
          '<img src="mxc://hs/a" alt="a"><img src="mxc://hs/b" alt="b">',
        ),
      );
      const [first, second] = host.querySelectorAll('img');
      FakeIntersectionObserver.enter(first);
      resolved.next('blob:a'); // a is shown; b still waits to come near
      const observer = FakeIntersectionObserver.instances[0];
      expect(observer.targets.has(second)).toBe(true);

      fixture.componentInstance.html.set(sanitizeMatrixHtml('<p>edited</p>'));
      fixture.detectChanges();
      await Promise.resolve();

      expect(observer.targets.has(second)).toBe(false);
      expect(media.unpin).toHaveBeenCalledExactlyOnceWith('blob:a');
      FakeIntersectionObserver.enter(second);
      expect(media.resolveMedia).toHaveBeenCalledTimes(1);
    });

    it('releases each pin of an image that appears twice', async () => {
      const { fixture, host } = await render(
        sanitizeMatrixHtml(
          '<img src="mxc://hs/pic" alt="pic"> and <img src="mxc://hs/pic" alt="pic">',
        ),
      );
      const images = host.querySelectorAll('img');
      for (const image of images) FakeIntersectionObserver.enter(image);
      resolved.next('blob:pic'); // both images share the one cached URL

      images[0].dispatchEvent(new Event('error'));
      fixture.destroy();

      const count = (spy: typeof media.pin) =>
        spy.mock.calls.filter(([url]) => url === 'blob:pic').length;
      expect(count(media.pin)).toBe(2);
      expect(count(media.unpin)).toBe(2);
    });

    it('tells the reader when the image cannot be opened', async () => {
      launcher.open.mockReturnValueOnce(of<MediaViewerOutcome>('failed'));
      const { host } = await render(
        sanitizeMatrixHtml('<img src="mxc://hs/pic" alt="pic">'),
      );

      host.querySelector('img')!.click();

      expect(toast.show).toHaveBeenCalledWith(
        'Couldn’t open this image. Try again.',
        { variant: 'danger' },
      );
    });

    it('keeps a viewer request when the body re-renders', async () => {
      const pending = new Subject<MediaViewerOutcome>();
      launcher.open.mockReturnValueOnce(pending);
      const { fixture, host } = await render(
        sanitizeMatrixHtml('<img src="mxc://hs/pic" alt="pic">'),
      );
      host.querySelector('img')!.click();

      fixture.componentInstance.html.set(
        sanitizeMatrixHtml('<img src="mxc://hs/pic" alt="edited">'),
      );
      fixture.detectChanges();
      await Promise.resolve();

      expect(pending.observed).toBe(true);
      fixture.destroy();
      expect(pending.observed).toBe(false);
    });
  });
});
