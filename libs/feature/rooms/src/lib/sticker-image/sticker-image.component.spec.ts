import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MediaService } from '@trinity/data-access/media';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { StickerImageComponent } from './sticker-image.component';

describe('StickerImageComponent', () => {
  it('resolves and labels a pack image without adding another button', async () => {
    await TestBed.configureTestingModule({
      imports: [StickerImageComponent],
      providers: [
        {
          provide: MediaService,
          useValue: {
            resolveMedia: vi.fn(() => of('blob:party')),
            pin: vi.fn(),
            unpin: vi.fn(),
          },
        },
      ],
    }).compileComponents();
    const fixture: ComponentFixture<StickerImageComponent> =
      TestBed.createComponent(StickerImageComponent);
    fixture.componentRef.setInput('image', {
      shortcode: 'party',
      url: 'mxc://hs/party',
      body: 'Party pixel',
      mimetype: 'image/png',
      width: 32,
      height: 32,
      usage: ['sticker'],
      packId: '!pack:hs:fun',
      packName: 'Fun',
    });
    fixture.detectChanges();

    const image = fixture.nativeElement.querySelector('img');
    expect(image?.getAttribute('alt')).toBe('Party pixel');
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });
});
