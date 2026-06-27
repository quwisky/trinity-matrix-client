import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MediaBubbleComponent } from './media-bubble.component';

describe('MediaBubbleComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [MediaBubbleComponent] }),
  );

  function create() {
    return TestBed.createComponent(MediaBubbleComponent);
  }

  it('renders an <img> with the resolved src and alt for an image', () => {
    const fixture = create();
    fixture.componentRef.setInput('kind', 'image');
    fixture.componentRef.setInput('src', 'blob:thumb');
    fixture.componentRef.setInput('filename', 'pic.png');
    fixture.detectChanges();

    const img = fixture.nativeElement.querySelector('img.media__img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('blob:thumb');
    expect(img.getAttribute('alt')).toBe('pic.png');
  });

  it('renders a download file-card for a file kind', () => {
    const fixture = create();
    fixture.componentRef.setInput('kind', 'file');
    fixture.componentRef.setInput('filename', 'report.pdf');
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector(
      '.media--file:not(.media--error)',
    );
    expect(card).toBeTruthy();
    expect(
      fixture.nativeElement.querySelector('.media__name').textContent,
    ).toContain('report.pdf');
  });

  it('reflects the render state via data-media-state', () => {
    const fixture = create();
    const host = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('kind', 'image');

    // No src yet → still loading.
    fixture.componentRef.setInput('src', null);
    fixture.detectChanges();
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

  it('emits openLightbox when the image is clicked', () => {
    const fixture = create();
    fixture.componentRef.setInput('kind', 'image');
    fixture.componentRef.setInput('src', 'blob:thumb');
    fixture.detectChanges();

    let opened = 0;
    fixture.componentInstance.openLightbox.subscribe(() => opened++);
    fixture.nativeElement.querySelector('.media--image').click();

    expect(opened).toBe(1);
  });

  it('emits download when the file-card is clicked', () => {
    const fixture = create();
    fixture.componentRef.setInput('kind', 'file');
    fixture.detectChanges();

    let downloaded = 0;
    fixture.componentInstance.download.subscribe(() => downloaded++);
    fixture.nativeElement.querySelector('.media--file').click();

    expect(downloaded).toBe(1);
  });

  it('renders a human-readable size in the file-card subtitle', () => {
    const fixture = create();
    fixture.componentRef.setInput('kind', 'file');
    fixture.componentRef.setInput('size', 1536); // 1.5 KB
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('.media__sub').textContent,
    ).toContain('1.5 KB');
  });

  it('shows the error file-card (download fallback) after the <img> fails to load', () => {
    const fixture = create();
    fixture.componentRef.setInput('kind', 'image');
    fixture.componentRef.setInput('src', 'blob:broken');
    fixture.detectChanges();

    fixture.nativeElement
      .querySelector('img.media__img')
      .dispatchEvent(new Event('error'));
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('data-media-state')).toBe('error');
    expect(host.querySelector('.media--error')).toBeTruthy();

    let downloaded = 0;
    fixture.componentInstance.download.subscribe(() => downloaded++);
    host.querySelector('.media--error').click();
    expect(downloaded).toBe(1);
  });
});
