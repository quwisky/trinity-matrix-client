import {
  gifProviders,
  gifResult,
  renderComposer,
  setMobilePlatform,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { ApplicationRef, signal, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
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
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import { LocationShareService } from '../location-share/location-share.service';
import { MediaService, type ImagePack } from '@trinity/data-access/media';
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
        open: vi.fn(() => {
          TestBed.inject(TrnDialogService).open(CreatePollDialogComponent, {
            ariaLabel: 'Create poll',
            autoFocus: '[data-testid=poll-question]',
          });
          return Promise.resolve();
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

  it('hands mobile GIF focus to the real GIF search', async () => {
    setMobilePlatform(true);
    const { fixture, container } = await renderComposer({}, [
      ...gifProviders(),
      MockProvider(GifService, {
        search: vi.fn(() => of([])),
        download: vi.fn(),
      }),
    ]);

    container
      .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
      ?.click();
    await fixture.whenStable();
    document
      .querySelector<HTMLButtonElement>('[data-testid=insert-gif]')
      ?.click();
    TestBed.inject(ApplicationRef).tick();
    await fixture.whenStable();

    expect(document.querySelector('[data-testid=gif-search]')).toBe(
      document.activeElement,
    );
  });

  it('hands mobile Sticker focus to the real sticker search', async () => {
    setMobilePlatform(true);
    const { fixture, container } = await renderComposer(
      { stickerPacks: [stickerPack] },
      [
        MockProvider(MediaService, {
          resolveMedia: vi.fn(() => of('blob:sticker')),
          pin: vi.fn(),
          unpin: vi.fn(),
        }),
      ],
    );

    container
      .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
      ?.click();
    await fixture.whenStable();
    document
      .querySelector<HTMLButtonElement>('[data-testid=insert-sticker]')
      ?.click();
    TestBed.inject(ApplicationRef).tick();
    await fixture.whenStable();

    expect(document.querySelector('[data-testid=sticker-search]')).toBe(
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
    expect(document.querySelector('trn-emoji-picker')).not.toBeNull();

    clickTrigger();

    // Both, because the failure was them disagreeing.
    expect(cmp.pickerOpen()).toBe(false);
    expect(document.querySelector('trn-emoji-picker')).toBeNull();
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

  it('omits GIF from the tray when no provider is configured', async () => {
    const { fixture } = await renderComposer();
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
      ?.click();
    await fixture.whenStable();
    expect(document.querySelector('[data-testid=insert-gif]')).toBeNull();
  });

  it('offers GIF in the tray when a provider + key are configured', async () => {
    const { fixture } = await renderComposer({}, gifProviders());
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
      ?.click();
    await fixture.whenStable();
    expect(document.querySelector('[data-testid=insert-gif]')).not.toBeNull();
  });

  it('opening the GIF picker closes the emoji picker and vice versa', async () => {
    const { fixture } = await renderComposer({}, gifProviders());
    const cmp = fixture.componentInstance;

    cmp.pickerOpen.set(true);
    cmp.toggleGifPicker();
    expect(cmp.gifPickerOpen()).toBe(true);
    expect(cmp.pickerOpen()).toBe(false);

    cmp.toggleEmojiPicker();
    expect(cmp.pickerOpen()).toBe(true);
    expect(cmp.gifPickerOpen()).toBe(false);
  });

  it('opens image-pack settings with the active room as context', async () => {
    const open = vi.fn((request: WorkspaceApplicationSurfaceRequest) =>
      of({ kind: 'presented' as const, surface: request.surface }),
    );
    const { fixture } = await renderComposer({ roomId: '!room:hs' }, [
      MockProvider(WorkspaceApplicationSurfaceService, { open }),
    ]);
    fixture.componentInstance.stickerPickerOpen.set(true);

    fixture.componentInstance.manageImagePacks();

    expect(fixture.componentInstance.stickerPickerOpen()).toBe(false);
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
    cmp.gifPickerOpen.set(true);

    let emitted: { items: readonly BatchItem[]; caption: string } | undefined;
    cmp.submitMedia.subscribe((e) => {
      emitted = e;
      e.onOutcomes(e.items.map((i) => ({ id: i.id, failed: false })));
    });

    cmp.onGifSelect(gifResult);

    expect(download).toHaveBeenCalledWith(gifResult);
    expect(emitted?.items[0]?.file.type).toBe('image/gif');
    expect(emitted?.caption).toBe('');
    expect(cmp.gifPickerOpen()).toBe(false);
    expect(cmp.gifDownloading()).toBe(false);
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
    expect(cmp.gifDownloading()).toBe(false);
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
      // Thread composer with no GIF provider: attach is the only insert action left,
      // so a one-item menu would be pure friction.
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

    it('omits the room-only actions from the opened tray when richActions is off', async () => {
      // The thread composer routes poll/location/voice to the room, not the thread, so
      // they must not appear in its tray. Asserting it needs the menu opened — CDK only
      // instantiates the ng-template on open, at the document root.
      const { fixture } = await renderComposer({ richActions: false }, [
        MockProvider(GifSettingsService, { configured: signal(true) }),
        MockProvider(VoiceRecorderService, { supported: true }),
      ]);

      (fixture.nativeElement as HTMLElement)

        .querySelector<HTMLButtonElement>('[data-testid=composer-insert]')
        ?.click();
      await fixture.whenStable();

      for (const id of ['insert-poll', 'insert-location', 'insert-voice']) {
        expect(document.querySelector(`[data-testid=${id}]`)).toBeNull();
      }
      // ...while the actions that *are* thread-safe still appear.
      expect(
        document.querySelector('[data-testid=insert-attach]'),
      ).not.toBeNull();
      expect(document.querySelector('[data-testid=insert-gif]')).not.toBeNull();
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
        'insert-gif',
        'insert-poll',
        'insert-location',
        'insert-voice',
      ]) {
        expect(document.querySelector(`[data-testid=${id}]`)).not.toBeNull();
      }
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
        ['insert-gif', vi.spyOn(cmp, 'toggleGifPicker').mockReturnValue()],
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

  it('dismisses a picker on Escape from anywhere in the composer, not just the textarea', async () => {
    // The binding lives on the host: the GIF picker can be opened from the insert tray,
    // after which focus sits on the `+` trigger and never enters the textarea. Dispatch
    // from a non-textarea element to prove the handler is not textarea-scoped.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.gifPickerOpen.set(true);

    fixture.nativeElement
      .querySelector('[data-testid=composer-insert]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );

    expect(cmp.gifPickerOpen()).toBe(false);
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

    // The `+` trigger swaps its icon for a spinner while a share (or GIF fetch) runs;
    // the tray's own Location item carries the disabled state.
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

      expect(cmp.recordingVoice()).toBe(true);
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
      expect(cmp.recordingVoice()).toBe(false);
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
      expect(cmp.recordingVoice()).toBe(true);
    });

    it('cancels an in-progress recording when the room switches', async () => {
      const { providers, cancel } = voiceProviders();
      const { fixture } = await renderComposer({ roomId: '!a:hs' }, providers);
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();
      expect(cmp.recordingVoice()).toBe(true);

      fixture.componentRef.setInput('roomId', '!b:hs');
      fixture.detectChanges();

      expect(cancel).toHaveBeenCalled();
      expect(cmp.recordingVoice()).toBe(false);
    });

    it('cancels a recording without sending', async () => {
      const { providers, cancel, sendVoiceMessage } = voiceProviders();
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();

      cmp.cancelVoiceRecording();

      expect(cancel).toHaveBeenCalled();
      expect(cmp.recordingVoice()).toBe(false);
      expect(sendVoiceMessage).not.toHaveBeenCalled();
    });

    it('toasts and stays idle when the mic can’t be accessed', async () => {
      const { providers } = voiceProviders({
        start: () => Promise.reject(new Error('denied')),
      });
      const { fixture } = await renderComposer({}, providers);
      const cmp = fixture.componentInstance;

      await cmp.startVoiceRecording();

      expect(cmp.recordingVoice()).toBe(false);
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
