import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  input,
  output,
  signal,
  type WritableSignal,
} from '@angular/core';
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
import {
  MediaService,
  RecentEmojiService,
  type ImagePack,
} from '@trinity/data-access/media';
import {
  ComposerExpressionTabPreference,
  type ComposerExpressionTab,
} from '@trinity/data-access/timeline';
import {
  TrnTabsImports,
  type TrnEmojiPick,
} from '@trinity/components/controls';
import {
  TrnAnchoredOverlayDirective,
  TrnOverlaySurfaceDirective,
} from '@trinity/components/overlay';
import { GifPickerComponent } from '../gif-picker/gif-picker.component';
import { AddImagesTileComponent } from '../shared/add-images-tile/add-images-tile.component';
import { AddToMyEmojiService } from '../shared/add-to-my-emoji.service';
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
  readonly autoFocusSearch = input(false);
  readonly framed = input(true);
  readonly layout = input<'fixed' | 'fill'>('fixed');
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly shown = input(0);
  readonly recent = input<readonly string[] | undefined>(undefined);
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
  readonly presentation?: 'popover' | 'sheet';
  /** The anchored layer's show count, for a panel that layer keeps between opens. */
  readonly shown?: WritableSignal<number>;
  /** Provide a host that can add images to the personal pack. */
  readonly addImages?: boolean;
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
  const record = vi.fn();
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
        AddImagesTileComponent,
        GifPickerComponent,
        NgTemplateOutlet,
        StickerPickerComponent,
        EmojiPickerStubComponent,
        TrnOverlaySurfaceDirective,
        TrnTabsImports,
      ],
    },
  });
  const result = await render(ExpressionPickerComponent, {
    inputs: {
      panelId: 'expressions-1',
      gifEnabled: options.gifEnabled ?? true,
      stickerEnabled: options.stickerEnabled ?? true,
      stickerPacks: options.stickerPacks ?? [stickerPack],
      presentation: options.presentation ?? 'popover',
    },
    on: handlers,
    providers: [
      ...(options.addImages
        ? [
            {
              provide: AddToMyEmojiService,
              useValue: { available: signal(true), addFiles: vi.fn() },
            },
          ]
        : []),
      ...(options.shown
        ? [
            {
              provide: TrnAnchoredOverlayDirective,
              useValue: { shown: options.shown.asReadonly() },
            },
          ]
        : []),
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
      MockProvider(RecentEmojiService, {
        recent: signal(['🎉', '👍']).asReadonly(),
        run: () => of(undefined),
        record,
      }),
    ],
  });
  await result.fixture.whenStable();
  view = result;
  return { ...result, remember, handlers, record };
}

const expressionContent = () =>
  view.container.querySelector<HTMLElement>('[data-expression-content]')!;

const tabNames = () =>
  view.queryAllByRole('tab').map((tab) => tab.textContent?.trim());

/** Every overlay surface drawn inside the panel: the recipe stamps `data-trn-layout`. */
const surfaces = () =>
  Array.from(view.container.querySelectorAll<HTMLElement>('[data-trn-layout]'));

const emojiPicker = (
  fixture: RenderResult<ExpressionPickerComponent>['fixture'],
) =>
  fixture.debugElement.query((el) => el.name === 'trn-emoji-picker')
    .componentInstance as EmojiPickerStubComponent;

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

  describe('kept by its layer between opens (#1320)', () => {
    async function reopen(
      fixture: RenderResult<ExpressionPickerComponent>['fixture'],
      shown: WritableSignal<number>,
    ) {
      (document.activeElement as HTMLElement | null)?.blur();
      shown.update((count) => count + 1);
      TestBed.tick();
      await fixture.whenStable();
    }

    it.each([
      ['GIFs', 'gif', 'gif-search'],
      ['Stickers', 'sticker', 'sticker-search'],
    ] as const)(
      'focuses the %s search again on a reopen',
      async (_, tab, search) => {
        const shown = signal(1);
        const { fixture } = await renderPanel({ remembered: tab, shown });

        await reopen(fixture, shown);

        // The picker focused it when it was created; a kept one is not created again.
        expect(document.activeElement).toBe(view.getByTestId(search));
      },
    );

    it('opens on the remembered tab again, like a new panel', async () => {
      const shown = signal(1);
      const { fixture } = await renderPanel({ remembered: 'gif', shown });
      view.getByRole('tab', { name: 'Stickers' }).click();
      await fixture.whenStable();
      // Another panel (the phone's sheet) chose Emoji meanwhile.
      TestBed.inject(ComposerExpressionTabPreference).remember('emoji');

      await reopen(fixture, shown);

      expect(view.getByRole('tab', { name: 'Emoji' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('tells the emoji grid it was shown again', async () => {
      const shown = signal(1);
      const { fixture } = await renderPanel({ shown });

      await reopen(fixture, shown);

      expect(emojiPicker(fixture).shown()).toBe(2);
    });
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

  it('points each tab at its own panel, and shows only the selected one', async () => {
    await renderPanel();

    for (const name of ['GIFs', 'Stickers', 'Emoji']) {
      const tab = view.getByRole('tab', { name });
      const panel = document.getElementById(
        tab.getAttribute('aria-controls') ?? '',
      );
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    }
    expect(view.getByRole('tabpanel')).toHaveAccessibleName('Emoji');
  });

  it("leaves the panels out of the tab order: each picker's own controls take focus", async () => {
    await renderPanel();

    for (const panel of view.container.querySelectorAll('[role=tabpanel]')) {
      expect(panel).not.toHaveAttribute('tabindex');
    }
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

  it('the picker lists Your emoji first, then an Add tile', async () => {
    await renderPanel({ addImages: true });

    const section = view.getByRole('region', { name: 'Your emoji' });
    expect(
      section.compareDocumentPosition(view.getByTestId('emoji-picker')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      [...section.querySelectorAll('button')].map((b) =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual(['Add images']);
  });

  it('shows no Your emoji section where images cannot be added', async () => {
    await renderPanel();

    expect(view.queryByRole('region', { name: 'Your emoji' })).toBeNull();
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

  it("gives the emoji grid the account's recent emoji", async () => {
    const { fixture } = await renderPanel();

    expect(emojiPicker(fixture).recent()).toEqual(['🎉', '👍']);
  });

  it('records an emoji pick for the account', async () => {
    const { fixture, record } = await renderPanel();

    fixture.debugElement
      .query((el) => el.name === 'trn-emoji-picker')
      .triggerEventHandler('picked', {
        native: '😎',
        id: 'sunglasses',
        colons: ':sunglasses:',
      });

    expect(record).toHaveBeenCalledWith('😎');
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

  it('selects the focused tab with Enter and with Space', async () => {
    const { fixture, remember } = await renderPanel();
    const tab = (name: string) => view.getByRole('tab', { name });

    tab('Emoji').focus();
    fireEvent.keyDown(tab('Emoji'), { key: 'ArrowRight' });
    fireEvent.keyDown(tab('GIFs'), { key: 'Enter' });
    await fixture.whenStable();
    expect(tab('GIFs')).toHaveAttribute('aria-selected', 'true');

    tab('Stickers').focus();
    fireEvent.keyDown(tab('GIFs'), { key: 'ArrowRight' });
    fireEvent.keyDown(tab('Stickers'), { key: ' ' });
    await fixture.whenStable();
    expect(tab('Stickers')).toHaveAttribute('aria-selected', 'true');
    expect(remember.mock.calls.map(([chosen]) => chosen)).toEqual([
      'gif',
      'sticker',
    ]);
  });

  it('gives the single tab stop back to the selected tab once focus leaves the tab row', async () => {
    // Shift+Tab from a picker's search field lands on the one tab with tabindex 0, so that
    // has to be the selected tab again, not the one the arrows last visited.
    const { fixture } = await renderPanel();
    const emoji = view.getByRole('tab', { name: 'Emoji' });
    emoji.focus();
    fireEvent.keyDown(emoji, { key: 'ArrowRight' });
    await fixture.whenStable();
    const gifs = view.getByRole('tab', { name: 'GIFs' });
    expect(gifs).toHaveAttribute('tabindex', '0');

    fireEvent.focusOut(gifs, { relatedTarget: document.body });
    await fixture.whenStable();

    expect(emoji).toHaveAttribute('tabindex', '0');
    expect(gifs).toHaveAttribute('tabindex', '-1');
  });

  it('keeps one content element whichever tab shows, so its inset and scrolling stay', async () => {
    const { fixture } = await renderPanel();
    const content = view.container.querySelector('[data-expression-content]');

    view.getByRole('tab', { name: 'GIFs' }).click();
    await fixture.whenStable();

    expect(view.container.querySelector('[data-expression-content]')).toBe(
      content,
    );
    expect(content).toContainElement(view.getByRole('tabpanel'));
    expect(view.getByRole('tabpanel')).toHaveAccessibleName('GIFs');
  });

  it("names the tab row by what it chooses, not with the trigger's name", async () => {
    await renderPanel();

    expect(view.getByRole('tablist')).toHaveAttribute(
      'aria-label',
      'Picker type',
    );
  });

  it("is the emoji picker's width, in rem and clamped to the viewport, as a popover", async () => {
    const { fixture } = await renderPanel();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.style.width).toBe('calc(18.875rem)'); // 302rem / 16
    expect(host.style.maxWidth).toBe('calc(100vw - 1rem)');
  });

  it('fills the sheet that holds it', async () => {
    const { fixture } = await renderPanel({ presentation: 'sheet' });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.style.width).toBe('100%');
    expect(host.getAttribute('data-presentation')).toBe('sheet');
  });

  it('leaves Escape to the sheet that holds it', async () => {
    const { handlers } = await renderPanel({ presentation: 'sheet' });

    fireEvent.keyDown(view.getByRole('tab', { name: 'Emoji' }), {
      key: 'Escape',
    });

    expect(handlers.dismiss).not.toHaveBeenCalled();
  });

  it('has no close button in a sheet: the tab row holds only the tabs', async () => {
    await renderPanel({ presentation: 'sheet' });
    const tablist = view.getByRole('tablist');

    // The sheet closes by its handle, its backdrop, Escape or a pick.
    expect(view.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(
      view.container.querySelector('[data-testid=dialog-close]'),
    ).toBeNull();
    // The row is the tablist itself, and it holds the tabs and nothing else.
    expect(tablist.nextElementSibling).toHaveAttribute(
      'data-expression-content',
    );
    expect(
      Array.from(tablist.querySelectorAll('button')).every(
        (button) => button.getAttribute('role') === 'tab',
      ),
    ).toBe(true);
  });

  it('goes straight to the emoji grid in a sheet when Emoji is the only tab', async () => {
    await renderPanel({
      presentation: 'sheet',
      gifEnabled: false,
      stickerEnabled: false,
    });

    expect(view.queryByRole('tablist')).toBeNull();
    expect(view.queryByRole('button', { name: 'Close' })).toBeNull();
    // No empty top row: the content is the first box drawn; the tabs element draws none.
    const tabs = view.fixture.nativeElement.firstElementChild as HTMLElement;
    expect(tabs).toHaveClass('contents');
    expect(tabs.firstElementChild).toHaveAttribute('data-expression-content');
    expect(view.queryByRole('tabpanel')).toBeNull();
  });

  it('keeps the emoji grid, with its search, when more tabs become available', async () => {
    const { fixture } = await renderPanel({
      gifEnabled: false,
      stickerEnabled: false,
    });
    const grid = emojiPicker(fixture);

    fixture.componentRef.setInput('gifEnabled', true);
    await fixture.whenStable();

    expect(view.getByRole('tablist')).toBeInTheDocument();
    expect(emojiPicker(fixture)).toBe(grid);
    expect(view.getByRole('tabpanel')).toHaveAccessibleName('Emoji');
  });

  it('has no close button of its own as a popover', async () => {
    await renderPanel();

    expect(view.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it("asks the sheet's emoji picker to take focus into its search once loaded", async () => {
    const { fixture } = await renderPanel({ presentation: 'sheet' });
    const picker = fixture.debugElement.query(
      (el) => el.name === 'trn-emoji-picker',
    );

    expect(
      (picker.componentInstance as EmojiPickerStubComponent).autoFocusSearch(),
    ).toBe(true);
  });

  it("leaves the anchored emoji picker's focus alone", async () => {
    const { fixture } = await renderPanel();
    const picker = fixture.debugElement.query(
      (el) => el.name === 'trn-emoji-picker',
    );

    expect(
      (picker.componentInstance as EmojiPickerStubComponent).autoFocusSearch(),
    ).toBe(false);
  });

  it('is one card as a popover: the tabs are its header and the picker sits inside it', async () => {
    await renderPanel();
    const [card, ...others] = surfaces();

    expect(others).toEqual([]);
    expect(card).toHaveAttribute('data-trn-layout', 'popover');
    expect(card).toContainElement(view.getByRole('tablist'));
    expect(card).toContainElement(view.getByRole('tabpanel'));
  });

  it('stays one card whichever tab shows', async () => {
    await renderPanel();

    for (const name of ['GIFs', 'Stickers', 'Emoji']) {
      view.getByRole('tab', { name }).click();
      view.fixture.detectChanges();
      await view.fixture.whenStable();

      expect(surfaces()).toHaveLength(1);
    }
  });

  it('is one card around the emoji grid when Emoji is the only tab', async () => {
    await renderPanel({ gifEnabled: false, stickerEnabled: false });
    const [card, ...others] = surfaces();

    expect(others).toEqual([]);
    expect(card).toContainElement(view.getByTestId('emoji-picker'));
  });

  it('draws no card in a sheet, where the sheet is the only surface', async () => {
    await renderPanel({ presentation: 'sheet', remembered: 'gif' });

    expect(view.getByTestId('gif-search')).toBeInTheDocument();
    expect(surfaces()).toEqual([]);
  });

  it('embeds the emoji grid in the card without a frame of its own', async () => {
    const { fixture } = await renderPanel();

    expect(emojiPicker(fixture).framed()).toBe(false);
  });

  it('embeds the emoji grid in a sheet without a frame of its own', async () => {
    const { fixture } = await renderPanel({ presentation: 'sheet' });

    expect(emojiPicker(fixture).framed()).toBe(false);
  });

  it("fills the sheet's width with the emoji grid, at the touch glyph size", async () => {
    const { fixture } = await renderPanel({ presentation: 'sheet' });
    const picker = emojiPicker(fixture);

    expect(picker.layout()).toBe('fill');
    expect(picker.size()).toBe('lg');
  });

  it('fills the desktop card with the emoji grid too, at the desktop glyph size', async () => {
    // The card keeps one width across tabs; the grid's columns follow from it, so a real
    // scrollbar can never push the grid past the card.
    const { fixture } = await renderPanel();
    const picker = emojiPicker(fixture);

    expect(picker.layout()).toBe('fill');
    expect(picker.size()).toBe('md');
  });

  it('insets every tab by the same 12px in a sheet', async () => {
    await renderPanel({ presentation: 'sheet' });
    const content = expressionContent();

    for (const name of ['GIFs', 'Stickers', 'Emoji']) {
      view.getByRole('tab', { name }).click();
      view.fixture.detectChanges();
      await view.fixture.whenStable();

      expect(content.style.paddingInline).toBe('var(--trinity-space-4)');
    }
  });

  it('insets every tab by the same 8px in the desktop card', async () => {
    await renderPanel();
    const content = expressionContent();

    for (const name of ['GIFs', 'Stickers', 'Emoji']) {
      view.getByRole('tab', { name }).click();
      view.fixture.detectChanges();
      await view.fixture.whenStable();

      expect(content.style.paddingInline).toBe('var(--trinity-space-3)');
    }
  });

  it('lines the tab row up with the content in the card', async () => {
    await renderPanel();

    expect(view.getByRole('tablist').style.paddingInline).toBe(
      'var(--trinity-space-3)',
    );
  });

  it('lines the tab row up with the content in a sheet', async () => {
    await renderPanel({ presentation: 'sheet' });

    expect(view.getByRole('tablist').style.paddingInline).toBe(
      'var(--trinity-space-4)',
    );
  });

  it('scrolls its content inside the card rather than cutting it off on a short window', async () => {
    await renderPanel();
    const content = expressionContent();

    expect(content).toHaveClass('min-h-0');
    expect(content).toHaveClass('overflow-y-auto');
  });
});
