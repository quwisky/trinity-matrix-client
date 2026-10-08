import { DestroyRef } from '@angular/core';
import { of, Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageSourceComponent } from '../message-source/message-source.component';
import { ReactionPickerComponent } from '../reaction-picker/reaction-picker.component';
import { type MessageRow } from '../message-row/message-row.component';
import {
  buildRowCaps,
  buildRowCapsMap,
  dispatchSharedRowAction,
  sameRowCaps,
  type RowCapsPolicy,
  type SharedRowActionContext,
} from './row-actions';

const row = { id: '$e', body: 'hello' } as MessageRow;

function setup(overrides: Partial<SharedRowActionContext> = {}) {
  const ctx = {
    roomId: '!r:hs',
    destroyRef: { onDestroy: () => () => undefined } as unknown as DestroyRef,
    dialog: {
      open: vi.fn(),
      openAndWait$: vi.fn(() => of('🎉')),
    },
    timeline: { rawEvent: vi.fn(() => ({ type: 'm.room.message' })) },
    forward: { forward$: vi.fn(() => of(undefined)) },
    report: { report$: vi.fn(() => of(undefined)) },
    reactions: { open$: vi.fn(() => of(undefined)) },
    editHistory: { openHistory$: vi.fn(() => of(null)) },
    react: vi.fn(),
    quote: vi.fn(),
    mediaSave: { save: vi.fn() },
    ...overrides,
  };
  return ctx as typeof ctx & SharedRowActionContext;
}

describe('dispatchSharedRowAction', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('saves the row media through the shared save service', () => {
    const media = { id: 'm', kind: 'image' } as MessageRow['media'];
    const ctx = setup();

    expect(
      dispatchSharedRowAction({ type: 'save-media' }, { ...row, media }, ctx),
    ).toBe(true);

    expect(ctx.mediaSave.save).toHaveBeenCalledWith(media);
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

  it('compares every capability', () => {
    const caps = buildRowCaps(text('$a'), policy);

    expect(sameRowCaps(caps, { ...caps })).toBe(true);
    expect(sameRowCaps(caps, { ...caps, pinned: true })).toBe(false);
    expect(sameRowCaps(caps, { ...caps, saveMedia: 'image' })).toBe(false);
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
