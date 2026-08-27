import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MediaService } from '@trinity/data-access/media';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StickerPickerComponent } from './sticker-picker.component';

describe('StickerPickerComponent', () => {
  let fixture: ComponentFixture<StickerPickerComponent>;

  afterEach(() => vi.unstubAllGlobals());

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
            info: { mimetype: 'image/png', w: 32, h: 32 },
            usage: ['sticker'],
            packId: '!pack:hs:fun',
            packName: 'Fun',
          },
        ],
      },
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
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
    expect(fixture.nativeElement.querySelector('input')).toBe(
      document.activeElement,
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
    expect(
      fixture.nativeElement
        .querySelector('.picker__empty')
        .getAttribute('role'),
    ).toBe('status');
  });

  it('does not resolve every entry in a large offscreen pack', async () => {
    fixture.destroy();
    TestBed.resetTestingModule();
    class TestIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '160px 0px';
      readonly scrollMargin = '0px';
      readonly thresholds = [0];
      constructor(_callback: IntersectionObserverCallback) {}
      disconnect(): void {}
      observe(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      unobserve(): void {}
    }
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    const resolveMedia = vi.fn(() => of('blob:sticker'));
    await TestBed.configureTestingModule({
      imports: [StickerPickerComponent],
      providers: [
        {
          provide: MediaService,
          useValue: {
            resolveMedia,
            pin: vi.fn(),
            unpin: vi.fn(),
          },
        },
      ],
    }).compileComponents();
    const large = TestBed.createComponent(StickerPickerComponent);
    large.componentRef.setInput('packs', [
      {
        id: '!pack:hs:large',
        roomId: '!pack:hs',
        stateKey: 'large',
        name: 'Large',
        attribution: null,
        images: Array.from({ length: 500 }, (_, index) => ({
          shortcode: `sticker-${index}`,
          url: `mxc://hs/${index}`,
          body: `Sticker ${index}`,
          mimetype: 'image/png',
          width: 32,
          height: 32,
          info: { mimetype: 'image/png', w: 32, h: 32 },
          usage: ['sticker'] as const,
          packId: '!pack:hs:large',
          packName: 'Large',
        })),
      },
    ]);

    large.detectChanges();
    await large.whenStable();

    expect(resolveMedia).not.toHaveBeenCalled();
    large.destroy();
  });
});
