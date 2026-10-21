import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  MediaService,
  PERSONAL_IMAGE_PACK_ID,
  type ImagePack,
} from '@trinity/data-access/media';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddToMyEmojiService } from '../shared/add-to-my-emoji.service';
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
        scope: { emoticon: null, sticker: 'account' },
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

  it('renders labelled buttons with visible shortcodes and emits the chosen sticker', () => {
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    const button = fixture.nativeElement.querySelector(
      '[data-testid="sticker-party"]',
    ) as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toContain('Party parrot');
    expect(button.querySelector('.picker__shortcode')?.textContent).toContain(
      ':party:',
    );
    button.click();
    expect(selected).toHaveBeenCalledWith(
      expect.objectContaining({ shortcode: 'party' }),
    );
    expect(fixture.nativeElement.querySelector('input')).toBe(
      document.activeElement,
    );
  });

  it('draws no surface of its own, so the expression panel holding it is the one card', () => {
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('[data-trn-layout]')).toBeNull();
    expect(host.querySelector('[data-testid="sticker-picker"]')).not.toBeNull();
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
        .querySelector('trn-empty-state')
        .getAttribute('role'),
    ).toBe('status');
  });

  it('offers pack management as a separate presentational action', () => {
    const manage = vi.fn();
    fixture.componentInstance.manage.subscribe(manage);

    (
      fixture.nativeElement.querySelector(
        '[data-testid="manage-image-packs"]',
      ) as HTMLButtonElement
    ).click();

    expect(manage).toHaveBeenCalledOnce();
  });

  it('labels whether a sticker pack is available account-wide or only here', async () => {
    expect(fixture.nativeElement.textContent).toContain('All rooms');
    const pack = fixture.nativeElement.querySelector(
      '[data-testid="sticker-pack"]',
    ) as HTMLElement;
    expect(pack.getAttribute('aria-describedby')).toBe('sticker-pack-scope-0');

    fixture.componentRef.setInput('packs', [
      {
        ...fixture.componentInstance.packs()[0],
        scope: { emoticon: null, sticker: 'room' },
      },
    ]);
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('This room');
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
        scope: { emoticon: null, sticker: 'account' },
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

describe('StickerPickerComponent with your emoji', () => {
  const adder = { available: signal(true), addFiles: vi.fn() };
  const image = (shortcode: string, packId: string, packName: string) => ({
    shortcode,
    url: `mxc://hs/${shortcode}`,
    body: '',
    mimetype: 'image/png',
    width: 32,
    height: 32,
    info: {},
    usage: ['sticker'] as const,
    packId,
    packName,
  });
  const pack = (id: string, name: string, shortcodes: string[]) => ({
    id,
    roomId: '',
    stateKey: '',
    name,
    attribution: null,
    scope: { emoticon: null, sticker: 'account' as const },
    images: shortcodes.map((code) => image(code, id, name)),
  });

  async function setup(packs: unknown[]) {
    adder.addFiles.mockReset();
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
        { provide: AddToMyEmojiService, useValue: adder },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(StickerPickerComponent);
    fixture.componentRef.setInput('packs', packs);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('the picker lists Your stickers first, then an Add tile', async () => {
    const host = await setup([
      pack(PERSONAL_IMAGE_PACK_ID, 'Your emoji', ['fox']),
      pack('!r:hs:fun', 'Fun', ['party']),
    ]);

    const headings = [...host.querySelectorAll('h3')].map((h) =>
      h.textContent?.trim(),
    );
    expect(headings).toEqual(['Your stickers', 'Fun']);
    const first = host.querySelector('[data-testid="sticker-pack"]')!;
    const tiles = [...first.querySelectorAll('button')];
    expect(tiles.map((b) => b.getAttribute('aria-label'))).toEqual([
      'fox (:fox:)',
      'Add images',
    ]);
  });

  /** An emoji-only personal pack, in the shape the reader builds it. */
  const emojiOnly: ImagePack = {
    id: PERSONAL_IMAGE_PACK_ID,
    roomId: '',
    stateKey: '',
    name: 'Your emoji',
    attribution: null,
    scope: { emoticon: 'account', sticker: null },
    images: [
      {
        ...image('wave', PERSONAL_IMAGE_PACK_ID, 'Your emoji'),
        usage: ['emoticon'],
      },
    ],
  };

  it('offers only the Add tile under Your stickers for an emoji-only pack, in all rooms', async () => {
    const host = await setup([emojiOnly, pack('!r:hs:fun', 'Fun', ['party'])]);

    const first = host.querySelector('[data-testid="sticker-pack"]')!;
    expect(first.querySelector('h3')?.textContent?.trim()).toBe(
      'Your stickers',
    );
    expect(
      first.querySelector('[data-testid="sticker-pack-scope"]')?.textContent,
    ).toContain('All rooms');
    expect(
      [...first.querySelectorAll('button')].map((b) =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual(['Add images']);
  });

  it('leaves an emoji-only pack out where images cannot be added', async () => {
    adder.available.set(false);
    try {
      const host = await setup([
        emojiOnly,
        pack('!r:hs:fun', 'Fun', ['party']),
      ]);

      expect(
        [...host.querySelectorAll('h3')].map((h) => h.textContent?.trim()),
      ).toEqual(['Fun']);
    } finally {
      adder.available.set(true);
    }
  });

  it('keeps Your stickers with its Add tile while the pack has no stickers', async () => {
    const host = await setup([pack('!r:hs:fun', 'Fun', ['party'])]);

    expect(host.querySelector('h3')?.textContent?.trim()).toBe('Your stickers');
    expect(host.querySelector('[aria-label="Add images"]')).not.toBeNull();
  });

  it('Add opens the file chooser, then the dialog', async () => {
    const host = await setup([]);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const choose = vi.spyOn(input, 'click').mockImplementation(() => undefined);

    host.querySelector<HTMLButtonElement>('[aria-label="Add images"]')!.click();
    expect(choose).toHaveBeenCalledOnce();
    expect(input.accept).toBe('image/png,image/jpeg,image/webp,image/gif');
    expect(input.multiple).toBe(true);

    const fox = new File(['a'], 'fox.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [fox], configurable: true });
    input.dispatchEvent(new Event('change'));

    expect(adder.addFiles).toHaveBeenCalledWith([fox]);
    expect(input.value).toBe('');
  });

  it('offers no Add tile where images cannot be added', async () => {
    adder.available.set(false);
    try {
      const host = await setup([pack('!r:hs:fun', 'Fun', ['party'])]);

      expect(host.querySelector('[aria-label="Add images"]')).toBeNull();
      expect(
        [...host.querySelectorAll('h3')].map((h) => h.textContent?.trim()),
      ).toEqual(['Fun']);
    } finally {
      adder.available.set(true);
    }
  });
});
