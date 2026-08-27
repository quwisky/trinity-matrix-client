import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MediaService } from '@trinity/data-access/media';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StickerPickerComponent } from './sticker-picker.component';

describe('StickerPickerComponent', () => {
  let fixture: ComponentFixture<StickerPickerComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StickerPickerComponent],
      providers: [
        {
          provide: MediaService,
          useValue: {
            resolveMedia: vi.fn(() => of('blob:sticker')),
            pin: vi.fn(),
            unpin: vi.fn(),
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(StickerPickerComponent);
    fixture.componentRef.setInput('packs', [
      {
        id: '!pack:hs:fun',
        roomId: '!pack:hs',
        stateKey: 'fun',
        name: 'Fun',
        attribution: 'Made by Alice',
        images: [
          {
            shortcode: 'party',
            url: 'mxc://hs/party',
            body: 'Party parrot',
            mimetype: 'image/png',
            width: 32,
            height: 32,
            usage: ['sticker'],
            packId: '!pack:hs:fun',
            packName: 'Fun',
          },
        ],
      },
    ]);
    fixture.detectChanges();
  });

  it('renders labelled native buttons and emits the chosen sticker', () => {
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    const button = fixture.nativeElement.querySelector(
      '[data-testid="sticker-party"]',
    ) as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toContain('Party parrot');
    button.click();
    expect(selected).toHaveBeenCalledWith(
      expect.objectContaining({ shortcode: 'party' }),
    );
  });

  it('filters by shortcode or body and shows an empty state', () => {
    const search = fixture.nativeElement.querySelector(
      '[data-testid="sticker-search"]',
    ) as HTMLInputElement;
    search.value = 'missing';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No stickers found.');
  });
});
