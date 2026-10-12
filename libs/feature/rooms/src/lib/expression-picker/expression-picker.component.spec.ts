import { Component, input, output, signal } from '@angular/core';
import { render, fireEvent, type RenderResult } from '@trinity/testing';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  GifService,
  GifSettingsService,
  type GifProviderId,
} from '@trinity/data-access/gif';
import { MediaService, type ImagePack } from '@trinity/data-access/media';
import {
  ComposerExpressionTabPreference,
  type ComposerExpressionTab,
} from '@trinity/data-access/timeline';
import { type TrnEmojiPick } from '@trinity/components/controls';
import { GifPickerComponent } from '../gif-picker/gif-picker.component';
import { StickerPickerComponent } from '../sticker-picker/sticker-picker.component';
import { ExpressionPickerComponent } from './expression-picker.component';

/**
 * Stands in for the kit's emoji picker, whose vendor chunk (about 1 MB) loads behind `@defer`
 * and is covered by its own spec and the composer's. Same selector, inputs and output.
 */
@Component({
  selector: 'trn-emoji-picker',
  template: '',
  host: { 'data-testid': 'emoji-picker', '[attr.id]': 'pickerId()' },
})
class EmojiPickerStubComponent {
  readonly pickerId = input<string | null>(null);
  readonly picked = output<TrnEmojiPick>();
}

const stickerPack: ImagePack = {
  id: '!pack:hs:fun',
  roomId: '!pack:hs',
  stateKey: 'fun',
  name: 'Fun',
  attribution: null,
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
};

const gifResult = {
  id: 'g1',
  description: 'Happy Cat',
  previewUrl: 'https://x/tiny',
  previewWidth: 1,
  previewHeight: 1,
  url: 'https://x/gif',
  width: 2,
  height: 2,
};

interface Options {
  readonly gifEnabled?: boolean;
  readonly stickerEnabled?: boolean;
  readonly stickerPacks?: readonly ImagePack[];
  readonly remembered?: ComposerExpressionTab;
}

/** The latest render; queries stay inside its container, since earlier renders are not torn down. */
let view: RenderResult<ExpressionPickerComponent>;

async function renderPanel(options: Options = {}) {
  const remembered = signal<ComposerExpressionTab>(
    options.remembered ?? 'emoji',
  );
  const remember = vi.fn((tab: ComposerExpressionTab) => {
    remembered.set(tab);
    return of({ kind: 'completed' as const });
  });
  const handlers = {
    emojiPick: vi.fn(),
    gifSelect: vi.fn(),
    stickerSelect: vi.fn(),
    dismiss: vi.fn(),
    manage: vi.fn(),
  };
  TestBed.overrideComponent(ExpressionPickerComponent, {
    set: {
      imports: [
        GifPickerComponent,
        StickerPickerComponent,
        EmojiPickerStubComponent,
      ],
    },
  });
  const result = await render(ExpressionPickerComponent, {
    inputs: {
      panelId: 'expressions-1',
      gifEnabled: options.gifEnabled ?? true,
      stickerEnabled: options.stickerEnabled ?? true,
      stickerPacks: options.stickerPacks ?? [stickerPack],
    },
    on: handlers,
    providers: [
      MockProvider(ComposerExpressionTabPreference, {
        tab: remembered.asReadonly(),
        remember,
      }),
      MockProvider(GifSettingsService, {
        provider: signal<GifProviderId>('klipy').asReadonly(),
        configured: signal(true).asReadonly(),
      }),
      MockProvider(GifService, {
        search: vi.fn(() => of([gifResult])),
        fetchPreview: vi.fn(() => of('blob:gif')),
      }),
      MockProvider(MediaService, {
        resolveMedia: vi.fn(() => of('blob:sticker')),
        pin: vi.fn(),
        unpin: vi.fn(),
      }),
    ],
  });
  await result.fixture.whenStable();
  view = result;
  return { ...result, remember, handlers };
}

const tabNames = () =>
  view.queryAllByRole('tab').map((tab) => tab.textContent?.trim());

describe('ExpressionPickerComponent', () => {
  it('offers GIFs, Stickers and Emoji in that order and opens on Emoji the first time', async () => {
    await renderPanel();

    expect(tabNames()).toEqual(['GIFs', 'Stickers', 'Emoji']);
    expect(view.getByRole('tab', { name: 'Emoji' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(view.getByTestId('emoji-picker')).toBeInTheDocument();
  });

  it('hides GIFs when no GIF provider is configured', async () => {
    await renderPanel({ gifEnabled: false });

    expect(tabNames()).toEqual(['Stickers', 'Emoji']);
  });

  it('hides Stickers when the room has no sticker packs', async () => {
    await renderPanel({ stickerEnabled: false, stickerPacks: [] });

    expect(tabNames()).toEqual(['GIFs', 'Emoji']);
  });

  it('renders no tab bar when only Emoji is left', async () => {
    await renderPanel({ gifEnabled: false, stickerEnabled: false });

    expect(view.queryByRole('tablist')).toBeNull();
    expect(view.getByTestId('emoji-picker')).toBeInTheDocument();
  });

  it('opens on the tab this device used last', async () => {
    await renderPanel({ remembered: 'gif' });

    expect(view.getByRole('tab', { name: 'GIFs' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(view.getByTestId('gif-search')).toBeInTheDocument();
  });

  it('falls back to Emoji when the remembered tab is unavailable', async () => {
    await renderPanel({ remembered: 'sticker', stickerEnabled: false });

    expect(view.getByRole('tab', { name: 'Emoji' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(view.queryByTestId('sticker-picker')).toBeNull();
  });

  it('shows the chosen tab and remembers it for this device', async () => {
    const { fixture, remember } = await renderPanel();

    view.getByRole('tab', { name: 'Stickers' }).click();
    await fixture.whenStable();

    const stickers = view.getByRole('tab', { name: 'Stickers' });
    expect(stickers).toHaveAttribute('aria-selected', 'true');
    expect(view.getByRole('tab', { name: 'Emoji' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(remember).toHaveBeenCalledWith('sticker');
    expect(view.getByTestId('sticker-picker')).toBeInTheDocument();
    expect(view.queryByTestId('emoji-picker')).toBeNull();
  });

  it('points the selected tab at the panel it shows, and only that tab', async () => {
    await renderPanel();

    const emoji = view.getByRole('tab', { name: 'Emoji' });
    const controls = emoji.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const panel = document.getElementById(controls ?? '');
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', emoji.id);
    expect(
      view.getByRole('tab', { name: 'GIFs' }).getAttribute('aria-controls'),
    ).toBeNull();
  });

  it('moves focus between tabs with the arrow keys, Home and End, keeping one tab stop', async () => {
    const { fixture } = await renderPanel();
    const [gifs, stickers, emoji] = view.getAllByRole('tab');
    const tabStops = () =>
      view
        .getAllByRole('tab')
        .filter((tab) => tab.getAttribute('tabindex') === '0');
    const press = async (target: HTMLElement, key: string) => {
      fireEvent.keyDown(target, { key });
      await fixture.whenStable();
    };

    expect(tabStops()).toEqual([emoji]);
    emoji.focus();

    await press(emoji, 'ArrowRight');
    expect(gifs).toHaveFocus();
    await press(gifs, 'ArrowLeft');
    expect(emoji).toHaveFocus();
    await press(emoji, 'Home');
    expect(gifs).toHaveFocus();
    await press(gifs, 'End');
    expect(emoji).toHaveFocus();
    await press(emoji, 'ArrowLeft');
    expect(stickers).toHaveFocus();
    expect(tabStops()).toEqual([stickers]);
    // Manual activation: moving focus does not switch the panel, because each picker takes
    // focus into its own search field when it appears.
    expect(emoji).toHaveAttribute('aria-selected', 'true');
  });

  it('forwards an emoji pick', async () => {
    const { fixture, handlers } = await renderPanel();
    const panel = fixture.debugElement.query(
      (el) => el.name === 'trn-emoji-picker',
    );

    panel.triggerEventHandler('picked', {
      native: '😎',
      id: 'sunglasses',
      colons: ':sunglasses:',
    });

    expect(handlers.emojiPick).toHaveBeenCalledWith(
      expect.objectContaining({ native: '😎' }),
    );
  });

  it('forwards a GIF pick', async () => {
    const { fixture, handlers } = await renderPanel({ remembered: 'gif' });
    await fixture.whenStable();

    (await view.findAllByTestId('gif-result'))[0]?.click();

    expect(handlers.gifSelect).toHaveBeenCalledWith(gifResult);
  });

  it('forwards a sticker pick and the manage action', async () => {
    const { handlers } = await renderPanel({ remembered: 'sticker' });

    view.getByTestId('sticker-party').click();
    view.getByTestId('manage-image-packs').click();

    expect(handlers.stickerSelect).toHaveBeenCalledWith(
      expect.objectContaining({ shortcode: 'party' }),
    );
    expect(handlers.manage).toHaveBeenCalledTimes(1);
  });

  it('asks to be dismissed on Escape from anywhere inside it', async () => {
    const { handlers } = await renderPanel();

    fireEvent.keyDown(view.getByRole('tab', { name: 'Emoji' }), {
      key: 'Escape',
    });

    expect(handlers.dismiss).toHaveBeenCalledTimes(1);
  });
});
