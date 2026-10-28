import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { MediaService } from '@trinity/data-access/media';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { StickerImageComponent } from './sticker-image.component';

const IMAGE = {
  shortcode: 'party',
  url: 'mxc://hs/party',
  body: 'Party pixel',
  mimetype: 'image/png',
  width: 32,
  height: 32,
  info: { mimetype: 'image/png', w: 32, h: 32 },
  usage: ['sticker'],
  packId: '!pack:hs:fun',
  packName: 'Fun',
};

async function render() {
  const media = {
    resolveMedia: vi.fn(() => of('blob:party')),
    pin: vi.fn(),
    unpin: vi.fn(),
  };
  const activeAccountId = signal<string | null>('@alice:hs');
  await TestBed.configureTestingModule({
    imports: [StickerImageComponent],
    providers: [
      { provide: MediaService, useValue: media },
      { provide: SessionStateService, useValue: { activeAccountId } },
    ],
  }).compileComponents();
  const fixture: ComponentFixture<StickerImageComponent> =
    TestBed.createComponent(StickerImageComponent);
  fixture.componentRef.setInput('image', IMAGE);
  fixture.detectChanges();
  return { fixture, media, activeAccountId };
}

describe('StickerImageComponent', () => {
  it('resolves and labels a pack image without adding another button', async () => {
    const { fixture, media } = await render();

    const image = fixture.nativeElement.querySelector(
      'img',
    ) as HTMLImageElement;
    expect(image.getAttribute('alt')).toBe('Party pixel');
    expect(fixture.nativeElement.querySelector('button')).toBeNull();

    image.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(':party:');
    expect(media.unpin).toHaveBeenCalledWith('blob:party');
  });

  it('resolves again with the account that becomes active', async () => {
    const { fixture, media, activeAccountId } = await render();
    expect(media.resolveMedia).toHaveBeenLastCalledWith(
      expect.anything(),
      'thumbnail',
      '@alice:hs',
    );

    activeAccountId.set('@bob:hs');
    fixture.detectChanges();

    expect(media.resolveMedia).toHaveBeenCalledTimes(2);
    expect(media.resolveMedia).toHaveBeenLastCalledWith(
      expect.anything(),
      'thumbnail',
      '@bob:hs',
    );
  });
});
