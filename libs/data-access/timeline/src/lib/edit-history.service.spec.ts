import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { Direction, EventType, MatrixEvent, RelationType } from 'matrix-js-sdk';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  EMPTY_SESSION,
  MatrixClientService,
  SESSION_SNAPSHOT,
} from '@trinity/data-access/matrix-client';
import { EngineRequestError, UNDECRYPTABLE_BODY } from '@trinity/util/matrix';
import { EditHistoryService } from './edit-history.service';

const SENDER = '@alice:hs';

function original(
  over: {
    redacted?: boolean;
    replacing?: MatrixEvent | null;
    makeReplaced?: (event?: MatrixEvent) => void;
    encrypted?: boolean;
  } = {},
): MatrixEvent {
  return {
    isEncrypted: () => over.encrypted ?? false,
    isState: () => false,
    getId: () => '$orig',
    getTs: () => 1000,
    getSender: () => SENDER,
    getType: () => 'm.room.message',
    isRedacted: () => over.redacted ?? false,
    isDecryptionFailure: () => false,
    getContent: () => ({ msgtype: 'm.text', body: 'latest' }),
    getOriginalContent: () => ({ msgtype: 'm.text', body: 'v1' }),
    isRelation: () => false,
    status: null,
    // The room's copy is what repairAggregation re-points at the surviving edit.
    replacingEvent: () => over.replacing ?? null,
    makeReplaced: over.makeReplaced ?? (() => undefined),
  } as unknown as MatrixEvent;
}

function edit(
  id: string,
  body: string,
  sender = SENDER,
  encrypted = false,
  formattedBody?: string,
): MatrixEvent {
  const html = formattedBody
    ? { format: 'org.matrix.custom.html', formatted_body: formattedBody }
    : {};
  const content = {
    msgtype: 'm.text',
    body: `* ${body}`,
    'm.new_content': { msgtype: 'm.text', body, ...html },
    'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
  };
  return {
    isEncrypted: () => encrypted,
    isState: () => false,
    replacingEvent: () => null,
    getId: () => id,
    getTs: () => 2000 + id.length,
    getSender: () => sender,
    getType: () => 'm.room.message',
    isRedacted: () => false,
    isDecryptionFailure: () => false,
    // Settled: an encrypted edit has been decrypted.
    getClearContent: () => (encrypted ? content : null),
    getContent: () => content,
    getOriginalContent: () => content,
    getRelation: () => ({ rel_type: 'm.replace', event_id: '$orig' }),
    status: null,
  } as unknown as MatrixEvent;
}

/**
 * A fake client whose `relations()` replays `pages` in order. Each page is what the SDK
 * hands back: the resolved original (or null), its chunk, and the next token.
 */
function setup(
  pages: {
    originalEvent?: MatrixEvent | null;
    events: MatrixEvent[];
    nextBatch?: string | null;
  }[],
  opts: {
    roomEvent?: MatrixEvent | null;
    /** The active account; null when nobody is signed in. */
    activeAccountId?: string | null;
    /** Whether the active account has a live client. */
    live?: boolean;
    members?: Record<string, string>;
    /** The room's own copy of the message — what repairAggregation re-points. */
    timelineCopy?: MatrixEvent | null;
    roomEncrypted?: boolean;
  } = {},
) {
  let call = 0;
  // Parameter list mirrors the SDK's, so the `mock.calls[n][4]` pagination assertions
  // below are typed against the real argument positions rather than an empty tuple.
  const relations = vi.fn(
    async (
      _roomId: string,
      _eventId: string,
      _relationType: RelationType,
      _eventType: EventType,
      _opts: { dir?: Direction; limit?: number; from?: string },
    ) => pages[Math.min(call++, pages.length - 1)],
  );
  const redactEvent = vi.fn().mockResolvedValue({ event_id: '$redaction' });
  const client = {
    relations,
    redactEvent,
    getUserId: () => SENDER,
    getRoom: () => ({
      roomId: '!r:hs',
      findEventById: () => opts.timelineCopy ?? opts.roomEvent ?? null,
      hasEncryptionStateEvent: () => opts.roomEncrypted ?? false,
      getLiveTimeline: () => ({ getState: () => undefined }),
      getMember: (userId: string) => {
        const name = opts.members?.[userId];
        return name ? { name, getMxcAvatarUrl: () => null } : null;
      },
    }),
    getCrypto: () => null,
  };
  const session = signal({
    ...EMPTY_SESSION,
    activeAccountId:
      opts.activeAccountId === undefined ? SENDER : opts.activeAccountId,
  });
  TestBed.configureTestingModule({
    providers: [
      MockProvider(MatrixClientService, {
        clientFor: (accountId: string) =>
          accountId === SENDER && (opts.live ?? true)
            ? (client as unknown as MatrixClient)
            : null,
      } as Partial<MatrixClientService>),
      { provide: SESSION_SNAPSHOT, useValue: session },
    ],
  });
  return {
    svc: TestBed.inject(EditHistoryService),
    relations,
    redactEvent,
    session,
  };
}

describe('EditHistoryService', () => {
  it('returns the original then its edits, oldest first', async () => {
    const { svc } = setup([
      {
        originalEvent: original(),
        events: [edit('$b', 'v3'), edit('$a', 'v2')],
        nextBatch: null,
      },
    ]);

    const { revisions, truncated } = await firstValueFrom(
      svc.revisions('!r:hs', '$orig'),
    );

    expect(revisions.map((r) => r.body)).toEqual(['v1', 'v2', 'v3']);
    expect(truncated).toBe(false);
  });

  it('marks each version that arrived unencrypted in an encrypted room', async () => {
    const { svc } = setup(
      [
        {
          originalEvent: original(),
          events: [edit('$a', 'v2'), edit('$bb', 'v3', SENDER, true)],
          nextBatch: null,
        },
      ],
      { roomEncrypted: true },
    );

    const { revisions } = await firstValueFrom(svc.revisions('!r:hs', '$orig'));

    expect(revisions.map((r) => [r.body, r.shield?.level ?? null])).toEqual([
      ['v1', 'unencrypted'],
      ['v2', 'unencrypted'],
      ['v3', null],
    ]);
  });

  it('leaves an unencrypted edit of an encrypted message out of its history', async () => {
    const { svc } = setup(
      [
        {
          originalEvent: original({ encrypted: true }),
          events: [edit('$a', 'v2'), edit('$bb', 'v3', SENDER, true)],
          nextBatch: null,
        },
      ],
      { roomEncrypted: true },
    );

    const { revisions } = await firstValueFrom(svc.revisions('!r:hs', '$orig'));

    expect(revisions.map((r) => r.body)).toEqual(['v1', 'v3']);
  });

  // Pass a null event type and the SDK skips decryption, so an encrypted room's history
  // comes back as ciphertext that no later rule can read. Pin the argument.
  it('asks for m.room.message so an encrypted room decrypts', async () => {
    const { svc, relations } = setup([
      { originalEvent: original(), events: [], nextBatch: null },
    ]);

    await firstValueFrom(svc.revisions('!r:hs', '$orig'));

    expect(relations).toHaveBeenCalledWith(
      '!r:hs',
      '$orig',
      RelationType.Replace,
      EventType.RoomMessage,
      expect.objectContaining({ dir: Direction.Backward }),
    );
  });

  it('follows the next token across pages', async () => {
    const { svc, relations } = setup([
      {
        originalEvent: original(),
        events: [edit('$a', 'v2')],
        nextBatch: 't1',
      },
      { originalEvent: null, events: [edit('$bb', 'v3')], nextBatch: null },
    ]);

    const { revisions, truncated } = await firstValueFrom(
      svc.revisions('!r:hs', '$orig'),
    );

    expect(relations).toHaveBeenCalledTimes(2);
    expect(relations.mock.calls[1][4]).toMatchObject({ from: 't1' });
    expect(revisions.map((r) => r.body)).toEqual(['v1', 'v2', 'v3']);
    expect(truncated).toBe(false);
  });

  // A truncated list that claims to be complete is worse than one that admits the gap.
  it('stops at the page cap and says the list is incomplete', async () => {
    const { svc, relations } = setup([
      {
        originalEvent: original(),
        events: [edit('$a', 'v2')],
        nextBatch: 'more',
      },
    ]);

    const { truncated } = await firstValueFrom(svc.revisions('!r:hs', '$orig'));

    expect(relations).toHaveBeenCalledTimes(10);
    expect(truncated).toBe(true);
  });

  it('falls back to the loaded timeline copy when the original is not returned', async () => {
    const { svc } = setup(
      [{ originalEvent: null, events: [edit('$a', 'v2')], nextBatch: null }],
      { roomEvent: original() },
    );

    const { revisions } = await firstValueFrom(svc.revisions('!r:hs', '$orig'));

    expect(revisions.map((r) => r.body)).toEqual(['v1', 'v2']);
  });

  // The SDK only filters edits by sender when it resolved the original itself; on the
  // fallback path above, ours is the only check standing between a stranger's m.replace
  // and text attributed to someone else.
  it('drops a foreign edit even when the SDK could not filter it', async () => {
    const { svc } = setup(
      [
        {
          originalEvent: null,
          events: [edit('$m', 'I confess', '@mallory:evil.example')],
          nextBatch: null,
        },
      ],
      { roomEvent: original() },
    );

    const { revisions } = await firstValueFrom(svc.revisions('!r:hs', '$orig'));

    expect(revisions.map((r) => r.body)).toEqual(['v1']);
  });

  it('refuses history for a deleted message', async () => {
    const { svc } = setup([
      {
        originalEvent: original({ redacted: true }),
        events: [edit('$a', 'v2')],
        nextBatch: null,
      },
    ]);

    await expect(
      firstValueFrom(svc.revisions('!r:hs', '$orig')),
    ).rejects.toThrow('This message was deleted.');
  });

  it('errors when the message cannot be found at all', async () => {
    const { svc } = setup([
      { originalEvent: null, events: [], nextBatch: null },
    ]);

    await expect(
      firstValueFrom(svc.revisions('!r:hs', '$gone')),
    ).rejects.toThrow('That message could not be loaded.');
  });

  for (const [state, opts] of [
    ['nobody is signed in', { activeAccountId: null }],
    ['the account is not live', { live: false }],
  ] as const) {
    it(`says it is not connected when ${state}`, async () => {
      const { svc, relations } = setup(
        [{ originalEvent: original(), events: [], nextBatch: null }],
        opts,
      );

      await expect(
        firstValueFrom(svc.revisions('!r:hs', '$orig')),
      ).rejects.toThrow('Not connected — try again in a moment.');
      expect(relations).not.toHaveBeenCalled();
    });
  }

  it('edit history follows the active account', async () => {
    const { svc, relations, session } = setup(
      [{ originalEvent: original(), events: [], nextBatch: null }],
      { activeAccountId: '@bob:hs' },
    );

    // Bob has no live client here, so his request never reaches Alice's.
    await expect(
      firstValueFrom(svc.revisions('!r:hs', '$orig')),
    ).rejects.toThrow(/not connected/i);
    expect(relations).not.toHaveBeenCalled();

    session.set({ ...EMPTY_SESSION, activeAccountId: SENDER });
    await firstValueFrom(svc.revisions('!r:hs', '$orig'));
    expect(relations).toHaveBeenCalledOnce();
  });

  describe('rendering', () => {
    it('renders a formatted version through the sanitizer', async () => {
      const { svc } = setup([
        {
          originalEvent: original(),
          events: [
            edit(
              '$a',
              'bold',
              SENDER,
              false,
              '<strong>bold</strong><script>alert(1)</script>',
            ),
          ],
          nextBatch: null,
        },
      ]);

      const { revisions } = await firstValueFrom(
        svc.revisions('!r:hs', '$orig'),
      );

      expect(revisions[1].html).toContain('<strong>bold</strong>');
      expect(revisions[1].html).not.toContain('script');
    });

    it('linkifies a plain-text version, as the timeline does', async () => {
      const { svc } = setup([
        {
          originalEvent: original(),
          events: [edit('$a', 'see https://example.com')],
          nextBatch: null,
        },
      ]);

      const { revisions } = await firstValueFrom(
        svc.revisions('!r:hs', '$orig'),
      );

      expect(revisions[1].html).toContain('href="https://example.com"');
    });

    it('names mention pills from the room, as the timeline does', async () => {
      const { svc } = setup(
        [
          {
            originalEvent: original(),
            events: [
              edit(
                '$a',
                'v2',
                SENDER,
                false,
                '<a href="https://matrix.to/#/@b:hs">@Boss</a>',
              ),
            ],
            nextBatch: null,
          },
        ],
        { members: { '@b:hs': 'Bob' } },
      );

      const { revisions } = await firstValueFrom(
        svc.revisions('!r:hs', '$orig'),
      );

      expect(revisions[1].html).toContain('>@Bob</a>');
    });

    it('marks the versions as yours when you sent the message', async () => {
      const { svc } = setup([
        { originalEvent: original(), events: [edit('$a', 'v2')] },
      ]);

      const { revisions } = await firstValueFrom(
        svc.revisions('!r:hs', '$orig'),
      );

      expect(revisions.map((r) => r.isOwn)).toEqual([true, true]);
    });

    it('marks them as not yours when someone else sent it', async () => {
      const { svc } = setup([
        {
          originalEvent: {
            ...original(),
            getSender: () => '@bob:hs',
          } as unknown as MatrixEvent,
          events: [edit('$a', 'v2', '@bob:hs')],
        },
      ]);

      const { revisions } = await firstValueFrom(
        svc.revisions('!r:hs', '$orig'),
      );

      expect(revisions.map((r) => r.isOwn)).toEqual([false, false]);
    });

    it('says so plainly when a version cannot be decrypted', async () => {
      const { svc } = setup([
        {
          originalEvent: {
            ...original(),
            isDecryptionFailure: () => true,
          } as unknown as MatrixEvent,
          events: [],
        },
      ]);

      const { revisions } = await firstValueFrom(
        svc.revisions('!r:hs', '$orig'),
      );

      expect(revisions).toMatchObject([
        { kind: 'undecryptable', body: UNDECRYPTABLE_BODY, html: null },
      ]);
    });
  });

  // Redacting an edit leaves the SDK resolving the message to the WRONG version — it
  // filters relations against a timestamp from the original's stale bundle and falls all
  // the way back to the first wording. Measured against a live server. Reading the history
  // is where we already know the right answer, so it is where the correction is applied.
  describe('repairing the message the room already holds', () => {
    function timelineCopy(over: { replacing?: MatrixEvent | null } = {}) {
      const makeReplaced = vi.fn();
      const copy = original({
        replacing: over.replacing ?? null,
        makeReplaced,
      });
      return { copy, makeReplaced };
    }

    it('re-points the message at the newest surviving edit', async () => {
      // The fixture derives a timestamp from the id's length, so these differ on purpose:
      // equal-length ids tie, and the tie-break is not what this test is about.
      const older = edit('$a', 'v2');
      const newest = edit('$bbbbb', 'v3');
      const { copy, makeReplaced } = timelineCopy();
      const { svc } = setup(
        [
          {
            originalEvent: original(),
            events: [older, newest],
            nextBatch: null,
          },
        ],
        { timelineCopy: copy },
      );

      await firstValueFrom(svc.revisions('!r:hs', '$orig'));

      expect(makeReplaced).toHaveBeenCalledWith(newest);
      expect(makeReplaced).toHaveBeenCalledOnce();
    });

    it('clears the replacement when no edit survives', async () => {
      const { copy, makeReplaced } = timelineCopy({
        replacing: edit('$gone', 'removed'),
      });
      const { svc } = setup(
        [{ originalEvent: original(), events: [], nextBatch: null }],
        { timelineCopy: copy },
      );

      await firstValueFrom(svc.revisions('!r:hs', '$orig'));

      // undefined, not null: that is what MatrixEvent.makeReplaced expects for "none".
      expect(makeReplaced).toHaveBeenCalledWith(undefined);
    });

    it('ignores redacted, foreign and unsent edits when choosing', async () => {
      // The foreign edit is the LATER one, so picking by timestamp alone would take it.
      const good = edit('$a', 'v2');
      const foreign = edit(
        '$mallory-long',
        'not mine',
        '@mallory:evil.example',
      );
      const { copy, makeReplaced } = timelineCopy();
      const { svc } = setup(
        [
          {
            originalEvent: original(),
            events: [good, foreign],
            nextBatch: null,
          },
        ],
        { timelineCopy: copy },
      );

      await firstValueFrom(svc.revisions('!r:hs', '$orig'));

      expect(makeReplaced).toHaveBeenCalledWith(good);
    });

    it('ignores a later edit of another message, or one with nothing to show, when choosing', async () => {
      const good = edit('$a', 'v2');
      const elsewhere = {
        ...edit('$elsewhere-long', 'v3'),
        getRelation: () => ({ rel_type: 'm.replace', event_id: '$other' }),
      } as unknown as MatrixEvent;
      const empty = {
        ...edit('$empty-longer', 'v4'),
        getOriginalContent: () => ({ msgtype: 'm.text', body: '* v4' }),
      } as unknown as MatrixEvent;
      const { copy, makeReplaced } = timelineCopy();
      const { svc } = setup(
        [
          {
            originalEvent: original(),
            events: [good, elsewhere, empty],
            nextBatch: null,
          },
        ],
        { timelineCopy: copy },
      );

      await firstValueFrom(svc.revisions('!r:hs', '$orig'));

      expect(makeReplaced).toHaveBeenCalledWith(good);
    });

    it('ignores a later edit whose only new content comes from an edit attached to it', async () => {
      const good = edit('$a', 'v2');
      const borrowed = new MatrixEvent({
        event_id: '$borrowed-long',
        room_id: '!r:hs',
        sender: SENDER,
        type: 'm.room.message',
        origin_server_ts: 9000,
        content: {
          msgtype: 'm.text',
          body: '* v3',
          'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
        },
      });
      borrowed.makeReplaced(
        new MatrixEvent({
          event_id: '$nested',
          sender: '@mallory:hs',
          type: 'm.room.message',
          content: {
            'm.new_content': {
              'm.new_content': { msgtype: 'm.text', body: 'FORGED' },
            },
          },
        }),
      );
      const { copy, makeReplaced } = timelineCopy();
      const { svc } = setup(
        [
          {
            originalEvent: original(),
            events: [good, borrowed],
            nextBatch: null,
          },
        ],
        { timelineCopy: copy },
      );

      await firstValueFrom(svc.revisions('!r:hs', '$orig'));

      expect(makeReplaced).toHaveBeenCalledWith(good);
    });

    // Re-applying the same answer would emit a pointless Replaced and re-render every
    // row of the timeline for nothing.
    it('leaves the message alone when it is already correct', async () => {
      const newest = edit('$new', 'v3');
      const { copy, makeReplaced } = timelineCopy({ replacing: newest });
      const { svc } = setup(
        [{ originalEvent: original(), events: [newest], nextBatch: null }],
        { timelineCopy: copy },
      );

      await firstValueFrom(svc.revisions('!r:hs', '$orig'));

      expect(makeReplaced).not.toHaveBeenCalled();
    });

    it('does nothing when the message is not in a loaded timeline', async () => {
      const { svc } = setup(
        [
          {
            originalEvent: original(),
            events: [edit('$e', 'v2')],
            nextBatch: null,
          },
        ],
        { timelineCopy: null },
      );

      // Nothing on screen to correct — and no crash for the missing copy.
      await expect(
        firstValueFrom(svc.revisions('!r:hs', '$orig')),
      ).resolves.toBeTruthy();
    });
  });

  describe('removeRevision', () => {
    it('redacts exactly the revision it was given, in the room it was given', async () => {
      const { svc, redactEvent } = setup([
        { originalEvent: original(), events: [], nextBatch: null },
      ]);

      await firstValueFrom(svc.removeRevision('!r:hs', '$edit'));

      // The room is passed explicitly rather than read from ambient state: the dialog
      // outlives a room switch, and TimelineService.redact quietly succeeds having sent
      // nothing when its context is gone.
      expect(redactEvent).toHaveBeenCalledWith('!r:hs', '$edit');
    });

    it('is cold — nothing is redacted until subscribe', async () => {
      const { svc, redactEvent } = setup([
        { originalEvent: original(), events: [], nextBatch: null },
      ]);

      const request = svc.removeRevision('!r:hs', '$edit');
      expect(redactEvent).not.toHaveBeenCalled();

      await firstValueFrom(request);
      expect(redactEvent).toHaveBeenCalledOnce();
    });

    it('errors rather than touching the client when nobody is signed in', async () => {
      const { svc, redactEvent } = setup(
        [{ originalEvent: original(), events: [], nextBatch: null }],
        { activeAccountId: null },
      );

      await expect(
        firstValueFrom(svc.removeRevision('!r:hs', '$edit')),
      ).rejects.toThrow(/not connected/i);
      expect(redactEvent).not.toHaveBeenCalled();
    });

    it('surfaces a rejected redaction rather than reporting success', async () => {
      const { svc, redactEvent } = setup([
        { originalEvent: original(), events: [], nextBatch: null },
      ]);
      redactEvent.mockRejectedValueOnce(new Error('M_FORBIDDEN'));

      const error = await firstValueFrom(
        svc.removeRevision('!r:hs', '$edit'),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EngineRequestError);
      expect((error as EngineRequestError).failure.code).toBe('request-failed');
    });
  });

  it('is cold — nothing is fetched until subscribe', async () => {
    const { svc, relations } = setup([
      { originalEvent: original(), events: [], nextBatch: null },
    ]);

    const request = svc.revisions('!r:hs', '$orig');
    expect(relations).not.toHaveBeenCalled();

    await firstValueFrom(request);
    expect(relations).toHaveBeenCalledOnce();
  });
});
