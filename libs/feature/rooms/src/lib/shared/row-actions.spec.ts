import { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RecentEmojiService } from '@trinity/data-access/media';
import { MockProvider } from 'ng-mocks';
import { of, Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageSourceComponent } from '../message-source/message-source.component';
import { ReactionPickerComponent } from '../reaction-picker/reaction-picker.component';
import { type MessageRow } from '../message-row/message-row.component';
import {
  buildRowCaps,
  buildRowCapsMap,
  addableImages,
  dispatchSharedRowAction,
  sameRowCaps,
  type RowCapsPolicy,
  type SharedRowActionContext,
} from './row-actions';

const row = { id: '$e', body: 'hello' } as MessageRow;

function setup(overrides: Partial<SharedRowActionContext> = {}) {
  const ctx = {
    roomId: '!r:hs',
    accountId: null as string | null,
    destroyRef: { onDestroy: () => () => undefined } as unknown as DestroyRef,
    dialog: {
      open: vi.fn(),
      openAndWait$: vi.fn(() => of('🎉')),
      openActions: vi.fn(),
    },
    timeline: { rawEvent: vi.fn(() => ({ type: 'm.room.message' })) },
    forward: { forward$: vi.fn(() => of(undefined)) },
    report: { report$: vi.fn(() => of(undefined)) },
    reactions: { open$: vi.fn(() => of(undefined)) },
    editHistory: { openHistory$: vi.fn(() => of(null)) },
    react: vi.fn(),
    quote: vi.fn(),
    mediaSave: { save: vi.fn() },
    undecryptableFix: { open: vi.fn(() => of(undefined)) },
    addToEmoji: { add: vi.fn(), canAdd: vi.fn(() => true) },
    ...overrides,
  };
  return ctx as typeof ctx & SharedRowActionContext;
}

describe('dispatchSharedRowAction', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens the fix for a message this device could not decrypt', () => {
    const ctx = setup();

    expect(
      dispatchSharedRowAction({ type: 'fix-undecryptable' }, row, ctx),
    ).toBe(true);
    expect(ctx.undecryptableFix.open).toHaveBeenCalledOnce();
  });

  it('saves the row media through the shared save service', () => {
    const media = { id: 'm', kind: 'image' } as MessageRow['media'];
    const ctx = setup();

    expect(
      dispatchSharedRowAction({ type: 'save-media' }, { ...row, media }, ctx),
    ).toBe(true);

    expect(ctx.mediaSave.save).toHaveBeenCalledWith(media);
  });

  it('"Add to my emoji" on a sticker opens the dialog with its mxc and info', () => {
    const info = { mimetype: 'image/webp', w: 256, h: 240, size: 1234 };
    const ctx = setup({
      timeline: {
        rawEvent: vi.fn(() => ({
          type: 'm.sticker',
          content: { url: 'mxc://hs/fox', body: 'Fox', info },
        })),
      },
    });

    expect(dispatchSharedRowAction({ type: 'add-to-emoji' }, row, ctx)).toBe(
      true,
    );

    expect(ctx.timeline.rawEvent).toHaveBeenCalledWith('!r:hs', '$e');
    expect(ctx.addToEmoji.add).toHaveBeenCalledWith(
      {
        kind: 'existing',
        url: 'mxc://hs/fox',
        body: 'Fox',
        info: { mimetype: 'image/webp', w: 256, h: 240, size: 1234 },
      },
      'Fox',
    );
  });

  it('suggests a non-empty name for a sticker without a body', () => {
    const ctx = setup({
      timeline: {
        rawEvent: vi.fn(() => ({
          type: 'm.sticker',
          content: { url: 'mxc://hs/fox' },
        })),
      },
    });

    dispatchSharedRowAction({ type: 'add-to-emoji' }, row, ctx);

    expect(ctx.addToEmoji.add).toHaveBeenCalledWith(
      { kind: 'existing', url: 'mxc://hs/fox' },
      'sticker',
    );
  });

  describe('"Add to my emoji" on a text message', () => {
    const emoji = (code: string) =>
      `<img data-mx-emoticon="" alt=":${code}:" class="mx-emoticon" data-mx-src="mxc://hs/${code}" height="32">`;
    const withEmoji = (...codes: string[]) =>
      ({ ...row, html: `hi ${codes.map(emoji).join(' ')}` }) as MessageRow;

    it('opens the dialog for its one addable emoji', () => {
      const ctx = setup();

      dispatchSharedRowAction({ type: 'add-to-emoji' }, withEmoji('wave'), ctx);

      expect(ctx.addToEmoji.add).toHaveBeenCalledWith(
        { kind: 'existing', url: 'mxc://hs/wave', body: 'wave' },
        'wave',
      );
      expect(ctx.dialog.openActions).not.toHaveBeenCalled();
    });

    it('lets the user choose by :code: among several', () => {
      const ctx = setup({
        addToEmoji: {
          add: vi.fn(),
          canAdd: vi.fn((mxc: string) => mxc !== 'mxc://hs/owned'),
        },
      });

      dispatchSharedRowAction(
        { type: 'add-to-emoji' },
        withEmoji('wave', 'owned', 'cat', 'wave'),
        ctx,
      );

      expect(ctx.addToEmoji.add).not.toHaveBeenCalled();
      const [data] = vi.mocked(ctx.dialog.openActions).mock
        .calls[0] as unknown as [
        {
          header: string;
          buttons: { text: string; role?: string; handler?: () => void }[];
        },
      ];
      expect(data.header).toBe('Add to my emoji');
      expect(data.buttons.map((button) => button.text)).toEqual([
        ':wave:',
        ':cat:',
        'Cancel',
      ]);
      data.buttons[1].handler!();
      expect(ctx.addToEmoji.add).toHaveBeenCalledWith(
        { kind: 'existing', url: 'mxc://hs/cat', body: 'cat' },
        'cat',
      );
    });
  });

  it('does nothing for save-media on a row without media', () => {
    const ctx = setup();

    dispatchSharedRowAction(
      { type: 'save-media' },
      { ...row, media: null },
      ctx,
    );

    expect(ctx.mediaSave.save).not.toHaveBeenCalled();
  });

  it('leaves host-specific actions unhandled', () => {
    const ctx = setup();

    expect(dispatchSharedRowAction({ type: 'reply' }, row, ctx)).toBe(false);
    expect(dispatchSharedRowAction({ type: 'delete' }, row, ctx)).toBe(false);
  });

  it('copies the body and a permalink', () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const ctx = setup();

    expect(dispatchSharedRowAction({ type: 'copy' }, row, ctx)).toBe(true);
    dispatchSharedRowAction({ type: 'copy-link' }, row, ctx);

    expect(writeText).toHaveBeenNthCalledWith(1, 'hello');
    expect(writeText).toHaveBeenNthCalledWith(
      2,
      'https://matrix.to/#/!r%3Ahs/%24e?via=hs',
    );
  });

  it('hands quote and react to the host', () => {
    const ctx = setup();

    dispatchSharedRowAction({ type: 'quote' }, row, ctx);
    dispatchSharedRowAction({ type: 'react', key: '👍' }, row, ctx);

    expect(ctx.quote).toHaveBeenCalledWith(row);
    expect(ctx.react).toHaveBeenCalledWith('$e', '👍');
  });

  it('records no recent emoji for a react, which may be a pill toggled off', () => {
    const record = vi.fn();
    TestBed.configureTestingModule({
      providers: [MockProvider(RecentEmojiService, { record })],
    });
    TestBed.runInInjectionContext(() =>
      dispatchSharedRowAction({ type: 'react', key: '👍' }, row, setup()),
    );

    expect(record).not.toHaveBeenCalled();
  });

  it('reacts with the emoji picked from the full picker', () => {
    const ctx = setup();

    dispatchSharedRowAction({ type: 'react-more' }, row, ctx);

    expect(ctx.react).toHaveBeenCalledWith('$e', '🎉');
    // No ariaLabel: the picker sits in the dialog shell, whose heading names the dialog.
    expect(ctx.dialog.openAndWait$).toHaveBeenCalledWith(
      ReactionPickerComponent,
    );
  });

  it('does not react when the picker is dismissed', () => {
    const picked = new Subject<string | null>();
    const ctx = setup({
      dialog: { open: vi.fn(), openAndWait$: () => picked } as never,
    });

    dispatchSharedRowAction({ type: 'react-more' }, row, ctx);
    picked.next(null);

    expect(ctx.react).not.toHaveBeenCalled();
  });

  it('shows the raw event JSON, and does nothing when it is not loaded', () => {
    const ctx = setup();
    dispatchSharedRowAction({ type: 'view-source' }, row, ctx);
    expect(ctx.dialog.open).toHaveBeenCalledWith(
      MessageSourceComponent,
      expect.objectContaining({
        inputs: {
          source: JSON.stringify({ type: 'm.room.message' }, null, 2),
        },
      }),
    );

    const missing = setup({ timeline: { rawEvent: () => null } as never });
    dispatchSharedRowAction({ type: 'view-source' }, row, missing);
    expect(missing.dialog.open).not.toHaveBeenCalled();
  });

  it('opens forward, report, reactors and edit history for the room', () => {
    const ctx = setup();

    dispatchSharedRowAction({ type: 'forward' }, row, ctx);
    dispatchSharedRowAction({ type: 'report' }, row, ctx);
    dispatchSharedRowAction({ type: 'reactors' }, row, ctx);
    dispatchSharedRowAction({ type: 'edit-history' }, row, ctx);

    expect(ctx.forward.forward$).toHaveBeenCalledWith('!r:hs', '$e');
    expect(ctx.report.report$).toHaveBeenCalledWith('!r:hs', '$e');
    expect(ctx.reactions.open$).toHaveBeenCalledWith('$e');
    expect(ctx.editHistory.openHistory$).toHaveBeenCalledWith('!r:hs', '$e');
  });

  it('reports a message as the account that sees the conversation', () => {
    const ctx = setup({ accountId: '@me:hs' });

    dispatchSharedRowAction({ type: 'report' }, row, ctx);

    expect(ctx.report.report$).toHaveBeenCalledWith(
      { accountId: '@me:hs', roomId: '!r:hs' },
      '$e',
    );
  });

  it('reports a permalink followed out of the edit history', () => {
    const target = { kind: 'user', userId: '@a:hs' } as never;
    const followed = vi.fn();
    const ctx = setup({
      editHistory: { openHistory$: () => of(target) } as never,
      onHistoryLink: followed,
    });

    dispatchSharedRowAction({ type: 'edit-history' }, row, ctx);

    expect(followed).toHaveBeenCalledWith(target);
  });
});

describe('row caps', () => {
  const policy: RowCapsPolicy = {
    canRedactOthers: false,
    canPin: true,
    canThread: true,
    pinnedIds: [],
    canAddToEmoji: (message) => message.id !== '$owned',
  };
  const text = (id: string, over: Partial<MessageRow> = {}) =>
    ({
      id,
      kind: 'text',
      body: 'hello',
      isOwn: false,
      status: null,
      media: null,
      ...over,
    }) as MessageRow;

  it('lets a moderator delete others but never a local echo', () => {
    const moderator = { ...policy, canRedactOthers: true };

    expect(buildRowCaps(text('$a'), moderator).deletable).toBe(true);
    expect(buildRowCaps(text('$a'), policy).deletable).toBe(false);
    expect(buildRowCaps(text('$a', { isOwn: true }), policy).deletable).toBe(
      true,
    );
    expect(
      buildRowCaps(text('$a', { isOwn: true, status: 'sending' }), policy)
        .deletable,
    ).toBe(false);
  });

  it('waits to pin or thread a local echo and honours the policy', () => {
    const echo = text('~!r:hs:1', { status: 'sending' });

    expect(buildRowCaps(echo, policy)).toMatchObject({
      canPin: false,
      canThread: false,
    });
    expect(buildRowCaps(text('$a'), policy)).toMatchObject({
      canPin: true,
      canThread: true,
    });
    expect(
      buildRowCaps(text('$a'), { ...policy, canPin: false, canThread: false }),
    ).toMatchObject({ canPin: false, canThread: false });
    expect(
      buildRowCaps(text('$a'), { ...policy, pinnedIds: ['$a'] }).pinned,
    ).toBe(true);
  });

  it('offers Forward only for a message a forward can carry', () => {
    const forwardable = (over: Partial<MessageRow>) =>
      buildRowCaps(text('$a', over), policy).canForward;

    for (const kind of [
      'text',
      'emote',
      'notice',
      'image',
      'file',
      'video',
      'audio',
      'sticker',
      'location',
    ] as const) {
      expect(forwardable({ kind })).toBe(true);
    }
    for (const kind of ['poll', 'unsupported', 'redacted', 'event'] as const) {
      expect(forwardable({ kind })).toBe(false);
    }
    expect(forwardable({ decryptionFailed: true })).toBe(false);
  });

  it('offers "Add to my emoji" on a sent message the host allows', () => {
    const offered = (id: string, over: Partial<MessageRow> = {}) =>
      buildRowCaps(text(id, { kind: 'sticker', ...over }), policy).addToEmoji;

    expect(offered('$fox')).toBe(true);
    expect(offered('$owned')).toBe(false);
    expect(offered('$fox', { status: 'sending' })).toBe(false);
  });

  it('addable: a sticker or a text with an emoji not in the pack yet', () => {
    const adder = { canAdd: (mxc: string) => mxc !== 'mxc://hs/owned' };
    const events = new Map<string, object>();
    const rawEvent = vi.fn(
      (_room: string, id: string) => events.get(id) ?? null,
    );
    const addable = addableImages(adder, { rawEvent }, '!r:hs');
    const sticker = (url: string, type = 'm.sticker') => {
      events.set('$e', { type, content: { url, body: 'Fox' } });
      return addable(text('$e', { kind: 'sticker' }));
    };
    const emoji = (...urls: string[]) =>
      addable(
        text('$t', {
          html: urls
            .map(
              (url) =>
                `<img data-mx-emoticon="" alt=":x:" class="mx-emoticon" data-mx-src="${url}" height="32">`,
            )
            .join(''),
        }),
      );

    expect(sticker('mxc://hs/fox')).toBe(true);
    expect(sticker('mxc://hs/owned')).toBe(false);
    expect(sticker('mxc://hs/fox', 'm.room.message')).toBe(false);
    expect(sticker('https://example.org/fox.png')).toBe(false);
    expect(addable(text('$missing', { kind: 'sticker' }))).toBe(false);
    expect(rawEvent).toHaveBeenCalledWith('!r:hs', '$e');

    expect(emoji('mxc://hs/owned', 'mxc://hs/wave')).toBe(true);
    expect(emoji('mxc://hs/owned')).toBe(false);
    expect(emoji()).toBe(false);
    expect(addable(text('$plain'))).toBe(false);
  });

  it('compares every capability', () => {
    const caps = buildRowCaps(text('$a'), policy);
    expect(sameRowCaps(caps, { ...caps, canForward: !caps.canForward })).toBe(
      false,
    );

    expect(sameRowCaps(caps, { ...caps })).toBe(true);
    expect(sameRowCaps(caps, { ...caps, pinned: true })).toBe(false);
    expect(sameRowCaps(caps, { ...caps, saveMedia: 'image' })).toBe(false);
    expect(sameRowCaps(caps, { ...caps, addToEmoji: !caps.addToEmoji })).toBe(
      false,
    );
  });

  it('reuses the previous caps object for rows that did not change', () => {
    const first = buildRowCapsMap([text('$1'), text('$2')], policy, new Map());

    const next = buildRowCapsMap(
      [text('$1'), text('$2', { isOwn: true })],
      policy,
      first,
    );

    expect(next.get('$1')).toBe(first.get('$1'));
    expect(next.get('$2')).not.toBe(first.get('$2'));
  });
});
