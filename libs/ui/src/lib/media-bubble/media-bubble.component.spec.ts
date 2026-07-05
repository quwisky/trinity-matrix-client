import { render } from '@testing-library/angular';
import { MediaBubbleComponent } from './media-bubble.component';

describe('MediaBubbleComponent', () => {
  it('renders an <img> with the resolved src and alt for an image', async () => {
    const { container } = await render(MediaBubbleComponent, {
      inputs: { kind: 'image', src: 'blob:thumb', filename: 'pic.png' },
    });

    const img = container.querySelector('img.media__img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('blob:thumb');
    expect(img?.getAttribute('alt')).toBe('pic.png');
  });

  it('renders a download file-card for a file kind', async () => {
    const { container } = await render(MediaBubbleComponent, {
      inputs: { kind: 'file', filename: 'report.pdf' },
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
      inputs: { kind: 'image', src: null },
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
      inputs: { kind: 'image', src: 'blob:thumb' },
    });

    let opened = 0;
    fixture.componentInstance.openLightbox.subscribe(() => opened++);
    container.querySelector<HTMLElement>('.media--image')!.click();

    expect(opened).toBe(1);
  });

  it('emits download when the file-card is clicked', async () => {
    const { fixture, container } = await render(MediaBubbleComponent, {
      inputs: { kind: 'file' },
    });

    let downloaded = 0;
    fixture.componentInstance.download.subscribe(() => downloaded++);
    container.querySelector<HTMLElement>('.media--file')!.click();

    expect(downloaded).toBe(1);
  });

  it('renders a human-readable size in the file-card subtitle', async () => {
    const { container } = await render(MediaBubbleComponent, {
      inputs: { kind: 'file', size: 1536 }, // 1.5 KB
    });

    expect(container.querySelector('.media__sub')?.textContent).toContain(
      '1.5 KB',
    );
  });

  it('shows the error file-card (download fallback) after the <img> fails to load', async () => {
    const { fixture, container } = await render(MediaBubbleComponent, {
      inputs: { kind: 'image', src: 'blob:broken' },
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
});
