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
