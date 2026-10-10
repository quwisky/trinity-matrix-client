import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@trinity/testing';
import {
  MediaBubbleComponent,
  type MediaBubbleItem,
} from './media-bubble.component';

/** Build a media item, overriding only the fields a test cares about. */
const item = (over: Partial<MediaBubbleItem> = {}): MediaBubbleItem => ({
  kind: 'file',
  filename: 'attachment',
  mimeType: 'application/octet-stream',
  ...over,
});

describe('MediaBubbleComponent', () => {
  it('renders an <img> with the resolved src and alt for an image', async () => {
    const { container } = await render(MediaBubbleComponent, {
      inputs: {
        item: item({
          kind: 'image',
          filename: 'pic.png',
          mimeType: 'image/png',
        }),
        src: 'blob:thumb',
      },
    });

    const img = container.querySelector('img.media__img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('blob:thumb');
    expect(img?.getAttribute('alt')).toBe('pic.png');
  });

  describe('lazy image loading', () => {
    const image = (over: Partial<MediaBubbleItem> = {}) =>
      render(MediaBubbleComponent, {
        inputs: {
          item: item({ kind: 'image', mimeType: 'image/png', ...over }),
          src: 'blob:thumb',
        },
      }).then(({ container }) =>
        container.querySelector<HTMLImageElement>('img.media__img')!,
      );

    it('loads lazily with intrinsic width and height when the event states its size', async () => {
      const img = await image({ width: 640, height: 480 });

      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('width')).toBe('640');
      expect(img.getAttribute('height')).toBe('480');
    });

    it('stays eager when the size is unknown, so its late reflow cannot happen mid-scroll', async () => {
      const img = await image();

      expect(img.hasAttribute('loading')).toBe(false);
      expect(img.hasAttribute('width')).toBe(false);
      expect(img.hasAttribute('height')).toBe(false);
    });
  });

  it('renders a download file-card for a file kind', async () => {
    const { container } = await render(MediaBubbleComponent, {
      inputs: { item: item({ kind: 'file', filename: 'report.pdf' }) },
    });

    const card = container.querySelector('.media--file:not(.media--error)');
    expect(card).toBeTruthy();
    expect(container.querySelector('.media__name')?.textContent).toContain(
      'report.pdf',
    );
  });

  it('reflects the render state via data-media-state', async () => {
    const { fixture } = await render(MediaBubbleComponent, {
      // No src yet → still loading.
      inputs: { item: item({ kind: 'image' }), src: null },
    });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('data-media-state')).toBe('loading');

    // A resolved src → ready.
    fixture.componentRef.setInput('src', 'blob:thumb');
    fixture.detectChanges();
    expect(host.getAttribute('data-media-state')).toBe('ready');

    // An error input wins over everything.
    fixture.componentRef.setInput('error', true);
    fixture.detectChanges();
    expect(host.getAttribute('data-media-state')).toBe('error');
  });

  it('emits openLightbox when the image is clicked', async () => {
    const { fixture, container } = await render(MediaBubbleComponent, {
      inputs: { item: item({ kind: 'image' }), src: 'blob:thumb' },
    });

    let opened = 0;
    fixture.componentInstance.openLightbox.subscribe(() => opened++);
    container.querySelector<HTMLElement>('.media--image')!.click();

    expect(opened).toBe(1);
  });

  it('emits download when the file-card is clicked', async () => {
    const { fixture, container } = await render(MediaBubbleComponent, {
      inputs: { item: item({ kind: 'file' }) },
    });

    let downloaded = 0;
    fixture.componentInstance.download.subscribe(() => downloaded++);
    container.querySelector<HTMLElement>('.media--file')!.click();

    expect(downloaded).toBe(1);
  });

  it('renders a human-readable size in the file-card subtitle', async () => {
    const { container } = await render(MediaBubbleComponent, {
      inputs: { item: item({ kind: 'file', size: 1536 }) }, // 1.5 KB
    });

    expect(container.querySelector('.media__sub')?.textContent).toContain(
      '1.5 KB',
    );
  });

  it('shows the error file-card (download fallback) after the <img> fails to load', async () => {
    const { fixture, container } = await render(MediaBubbleComponent, {
      inputs: { item: item({ kind: 'image' }), src: 'blob:broken' },
    });

    container
      .querySelector('img.media__img')!
      .dispatchEvent(new Event('error'));
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('data-media-state')).toBe('error');
    expect(host.querySelector('.media--error')).toBeTruthy();

    let downloaded = 0;
    fixture.componentInstance.download.subscribe(() => downloaded++);
    host.querySelector<HTMLElement>('.media--error')!.click();
    expect(downloaded).toBe(1);
  });

  it('reserves the box from the event’s own dimensions', async () => {
    const { container } = await render(MediaBubbleComponent, {
      inputs: {
        item: item({ kind: 'image', width: 800, height: 600 }),
        src: 'blob:pic',
      },
    });

    expect(
      container
        .querySelector<HTMLElement>('.media--image')
        ?.style.getPropertyValue('aspect-ratio'),
    ).toBe('800 / 600');
  });

  it('still reserves a box when the event omits its dimensions', async () => {
    // Plenty of clients send no `w`/`h`, and an encrypted attachment may carry none at all.
    // Reserving nothing means the row is one line tall until the image decodes and several
    // hundred pixels tall afterwards — the jump the reservation exists to prevent.
    const { container } = await render(MediaBubbleComponent, {
      inputs: { item: item({ kind: 'image' }), src: 'blob:pic' },
    });

    expect(
      container
        .querySelector<HTMLElement>('.media--image')
        ?.style.getPropertyValue('aspect-ratio'),
    ).toBe('16 / 9');
  });

  it('reserves the box for a video too, not just an image', async () => {
    const { container } = await render(MediaBubbleComponent, {
      inputs: {
        item: item({ kind: 'video', width: 1920, height: 1080 }),
        src: 'blob:clip',
      },
    });

    expect(
      container
        .querySelector<HTMLElement>('.media--video')
        ?.style.getPropertyValue('aspect-ratio'),
    ).toBe('1920 / 1080');
  });

  it('paints the skeleton in something other than its container', async () => {
    // Read from the stylesheet rather than the DOM because the bug is a RELATIONSHIP between
    // two colours, and jsdom resolves no custom properties — `getComputedStyle` would report
    // the literal `var(--trinity-sidebar)` for both and happily call them different.
    //
    // This is the workspace's only skeleton and it shipped invisible: `.media__skeleton` and
    // the `.media--image` it sits inside were both `var(--trinity-sidebar)`, so the loading
    // state was a box the same colour as the box around it.
    const scss = readFileSync(
      join(import.meta.dirname, 'media-bubble.component.scss'),
      'utf8',
    );
    const backgroundOf = (selector: string) => {
      const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(scss);
      return /background:\s*([^;]+);/.exec(block?.[1] ?? '')?.[1]?.trim();
    };

    const skeleton = backgroundOf('.media__skeleton');
    const container = backgroundOf('.media--image');

    expect(skeleton).toBeDefined();
    expect(container).toBeDefined();
    expect(skeleton).not.toBe(container);
  });
});

describe('MediaBubbleComponent — the reservation gives way to the real shape', () => {
  /** Give an <img> the intrinsic size a decoded file would report, then fire its load. */
  const decodesAs = (img: HTMLImageElement, width: number, height: number) => {
    Object.defineProperty(img, 'naturalWidth', { value: width });
    Object.defineProperty(img, 'naturalHeight', { value: height });
    img.dispatchEvent(new Event('load'));
  };

  it('uses the loaded dimensions once an image reports them', async () => {
    // The 16 / 9 fallback exists so a dimensionless attachment does not make the timeline
    // jump. Left bound after the file has loaded it stops reserving and starts SHAPING the
    // box to proportions the picture does not have — with `object-fit: contain`, a portrait
    // screenshot is then letterboxed inside a landscape box for good.
    const { container, fixture } = await render(MediaBubbleComponent, {
      inputs: {
        item: item({ kind: 'image', filename: 'p.png', mimeType: 'image/png' }),
        src: 'blob:first',
      },
    });
    const box = container.querySelector('.media--image') as HTMLElement;
    expect(box.style.aspectRatio).toBe('16 / 9');

    decodesAs(container.querySelector('img') as HTMLImageElement, 600, 900);
    fixture.detectChanges();

    expect(box.style.aspectRatio).toBe('600 / 900');
  });

  it("keeps the event's own dimensions over the loaded ones", async () => {
    // `info.w`/`info.h` are what the timeline reserved space with before the bytes existed.
    // Letting a load event overwrite them would move the box AFTER it was already correct,
    // which is the layout shift this whole computed exists to prevent.
    const { container, fixture } = await render(MediaBubbleComponent, {
      inputs: {
        item: item({
          kind: 'image',
          filename: 'p.png',
          mimeType: 'image/png',
          width: 800,
          height: 400,
        }),
        src: 'blob:first',
      },
    });
    const box = container.querySelector('.media--image') as HTMLElement;
    expect(box.style.aspectRatio).toBe('800 / 400');

    decodesAs(container.querySelector('img') as HTMLImageElement, 600, 900);
    fixture.detectChanges();

    expect(box.style.aspectRatio).toBe('800 / 400');
  });

  it("forgets a previous attachment's shape when the source changes", async () => {
    // These instances are recycled down the timeline, so a measurement that outlived its
    // file would size the next picture to the last one's proportions.
    const { container, fixture } = await render(MediaBubbleComponent, {
      inputs: {
        item: item({ kind: 'image', filename: 'p.png', mimeType: 'image/png' }),
        src: 'blob:first',
      },
    });
    decodesAs(container.querySelector('img') as HTMLImageElement, 600, 900);
    fixture.detectChanges();
    const box = container.querySelector('.media--image') as HTMLElement;
    expect(box.style.aspectRatio).toBe('600 / 900');

    fixture.componentRef.setInput('src', 'blob:second');
    fixture.detectChanges();

    expect(box.style.aspectRatio).toBe('16 / 9');
  });
});

describe('MediaBubbleComponent — video and audio wait to be played', () => {
  const video = (over: Partial<MediaBubbleItem> = {}) =>
    item({
      kind: 'video',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      ...over,
    });
  const audio = (over: Partial<MediaBubbleItem> = {}) =>
    item({
      kind: 'audio',
      filename: 'note.ogg',
      mimeType: 'audio/ogg',
      ...over,
    });

  it('shows a play button named for the video and no <video> before it is played', async () => {
    const { container, fixture } = await render(MediaBubbleComponent, {
      inputs: { item: video({ width: 1280, height: 720 }) },
    });

    const play = container.querySelector<HTMLButtonElement>(
      'button.media--video',
    )!;
    expect(play.getAttribute('aria-label')).toBe('Play video clip.mp4');
    expect(play.style.aspectRatio).toBe('1280 / 720');
    expect(container.querySelector('video')).toBeNull();
    expect(
      (fixture.nativeElement as HTMLElement).getAttribute('data-media-state'),
    ).toBe('idle');
  });

  it('draws the poster as decoration when there is one, a neutral placeholder otherwise', async () => {
    const { container, fixture } = await render(MediaBubbleComponent, {
      inputs: { item: video(), poster: 'blob:poster' },
    });
    const img = container.querySelector<HTMLImageElement>('img.media__img');
    expect(img?.getAttribute('src')).toBe('blob:poster');
    // The button already carries the name; the poster is not a second description of it.
    expect(img?.getAttribute('alt')).toBe('');

    fixture.componentRef.setInput('poster', null);
    fixture.detectChanges();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.media__placeholder')).toBeTruthy();
  });

  it('shows the declared duration and size on the poster', async () => {
    const { container } = await render(MediaBubbleComponent, {
      inputs: { item: video({ durationMs: 83_000, size: 5_242_880 }) },
    });

    expect(container.querySelector('.media__badge')?.textContent?.trim()).toBe(
      '1:23 · 5.0 MB',
    );
  });

  it('emits play from the poster button, which a keyboard can reach', async () => {
    const { container, fixture } = await render(MediaBubbleComponent, {
      inputs: { item: video() },
    });
    let played = 0;
    fixture.componentInstance.playRequested.subscribe(() => played++);

    const button = container.querySelector<HTMLButtonElement>(
      'button.media--video',
    )!;
    expect(button.disabled).toBe(false);
    button.click();

    expect(played).toBe(1);
  });

  it('says it is loading, keeps focus on the control, and swallows presses meanwhile', async () => {
    const { container, fixture } = await render(MediaBubbleComponent, {
      inputs: { item: video(), loading: true },
    });
    let played = 0;
    fixture.componentInstance.playRequested.subscribe(() => played++);

    const button = container.querySelector<HTMLButtonElement>(
      'button.media--video',
    )!;
    expect(button.getAttribute('aria-label')).toBe('Loading video clip.mp4');
    expect(button.getAttribute('aria-busy')).toBe('true');
    // aria-disabled rather than disabled: a disabled button drops keyboard focus.
    expect(button.disabled).toBe(false);
    expect(container.querySelector('.media__badge')?.textContent).toContain(
      'Loading',
    );
    expect(
      (fixture.nativeElement as HTMLElement).getAttribute('data-media-state'),
    ).toBe('loading');
    button.click();

    expect(played).toBe(0);
  });

  it('starts the video once its metadata is ready', async () => {
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue();
    const { container } = await render(MediaBubbleComponent, {
      inputs: { item: video(), src: 'blob:clip' },
    });

    const el = container.querySelector('video')!;
    expect(el.getAttribute('aria-label')).toBe('Video: clip.mp4');
    el.dispatchEvent(new Event('loadedmetadata'));

    expect(playSpy).toHaveBeenCalledTimes(1);
    playSpy.mockRestore();
  });

  it('survives a blocked autoplay, leaving the native controls to start it', async () => {
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    const { container } = await render(MediaBubbleComponent, {
      inputs: { item: video(), src: 'blob:clip' },
    });

    container
      .querySelector('video')!
      .dispatchEvent(new Event('loadedmetadata'));
    await Promise.resolve();

    expect(playSpy).toHaveBeenCalledTimes(1);
    playSpy.mockRestore();
  });

  it('renders the audio player row with a play control and no <audio> before play', async () => {
    const { container, fixture } = await render(MediaBubbleComponent, {
      inputs: { item: audio({ durationMs: 61_000, size: 2048 }) },
    });

    const play = container.querySelector<HTMLButtonElement>(
      'button.media--audio',
    )!;
    expect(play.getAttribute('aria-label')).toBe('Play audio note.ogg');
    expect(container.querySelector('.media__name')?.textContent).toContain(
      'note.ogg',
    );
    expect(container.querySelector('.media__sub')?.textContent?.trim()).toBe(
      '1:01 · 2.0 KB',
    );
    expect(container.querySelector('audio')).toBeNull();

    let played = 0;
    fixture.componentInstance.playRequested.subscribe(() => played++);
    play.click();
    expect(played).toBe(1);
  });

  it('swaps the audio row for the native player, which starts playing, once loaded', async () => {
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue();
    const { container } = await render(MediaBubbleComponent, {
      inputs: { item: audio(), src: 'blob:note' },
    });

    const el = container.querySelector('audio')!;
    expect(el.getAttribute('aria-label')).toBe('Audio: note.ogg');
    el.dispatchEvent(new Event('loadedmetadata'));

    expect(container.querySelector('button.media--audio')).toBeNull();
    expect(playSpy).toHaveBeenCalledTimes(1);
    playSpy.mockRestore();
  });

  it.each([video(), audio()])(
    'falls back to the download card when loading fails ($kind)',
    async (media) => {
      const { container, fixture } = await render(MediaBubbleComponent, {
        inputs: { item: media, error: true },
      });

      expect(container.querySelector('.media--error')).toBeTruthy();
      expect(
        (fixture.nativeElement as HTMLElement).getAttribute('data-media-state'),
      ).toBe('error');
    },
  );
});
