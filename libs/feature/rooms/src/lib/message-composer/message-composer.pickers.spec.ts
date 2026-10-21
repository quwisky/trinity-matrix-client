import {
  gifProviders,
  gifResult,
  renderComposer,
  setMobilePlatform,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { ApplicationRef, signal, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NEVER, of, throwError } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { type BatchItem } from '../shared/send-media-batch';
import { MockProvider } from 'ng-mocks';
import { VoiceRecorderService } from '@trinity/platform-native';
import { GifService, GifSettingsService } from '@trinity/data-access/gif';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  ComposerExpressionTabPreference,
  TimelineActionsService,
  type ComposerExpressionTab,
} from '@trinity/data-access/timeline';
import { LocationShareService } from '../location-share/location-share.service';
import {
  MediaService,
  PERSONAL_IMAGE_PACK_ID,
  type ImagePack,
} from '@trinity/data-access/media';
import { CreatePollService } from '../poll/create-poll.service';
import { CreatePollDialogComponent } from '../poll/create-poll-dialog.component';
import {
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';

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

describe('MessageComposerComponent — the emoji picker, GIFs, the insert tray and voice', () => {
  beforeEach(() => stubObjectUrls());
  afterEach(() => {
    setMobilePlatform(false);
  });

  it('hands mobile Poll focus to the real poll dialog', async () => {
    setMobilePlatform(true);
    const { fixture, container } = await renderComposer({}, [
      MockProvider(CreatePollService, {
        open$: vi.fn(() => {
          TestBed.inject(TrnSurfaceService).open(CreatePollDialogComponent, {
            ariaLabel: 'Create poll',
            autoFocus: '[data-testid=poll-question]',
          });
          return of(void 0);
        }),
      }),
    ]);

    container
      .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
      ?.click();
    await fixture.whenStable();
    document
      .querySelector<HTMLButtonElement>('[data-testid=insert-poll]')
      ?.click();
    TestBed.inject(ApplicationRef).tick();
    await fixture.whenStable();

    expect(document.querySelector('[data-testid=poll-question]')).toBe(
      document.activeElement,
    );
  });

  it('toggles the emoji picker open and closed from the button', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const button = container.querySelector(
      '.composer__emoji',
    ) as HTMLButtonElement;

    expect(cmp.pickerOpen()).toBe(false);
    button.click(); // (don't detectChanges — avoids rendering the full picker)
    expect(cmp.pickerOpen()).toBe(true);
    button.click();
    expect(cmp.pickerOpen()).toBe(false);
  });

  it('inserts the emoji chosen from the picker at the cursor', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;

    cmp.text.set('ab');
    fixture.detectChanges();
    ta.selectionStart = ta.selectionEnd = 1; // cursor between a and b
    cmp.pickerOpen.set(true);

    cmp.onPickerSelect({
      native: '😎',
      id: 'sunglasses',
      colons: ':sunglasses:',
    });

    expect(cmp.text()).toBe('a😎b');
    expect(cmp.pickerOpen()).toBe(false);
  });

  it('does not render the emoji picker until it is opened, then shows a placeholder before it', async () => {
    // The picker pulls in the ~1 MB emoji-mart chunk, so it sits behind `@defer`: closed means
    // nothing rendered (and nothing loaded), and the first open holds the overlay's footprint
    // with a placeholder until the chunk arrives.
    const { fixture, container } = await renderComposer();
    const trigger = container.querySelector<HTMLElement>('.composer__emoji')!;
    const emojiPicker = () => document.querySelector('emoji-mart');
    const placeholder = () =>
      document.querySelector('[data-testid="emoji-picker-placeholder"]');

    expect(document.querySelector('trn-emoji-picker')).toBeNull();
    expect(placeholder()).toBeNull();

    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    TestBed.tick();

    expect(placeholder()).not.toBeNull();
    expect(emojiPicker()).toBeNull();

    await fixture.whenStable();

    expect(emojiPicker()).not.toBeNull();
    expect(placeholder()).toBeNull();
  });

  it('picking Your emoji inserts :code: at the cursor, spaced off a word so it converts', async () => {
    const personal: ImagePack = {
      ...stickerPack,
      id: PERSONAL_IMAGE_PACK_ID,
      images: [
        {
          ...stickerPack.images[0],
          shortcode: 'wave',
          url: 'mxc://hs/wave',
          usage: ['emoticon'],
          packId: PERSONAL_IMAGE_PACK_ID,
        },
      ],
    };
    const { fixture, container } = await renderComposer(
      { stickerPacks: [personal] },
      [
        MockProvider(MediaService, {
          resolveMedia: vi.fn(() => of('blob:wave')),
          pin: vi.fn(),
          unpin: vi.fn(),
        }),
      ],
    );
    const cmp = fixture.componentInstance;
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    const pickAt = (text: string, caret: number) => {
      cmp.text.set(text);
      fixture.detectChanges();
      ta.selectionStart = ta.selectionEnd = caret;
      cmp.pickerOpen.set(true);
      TestBed.tick();
      document
        .querySelector<HTMLButtonElement>('[aria-label=":wave:"]')
        ?.click();
      return cmp.text();
    };

    expect(pickAt('hi', 2)).toBe('hi :wave:');
    expect(cmp.pickerOpen()).toBe(false);
    expect(pickAt('ab', 1)).toBe('a :wave: b');
    expect(pickAt('hi ', 3)).toBe('hi :wave:');
  });

  it('closes the picker with the button that opened it', async () => {
    // The two halves meet here, and neither one alone is wrong. The trigger lives INSIDE the
    // row the picker is anchored to, so a press on it reaches CDK's outside-press dispatcher
    // as well as the button's own handler — and both write `pickerOpen`. Unexcluded, the
    // second click left the state saying open with nothing rendered and `aria-expanded="true"`
    // on a button controlling an element no longer in the document.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const trigger = container.querySelector<HTMLElement>('.composer__emoji')!;
    const clickTrigger = () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      TestBed.tick();
    };

    clickTrigger();
    expect(cmp.pickerOpen()).toBe(true);
    await fixture.whenStable();
    expect(document.querySelector('trn-emoji-picker')).not.toBeNull();

    clickTrigger();

    // Both, because the failure was them disagreeing.
    expect(cmp.pickerOpen()).toBe(false);
    expect(document.querySelector('trn-emoji-picker')).toBeNull();
  });

  describe('the panel kept between opens (#1320)', () => {
    // This device last used GIFs; the panel opens on the remembered tab.
    const gifs = () => [
      ...gifProviders(),
      MockProvider(GifService, { search: () => NEVER }),
      MockProvider(ComposerExpressionTabPreference, {
        tab: signal<ComposerExpressionTab>('gif').asReadonly(),
        remember: () => of({ kind: 'completed' as const }),
        restore: () => NEVER,
      }),
    ];
    const gifSearch = () =>
      document.querySelector<HTMLInputElement>('[data-testid=gif-search]');

    it('focuses the GIF search again when it reopens on GIFs', async () => {
      const { fixture } = await renderComposer({}, gifs());
      const cmp = fixture.componentInstance;
      cmp.pickerOpen.set(true);
      TestBed.tick();
      await fixture.whenStable();
      const search = gifSearch();
      expect(search).not.toBeNull();

      cmp.pickerOpen.set(false);
      TestBed.tick();
      search!.blur();
      cmp.pickerOpen.set(true);
      TestBed.tick();
      await fixture.whenStable();

      // The same field, kept, and focused again so typing goes into the search.
      expect(gifSearch()).toBe(search);
      expect(document.activeElement).toBe(search);
    });

    it('drops a search typed under one account when the composer moves to another', async () => {
      const { fixture } = await renderComposer({ accountId: '@a:hs' }, gifs());
      const cmp = fixture.componentInstance;
      cmp.pickerOpen.set(true);
      TestBed.tick();
      await fixture.whenStable();
      const search = gifSearch()!;
      search.value = 'cats';
      search.dispatchEvent(new Event('input'));
      cmp.pickerOpen.set(false);
      TestBed.tick();

      fixture.componentRef.setInput('accountId', '@b:hs');
      TestBed.tick();
      cmp.pickerOpen.set(true);
      TestBed.tick();
      await fixture.whenStable();

      expect(gifSearch()).not.toBe(search);
      expect(gifSearch()?.value).toBe('');
    });
  });

  it('points the emoji trigger at the panel that actually exists', async () => {
    // Two independent string literals — `pickerId` on the panel and `aria-controls` on the
    // trigger — with nothing tying them together. A typo in either leaves a button
    // referencing an id that is not in the document, which is silent: the attribute is
    // present, it just resolves to nothing. Same shape as the aria-describedby defect in
    // #153, which is why it is asserted rather than assumed.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const trigger = container.querySelector<HTMLElement>('.composer__emoji');

    // Closed: nothing to control, so no dangling reference.
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.getAttribute('aria-controls')).toBeNull();

    cmp.pickerOpen.set(true);
    fixture.detectChanges();

    const controls = trigger?.getAttribute('aria-controls');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(controls).toBeTruthy();
    // `document`, not the fixture: the picker renders in the CDK overlay container now. That
    // is also what `aria-controls` actually requires — an id resolvable in the document, not
    // one inside any particular subtree — so this is the more faithful assertion of the two.
    expect(document.querySelector(`#${controls}`)).not.toBeNull();
  });

  it('names the trigger for everything the panel holds', async () => {
    const { container } = await renderComposer();
    const trigger = container.querySelector<HTMLElement>('.composer__emoji');

    expect(trigger?.getAttribute('aria-label')).toBe(
      'Emoji, GIFs and stickers',
    );
    expect(trigger?.getAttribute('trnTooltip')).toBe(
      'Emoji, GIFs and stickers',
    );
  });

  it('offers no GIFs tab, and no tab bar, when no provider is configured', async () => {
    const { fixture } = await renderComposer();
    fixture.componentInstance.pickerOpen.set(true);
    TestBed.tick();

    expect(
      document.querySelector('[data-testid=expression-picker]'),
    ).not.toBeNull();
    expect(document.querySelector('[role=tablist]')).toBeNull();
  });

  it('offers a GIFs tab in the panel when a provider + key are configured', async () => {
    const { fixture } = await renderComposer({}, gifProviders());
    fixture.componentInstance.pickerOpen.set(true);
    TestBed.tick();

    expect(
      document.querySelector('[data-testid=expression-tab-gif]'),
    ).not.toBeNull();
  });

  it('offers a Stickers tab only where the room has stickers', async () => {
    const { fixture } = await renderComposer({ stickerPacks: [stickerPack] });
    fixture.componentInstance.pickerOpen.set(true);
    TestBed.tick();

    expect(
      document.querySelector('[data-testid=expression-tab-sticker]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid=expression-tab-gif]'),
    ).toBeNull();
  });

  it('sends a sticker chosen in the panel and closes it', async () => {
    const { fixture } = await renderComposer({ stickerPacks: [stickerPack] }, [
      MockProvider(MediaService, {
        resolveMedia: vi.fn(() => of('blob:sticker')),
        pin: vi.fn(),
        unpin: vi.fn(),
      }),
    ]);
    const cmp = fixture.componentInstance;
    const sent = vi.fn();
    cmp.stickerSelect.subscribe(sent);
    cmp.pickerOpen.set(true);
    TestBed.tick();

    document
      .querySelector<HTMLButtonElement>('[data-testid=expression-tab-sticker]')
      ?.click();
    TestBed.tick();
    document
      .querySelector<HTMLButtonElement>('[data-testid=sticker-party]')
      ?.click();
    TestBed.tick();

    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({ shortcode: 'party' }),
    );
    expect(cmp.pickerOpen()).toBe(false);
    expect(
      document.querySelector('[data-testid=expression-picker]'),
    ).toBeNull();
  });

  it('closes the panel when it asks to be dismissed, and returns the caret to the input', async () => {
    const { fixture, container } = await renderComposer({}, gifProviders());
    const cmp = fixture.componentInstance;
    cmp.pickerOpen.set(true);
    TestBed.tick();

    document
      .querySelector('[data-testid=expression-tab-gif]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    TestBed.tick();
    await Promise.resolve();

    expect(cmp.pickerOpen()).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('textarea'));
  });

  it('opens image-pack settings with the active room as context', async () => {
    const open = vi.fn((request: WorkspaceApplicationSurfaceRequest) =>
      of({ kind: 'presented' as const, surface: request.surface }),
    );
    const { fixture } = await renderComposer({ roomId: '!room:hs' }, [
      MockProvider(WorkspaceApplicationSurfaceService, { open }),
    ]);
    fixture.componentInstance.pickerOpen.set(true);

    fixture.componentInstance.manageImagePacks();

    expect(fixture.componentInstance.pickerOpen()).toBe(false);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: { kind: 'settings', section: 'stickers' },
        context: {
          sourceRoomId: '!room:hs',
          restoreFocus: expect.any(Function),
        },
      }),
    );
  });

  it('downloads a chosen GIF and sends it as media, closing the picker', async () => {
    const download = vi.fn(() =>
      of(
        new File([new Uint8Array([1])], 'happy-cat.gif', { type: 'image/gif' }),
      ),
    );
    const { fixture } = await renderComposer({}, gifProviders(download));
    const cmp = fixture.componentInstance;
    cmp.pickerOpen.set(true);

    let emitted: { items: readonly BatchItem[]; caption: string } | undefined;
    cmp.submitMedia.subscribe((e) => {
      emitted = e;
      e.onOutcomes(e.items.map((i) => ({ id: i.id, failed: false })));
    });

    cmp.onGifSelect(gifResult);

    expect(download).toHaveBeenCalledWith(gifResult);
    expect(emitted?.items[0]?.file.type).toBe('image/gif');
    expect(emitted?.caption).toBe('');
    expect(cmp.pickerOpen()).toBe(false);
    expect(cmp['attachments'].gifDownloading()).toBe(false);
  });

  it('refuses a GIF while the Conversation cannot send, keeping the panel open', async () => {
    const download = vi.fn();
    const { fixture } = await renderComposer(
      { sendBlocked: true },
      gifProviders(download),
    );
    const cmp = fixture.componentInstance;
    cmp.pickerOpen.set(true);

    cmp.onGifSelect(gifResult);

    expect(download).not.toHaveBeenCalled();
    expect(cmp.pickerOpen()).toBe(true);
  });

  it('shows a spinner on the panel trigger while a chosen GIF downloads', async () => {
    const { fixture, container } = await renderComposer(
      {},
      gifProviders(() => NEVER),
    );
    const cmp = fixture.componentInstance;
    cmp.pickerOpen.set(true);

    cmp.onGifSelect(gifResult);
    await fixture.whenStable();

    expect(
      container.querySelector('.composer__emoji trn-spinner'),
    ).not.toBeNull();
    // Still open: it closes once the GIF has arrived and is on its way.
    expect(cmp.pickerOpen()).toBe(true);
  });

  it('tells assistive tech the trigger is busy while a chosen GIF downloads', async () => {
    const { fixture, container } = await renderComposer(
      {},
      gifProviders(() => NEVER),
    );
    const cmp = fixture.componentInstance;
    const trigger = container.querySelector<HTMLElement>('.composer__emoji');
    const status = container.querySelector('[data-testid=composer-gif-status]');
    expect(trigger?.getAttribute('aria-busy')).toBeNull();
    expect(status?.textContent?.trim()).toBe('');

    cmp.onGifSelect(gifResult);
    await fixture.whenStable();

    expect(trigger?.getAttribute('aria-busy')).toBe('true');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent?.trim()).toBe('Sending GIF…');
  });

  it('offers only Emoji while editing a message, with no tab bar', async () => {
    // An edit cannot become a GIF or a sticker; the `+` tray is disabled while editing for
    // the same reason.
    const { fixture } = await renderComposer(
      { editing: true, stickerPacks: [stickerPack] },
      gifProviders(),
    );
    fixture.componentInstance.pickerOpen.set(true);
    TestBed.tick();

    expect(
      document.querySelector('[data-testid=expression-picker]'),
    ).not.toBeNull();
    expect(document.querySelector('[role=tablist]')).toBeNull();
    expect(
      document.querySelector('[data-testid=expression-tab-gif]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid=expression-tab-sticker]'),
    ).toBeNull();
  });

  it('refuses a GIF or a sticker while editing a message', async () => {
    const download = vi.fn();
    const { fixture } = await renderComposer(
      { editing: true, stickerPacks: [stickerPack] },
      gifProviders(download),
    );
    const cmp = fixture.componentInstance;
    const sent = vi.fn();
    cmp.stickerSelect.subscribe(sent);

    cmp.onGifSelect(gifResult);
    cmp.onStickerSelect(stickerPack.images[0]!);

    expect(download).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
  });

  it('opens the panel as a bottom sheet where the app prefers sheets', async () => {
    const { fixture, container } = await renderComposer({}, gifProviders());
    const cmp = fixture.componentInstance;
    vi.spyOn(TestBed.inject(TrnSurfaceService), 'prefersSheet').mockReturnValue(
      true,
    );
    const trigger = container.querySelector<HTMLElement>('.composer__emoji')!;

    trigger.click();
    TestBed.tick();

    const sheet = document.querySelector('trn-sheet-frame');
    const panel = document.querySelector<HTMLElement>(
      '[data-testid=expression-picker]',
    );
    expect(sheet).not.toBeNull();
    expect(sheet?.contains(panel)).toBe(true);
    expect(panel?.getAttribute('data-presentation')).toBe('sheet');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(
      document.querySelector('[data-testid=expression-tab-gif]'),
    ).not.toBeNull();

    // Picking closes it, as it closes the popover.
    cmp.onPickerSelect({
      native: '😎',
      id: 'sunglasses',
      colons: ':sunglasses:',
    });
    TestBed.tick();

    expect(cmp.pickerOpen()).toBe(false);
    expect(document.querySelector('trn-sheet-frame')).toBeNull();
  });

  it('moves focus into the sheet and keeps it out of the emoji search once its grid loads', async () => {
    const { container } = await renderComposer();
    vi.spyOn(TestBed.inject(TrnSurfaceService), 'prefersSheet').mockReturnValue(
      true,
    );
    const focused: string[] = [];
    const record = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      focused.push(
        target.hasAttribute('data-expression-content')
          ? 'content'
          : target.closest('.emoji-mart-search')
            ? 'emoji-search'
            : target.tagName.toLowerCase(),
      );
    };
    document.addEventListener('focusin', record);

    try {
      container.querySelector<HTMLElement>('.composer__emoji')!.click();
      TestBed.tick();
      // The emoji grid loads behind `@defer`, so this waits for the vendor chunk. Cold, that
      // includes transforming emoji-mart and its data: about 13 s here, past 20 s on a loaded
      // CI runner (#1339), so the limits are set by that cost rather than by the steps.
      await vi.waitFor(
        () => {
          TestBed.tick();
          expect(
            container.ownerDocument.querySelector('.emoji-mart-search'),
          ).not.toBeNull();
        },
        { timeout: 50_000 },
      );
    } finally {
      document.removeEventListener('focusin', record);
    }

    // Focus stays on the sheet's content, so a phone keyboard does not rise until the user
    // taps the search.
    expect(focused).toEqual(['content']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    TestBed.tick();
    expect(
      document.activeElement?.hasAttribute('data-expression-content'),
    ).toBe(true);
  }, 60_000);

  it('ends the sheet with one visually hidden Close button for screen readers', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    vi.spyOn(TestBed.inject(TrnSurfaceService), 'prefersSheet').mockReturnValue(
      true,
    );
    container.querySelector<HTMLElement>('.composer__emoji')!.click();
    TestBed.tick();
    const sheet = document.querySelector<HTMLElement>('trn-sheet-frame')!;

    // Its name comes from its own text; the handle is aria-hidden and the backdrop cannot
    // take focus, so this is the sheet's one reachable dismiss control.
    const closes = Array.from(sheet.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === 'Close',
    );
    expect(closes).toHaveLength(1);
    const close = closes[0]!;
    expect(close).toHaveAttribute('type', 'button');
    expect(close).toHaveAttribute('data-testid', 'expression-sheet-close');
    expect(close).toHaveClass('sr-only');

    // Out of the Tab order: hidden, it would be a stop with no visible focus (WCAG 2.4.7).
    // A screen reader still reaches it by swipe or virtual cursor; the keyboard has Escape.
    expect(close).toHaveAttribute('tabindex', '-1');
    expect(close.tabIndex).toBe(-1);
    expect(close).toHaveAccessibleName('Close');
    expect(document.activeElement).not.toBe(close);

    close.click();
    TestBed.tick();
    await Promise.resolve();

    expect(document.querySelector('trn-sheet-frame')).toBeNull();
    expect(cmp.pickerOpen()).toBe(false);
    // Closed the way Escape closes it: focus goes back to the button that opened it.
    expect(document.activeElement).toBe(
      container.querySelector('.composer__emoji'),
    );
  });

  it('reports a sheet the person closed as closed', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    vi.spyOn(TestBed.inject(TrnSurfaceService), 'prefersSheet').mockReturnValue(
      true,
    );
    container.querySelector<HTMLElement>('.composer__emoji')!.click();
    TestBed.tick();

    // No close button: the person taps the backdrop (or swipes, or presses Escape).
    expect(document.querySelector('[data-testid=dialog-close]')).toBeNull();
    document.querySelector<HTMLElement>('.cdk-overlay-backdrop')!.click();
    TestBed.tick();

    expect(document.querySelector('trn-sheet-frame')).toBeNull();
    expect(cmp.pickerOpen()).toBe(false);
  });

  it('keeps the anchored panel where the app does not prefer sheets', async () => {
    const { container } = await renderComposer();
    vi.spyOn(TestBed.inject(TrnSurfaceService), 'prefersSheet').mockReturnValue(
      false,
    );

    container.querySelector<HTMLElement>('.composer__emoji')!.click();
    TestBed.tick();

    expect(document.querySelector('trn-sheet-frame')).toBeNull();
    expect(
      document
        .querySelector('[data-testid=expression-picker]')
        ?.getAttribute('data-presentation'),
    ).toBe('popover');
  });

  it('ends an active reply when a GIF is sent (media carries no reply relation)', async () => {
    const { fixture } = await renderComposer(
      { replyingTo: 'Alice' },
      gifProviders(),
    );
    const cmp = fixture.componentInstance;

    let cancelled = false;
    cmp.cancelReply.subscribe(() => (cancelled = true));
    cmp.onGifSelect(gifResult);

    expect(cancelled).toBe(true);
  });

  it('toasts when a GIF download fails', async () => {
    const { fixture } = await renderComposer(
      {},
      gifProviders(() => throwError(() => new Error('nope'))),
    );
    const cmp = fixture.componentInstance;

    cmp.onGifSelect(gifResult);
    await Promise.resolve();

    const toast = TestBed.inject(TrnToastService);
    expect(toast.show).toHaveBeenCalledWith(
      expect.stringContaining('Could not load'),
      expect.objectContaining({ variant: 'danger' }),
    );
    expect(cmp['attachments'].gifDownloading()).toBe(false);
  });

  describe('insert tray', () => {
    // Every compose action lives behind the `+` at all widths: a dropdown when there is
    // more than one to offer (hasInsertMenu), a plain attach button when there is not.
    it('offers the tray whenever more than one insert action exists', async () => {
      const { container } = await renderComposer({}, [
        MockProvider(VoiceRecorderService, { supported: true }),
      ]);

      expect(
        container.querySelector('[data-testid=composer-insert]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid=composer-insert-attach]'),
      ).toBeNull();
    });

    it('falls back to a plain attach button when the tray would hold one item', async () => {
      // Thread composer: attach is the only insert action left, so a one-item menu would
      // be pure friction.
      const { container } = await renderComposer({ richActions: false }, [
        MockProvider(GifSettingsService, { configured: signal(false) }),
      ]);

      expect(
        container.querySelector('[data-testid=composer-insert]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid=composer-insert-attach]'),
      ).not.toBeNull();
    });

    it("keeps the thread composer's + a plain attach button even with a GIF provider", async () => {
      // GIFs live in the expression panel now, so a configured provider no longer turns the
      // thread composer's lone attach action into a one-item tray.
      const { container } = await renderComposer({ richActions: false }, [
        ...gifProviders(),
        MockProvider(VoiceRecorderService, { supported: true }),
      ]);

      expect(
        container.querySelector('[data-testid=composer-insert]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid=composer-insert-attach]'),
      ).not.toBeNull();
    });

    it('offers every insert action in the tray with full config', async () => {
      const { fixture } = await renderComposer({}, [
        MockProvider(GifSettingsService, {
          configured: signal(true).asReadonly(),
        }),
        MockProvider(VoiceRecorderService, { supported: true }),
      ]);
      (fixture.nativeElement as HTMLElement)
        .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
        ?.click();
      await fixture.whenStable();

      for (const id of [
        'insert-attach',
        'insert-poll',
        'insert-location',
        'insert-voice',
      ]) {
        expect(document.querySelector(`[data-testid=${id}]`)).not.toBeNull();
      }
      // GIFs and stickers live in the expression panel, not in the tray.
      expect(document.querySelector('[data-testid=insert-gif]')).toBeNull();
      expect(document.querySelector('[data-testid=insert-sticker]')).toBeNull();
    });

    it('wires each tray item to its handler', async () => {
      // The wiring the change moved from inline buttons to tray items: each item's
      // (triggered) must call the right method. A CDK menu item fires on click only
      // after a full ApplicationRef.tick() (the overlay is a root view, not the fixture
      // view), and it closes the menu after firing — so re-open the tray per item.
      // Handlers are spied so their side effects (dialogs, services) don't run.
      const { fixture } = await renderComposer({}, [
        MockProvider(GifSettingsService, {
          configured: signal(true).asReadonly(),
        }),
        MockProvider(VoiceRecorderService, { supported: true }),
      ]);
      const cmp = fixture.componentInstance;
      const appRef = TestBed.inject(ApplicationRef);
      const wiring: [string, ReturnType<typeof vi.spyOn>][] = [
        ['insert-attach', vi.spyOn(cmp, 'onAttach').mockReturnValue()],
        ['insert-poll', vi.spyOn(cmp, 'openPollDialog').mockReturnValue()],
        ['insert-location', vi.spyOn(cmp, 'shareLocation').mockReturnValue()],
        [
          'insert-voice',
          vi.spyOn(cmp, 'startVoiceRecording').mockResolvedValue(),
        ],
      ];

      for (const [testid, spy] of wiring) {
        (fixture.nativeElement as HTMLElement)
          .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
          ?.click();
        appRef.tick();
        (
          document.querySelector(
            `[data-testid=${testid}]`,
          ) as HTMLElement | null
        )?.click();
        appRef.tick();
        expect(spy, testid).toHaveBeenCalledTimes(1);
      }
    });

    it('wires the plain attach fallback button to onAttach', async () => {
      // The thread composer's only attach affordance (hasInsertMenu false). A plain
      // button, so a direct click drives it — no overlay/tick plumbing.
      const { fixture, container } = await renderComposer(
        { richActions: false },
        [
          MockProvider(GifSettingsService, {
            configured: signal(false).asReadonly(),
          }),
        ],
      );
      const spy = vi
        .spyOn(fixture.componentInstance, 'onAttach')
        .mockReturnValue();

      container
        .querySelector<HTMLButtonElement>(
          '[data-testid=composer-insert-attach]',
        )
        ?.click();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('disables the Location item in the tray while a share is in flight', async () => {
      // The inline location button's disabled state moved to the tray item; the
      // trigger only shows a spinner, so the item is where the guard now lives.
      const { fixture } = await renderComposer({}, [
        MockProvider(LocationShareService, {
          sharing: signal(true).asReadonly(),
          share: vi.fn(),
        }),
      ]);
      (fixture.nativeElement as HTMLElement)
        .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
        ?.click();
      TestBed.inject(ApplicationRef).tick();

      expect(
        document
          .querySelector('[data-testid=insert-location]')
          ?.getAttribute('data-disabled'),
      ).toBe('');
    });

    it('disables the + trigger while editing a message', async () => {
      // A single [disabled]="editing()" on the trigger locks out every insert while an
      // edit is in progress — the change replaced five per-button guards with this one.
      const { container } = await renderComposer({ editing: true }, [
        MockProvider(VoiceRecorderService, { supported: true }),
      ]);

      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid=composer-insert]',
        )?.disabled,
      ).toBe(true);
    });
  });

  it('dismisses the panel on Escape from anywhere in the composer, not just the textarea', async () => {
    // The binding lives on the host: the panel can be open while focus sits on a composer
    // button and never enters the textarea. Dispatch from a non-textarea element to prove
    // the handler is not textarea-scoped.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.pickerOpen.set(true);

    fixture.nativeElement
      .querySelector('[data-testid=composer-insert]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );

    expect(cmp.pickerOpen()).toBe(false);
  });

  it('always renders the send button, at every width and pointer type', async () => {
    // Previously touch-only via `@media (hover: none)`. Enter-to-send is not always
    // unambiguous (newlines in a draft, IME composition), so the target is permanent.
    const { container } = await renderComposer();

    const send = container.querySelector<HTMLButtonElement>(
      '[data-testid=composer-send]',
    );
    expect(send).not.toBeNull();
    // Disabled with nothing to send, so it cannot fire an empty message.
    expect(send?.disabled).toBe(true);
  });

  it('shows a spinner on the + trigger while a location share is in flight', async () => {
    const { container } = await renderComposer({}, [
      MockProvider(LocationShareService, {
        sharing: signal(true).asReadonly(),
        share: vi.fn(),
      }),
    ]);

    // The `+` trigger swaps its icon for a spinner while a share runs; the tray's own
    // Location item carries the disabled state.
    const trigger = container.querySelector('[data-testid=composer-insert]');
    expect(trigger?.querySelector('trn-spinner')).not.toBeNull();
  });

  describe('voice messages', () => {
    const recording = {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
      durationMs: 3000,
      waveform: [0, 512, 1024],
      mimeType: 'audio/webm',
    };

    /** Providers wiring a fake recorder + a spyable voice-send. */
    function voiceProviders(
      over: {
        start?: () => Promise<void>;
        stop?: () => Promise<typeof recording | null>;
        sendVoiceMessage?: Mock;
      } = {},
    ) {
      const cancel = vi.fn();
      const sendVoiceMessage = over.sendVoiceMessage ?? vi.fn(() => of(void 0));
      return {
        cancel,
        sendVoiceMessage,
        providers: [
          MockProvider(VoiceRecorderService, {
            supported: true,
            start: over.start ?? (() => Promise.resolve()),
            stop: over.stop ?? (() => Promise.resolve(recording)),
            cancel,
          }),
          MockProvider(TimelineActionsService, { sendVoiceMessage }),
        ] as Provider[],
      };
    }

    it('shows the mic button and starts recording on click', async () => {
      const { providers } = voiceProviders();
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;

      await cmp.startVoiceRecording();

      expect(cmp['attachments'].recordingVoice()).toBe(true);
    });

    it('stops recording and sends the clip as a voice message', async () => {
      const { providers, sendVoiceMessage } = voiceProviders();
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();

      cmp.stopVoiceRecording();
      await Promise.resolve();
      await Promise.resolve();

      expect(sendVoiceMessage).toHaveBeenCalledWith(recording);
      expect(cmp['attachments'].recordingVoice()).toBe(false);
    });

    it('ignores a second start while the mic is still being acquired', async () => {
      let resolveStart!: () => void;
      const start = vi.fn(
        () => new Promise<void>((resolve) => (resolveStart = resolve)),
      );
      const cancel = vi.fn();
      const { fixture } = await renderComposer({}, [
        MockProvider(VoiceRecorderService, {
          supported: true,
          start,
          stop: () => Promise.resolve(recording),
          cancel,
        }),
        MockProvider(TimelineActionsService, {}),
      ]);
      const cmp = fixture.componentInstance;

      const first = cmp.startVoiceRecording();
      const second = cmp.startVoiceRecording(); // clicked again during acquisition
      resolveStart();
      await Promise.all([first, second]);

      expect(start).toHaveBeenCalledTimes(1); // only one mic stream opened
      expect(cmp['attachments'].recordingVoice()).toBe(true);
    });

    it('cancels an in-progress recording when the room switches', async () => {
      const { providers, cancel } = voiceProviders();
      const { fixture } = await renderComposer({ roomId: '!a:hs' }, providers);
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();
      expect(cmp['attachments'].recordingVoice()).toBe(true);

      fixture.componentRef.setInput('roomId', '!b:hs');
      fixture.detectChanges();

      expect(cancel).toHaveBeenCalled();
      expect(cmp['attachments'].recordingVoice()).toBe(false);
    });

    it('cancels a recording without sending', async () => {
      const { providers, cancel, sendVoiceMessage } = voiceProviders();
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();

      cmp.cancelVoiceRecording();

      expect(cancel).toHaveBeenCalled();
      expect(cmp['attachments'].recordingVoice()).toBe(false);
      expect(sendVoiceMessage).not.toHaveBeenCalled();
    });

    it('toasts and stays idle when the mic can’t be accessed', async () => {
      const { providers } = voiceProviders({
        start: () => Promise.reject(new Error('denied')),
      });
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;

      await cmp.startVoiceRecording();

      expect(cmp['attachments'].recordingVoice()).toBe(false);
      expect(TestBed.inject(TrnToastService).show).toHaveBeenCalledWith(
        expect.stringContaining('microphone'),
        expect.objectContaining({ variant: 'danger' }),
      );
    });

    it('does not send an empty clip', async () => {
      const { providers, sendVoiceMessage } = voiceProviders({
        stop: () => Promise.resolve({ ...recording, blob: new Blob([]) }),
      });
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();

      cmp.stopVoiceRecording();
      await Promise.resolve();
      await Promise.resolve();

      expect(sendVoiceMessage).not.toHaveBeenCalled();
    });
  });
});
