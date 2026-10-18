import { describe, expect, it } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import {
  MAX_NAMED_REACTORS,
  collectMessageSenders,
  isDisplayableMessage,
  normalizeMediaPayload,
  reactionDetailsFor,
  reactionsFor,
  readReceiptsFor,
} from './message-view';

/** A reaction (`m.annotation`) event stub: only sender + redaction are read. */
function reaction(sender: string, redacted = false): MatrixEvent {
  return {
    getSender: () => sender,
    isRedacted: () => redacted,
  } as unknown as MatrixEvent;
}

/** A room whose relations return `byKey`, with `members` resolving display names. */
function reactedRoom(
  byKey: Record<string, MatrixEvent[]>,
  members: Record<string, { name: string; avatar?: string }> = {},
): Room {
  const annotations = new Map(
    Object.entries(byKey).map(([key, events]) => [key, new Set(events)]),
  );
  return {
    relations: {
      getChildEventsForEvent: () => ({
        getSortedAnnotationsByKey: () => annotations,
      }),
    },
    getMember: (userId: string) => {
      const member = members[userId];
      return member
        ? { name: member.name, getMxcAvatarUrl: () => member.avatar ?? null }
        : null;
    },
    findEventById: () => undefined,
  } as unknown as Room;
}

const REACTED_MESSAGE = { getId: () => '$m' } as unknown as MatrixEvent;
const ME = { getUserId: () => '@me:hs' } as unknown as MatrixClient;

describe('reactionsFor', () => {
  it('names the first few reactors, the local user first as "You"', () => {
    const room = reactedRoom(
      {
        '👍': [
          reaction('@alice:hs'),
          reaction('@me:hs'),
          reaction('@bob:hs'),
          reaction('@carol:hs'),
          reaction('@dave:hs'),
        ],
      },
      {
        '@alice:hs': { name: 'Alice' },
        '@bob:hs': { name: 'Bob' },
        '@carol:hs': { name: 'Carol' },
      },
    );

    const [pill] = reactionsFor(ME, room, REACTED_MESSAGE);

    expect(pill.count).toBe(5);
    expect(pill.reacted).toBe(true);
    // Capped at MAX_NAMED_REACTORS, "You" ahead of the rest; the tail is "and N others".
    expect(pill.reactors).toEqual(['You', 'Alice', 'Bob']);
    expect(pill.reactors.length).toBe(MAX_NAMED_REACTORS);
  });

  it('falls back to the mxid for a member who has not loaded yet', () => {
    const room = reactedRoom({ '🎉': [reaction('@ghost:hs')] });

    expect(reactionsFor(ME, room, REACTED_MESSAGE)[0].reactors).toEqual([
      '@ghost:hs',
    ]);
  });

  it('ignores redacted reactions, and drops a key once all of them are gone', () => {
    const room = reactedRoom(
      {
        '👍': [reaction('@alice:hs'), reaction('@bob:hs', true)],
        '❤️': [reaction('@bob:hs', true)],
      },
      { '@alice:hs': { name: 'Alice' } },
    );

    const pills = reactionsFor(ME, room, REACTED_MESSAGE);

    expect(pills.map((p) => p.key)).toEqual(['👍']);
    expect(pills[0].count).toBe(1);
    expect(pills[0].reacted).toBe(false);
    expect(pills[0].reactors).toEqual(['Alice']);
  });
});

describe('reactionDetailsFor', () => {
  it('lists every reactor per key, resolved for display', () => {
    const room = reactedRoom(
      {
        '👍': [reaction('@alice:hs'), reaction('@me:hs'), reaction('@bob:hs')],
        '❤️': [reaction('@alice:hs')],
      },
      {
        '@alice:hs': { name: 'Alice', avatar: 'mxc://hs/a' },
        '@bob:hs': { name: 'Bob' },
        '@me:hs': { name: 'Me' },
      },
    );

    const details = reactionDetailsFor(ME, room, REACTED_MESSAGE);

    expect(details.map((d) => d.key)).toEqual(['👍', '❤️']);
    // Uncapped, unlike the pill's hint — this is the full "who reacted" list.
    expect(details[0].reactors.map((r) => r.name)).toEqual([
      'Alice',
      'Me',
      'Bob',
    ]);
    expect(details[0].reacted).toBe(true);
    expect(details[0].reactors[0]).toEqual({
      userId: '@alice:hs',
      name: 'Alice',
      initial: 'A',
      avatarMxc: 'mxc://hs/a',
    });
    expect(details[1].reactors.map((r) => r.userId)).toEqual(['@alice:hs']);
    expect(details[1].reacted).toBe(false);
  });

  it('skips redacted reactions', () => {
    const room = reactedRoom(
      { '👍': [reaction('@alice:hs'), reaction('@bob:hs', true)] },
      { '@alice:hs': { name: 'Alice' }, '@bob:hs': { name: 'Bob' } },
    );

    expect(
      reactionDetailsFor(ME, room, REACTED_MESSAGE)[0].reactors,
    ).toHaveLength(1);
  });
});

describe('collectMessageSenders', () => {
  it('registers the reactors a pill names, so their late profiles re-map the row', () => {
    // Only the named ones: nobody past the cap renders, so nobody past it needs to
    // pass the member-listener gate (see TimelineService.relevantSenders).
    const room = reactedRoom({
      '👍': [
        reaction('@alice:hs'),
        reaction('@bob:hs'),
        reaction('@carol:hs'),
        reaction('@dave:hs'),
      ],
    });
    const message = {
      getId: () => '$m',
      getSender: () => '@author:hs',
    } as unknown as MatrixEvent;
    const senders = new Set<string>();

    collectMessageSenders(ME, room, message, senders);

    expect([...senders]).toEqual([
      '@author:hs',
      '@alice:hs',
      '@bob:hs',
      '@carol:hs',
    ]);
  });

  it('registers the readers whose "seen by" avatars the row shows', () => {
    // A reader who has never posted in the loaded window is nobody's sender, reply
    // target or reactor, so this is the only thing that can put them through the
    // member-listener gate — and their receipt renders an avatar just like a sender.
    const room = {
      ...reactedRoom({}),
      getUsersReadUpTo: () => ['@reader:hs', '@me:hs'],
    } as unknown as Room;
    const message = {
      getId: () => '$m',
      getSender: () => '@author:hs',
    } as unknown as MatrixEvent;
    const senders = new Set<string>();

    collectMessageSenders(ME, room, message, senders);

    // Not ourselves: our own receipt is never rendered, so nothing depends on it.
    expect([...senders]).toEqual(['@author:hs', '@reader:hs']);
  });
});

describe('readReceiptsFor', () => {
  it("leaves the author out of their own message's seen-by list", () => {
    // The SDK counts the sender as having read their own event; that receipt says nothing.
    const room = {
      ...reactedRoom({}),
      getUsersReadUpTo: () => ['@author:hs', '@reader:hs', '@me:hs'],
    } as unknown as Room;
    const message = {
      getId: () => '$m',
      getSender: () => '@author:hs',
    } as unknown as MatrixEvent;

    expect(readReceiptsFor(ME, room, message).map((r) => r.userId)).toEqual([
      '@reader:hs',
    ]);
  });
});

describe('normalizeMediaPayload — display types', () => {
  const media = (
    msgtype: string,
    info: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    normalizeMediaPayload(
      { msgtype, body: 'attachment', url: 'mxc://hs/a', info, ...extra },
      msgtype,
    );

  it.each([
    'image/svg+xml',
    'image/svg+xml; charset=utf-8',
    'image/svg+xml;',
    'image/svg+xml ',
    ' Image/SVG+XML ;charset=utf-8',
    'text/html; charset=utf-8',
    'application/xhtml+xml; charset=utf-8',
    'text/xml',
  ])('lists an m.image declaring %j as a download-only file', (mimetype) => {
    expect(media('m.image', { mimetype })?.kind).toBe('file');
  });

  it.each([
    ['a trailing comma', 'image/svg+xml,'],
    ['a NUL suffix', 'image/png\u0000'],
    ['a NUL suffix after a parameter', 'image/svg+xml\u0000; charset=utf-8'],
    ['a zero-width-space suffix', 'image/png\u200b'],
    ['a zero-width-space prefix', '\u200bimage/png'],
    ['a quoted type', '"image/png"'],
    ['an embedded newline', 'image/png\nimage/svg+xml'],
    ['a comma-separated list', 'image/png,text/html'],
    ['a quoted parameter on a document type', 'image/svg+xml; name="a;b"'],
    ['a missing subtype', 'image/'],
  ])('lists an m.image declaring %s as a download-only file', (_, mimetype) => {
    expect(media('m.image', { mimetype })?.kind).toBe('file');
  });

  it.each([
    ['m.video', 'video/mp4\u0000'],
    ['m.video', 'video/mp4,'],
    ['m.audio', 'audio/ogg\u200b; codecs=opus'],
    ['m.audio', 'audio/ogg,'],
  ])(
    'lists an %s declaring %j as a download-only file',
    (msgtype, mimetype) => {
      expect(media(msgtype, { mimetype })?.kind).toBe('file');
    },
  );

  it('keeps an m.image with a quoted parameter containing a semicolon inline', () => {
    expect(media('m.image', { mimetype: 'image/png; name="a;b"' })?.kind).toBe(
      'image',
    );
  });

  it.each(['image/png', 'image/jpeg; q=0.9', ' IMAGE/WEBP ', 'image/gif;'])(
    'keeps an m.image declaring %j inline',
    (mimetype) => {
      expect(media('m.image', { mimetype })?.kind).toBe('image');
    },
  );

  it('keeps a voice message declaring audio/ogg; codecs=opus as inline audio', () => {
    const voice = media(
      'm.audio',
      { mimetype: 'audio/ogg; codecs=opus', duration: 1200 },
      { 'org.matrix.msc3245.voice': {} },
    );

    expect(voice?.kind).toBe('audio');
    expect(voice?.isVoice).toBe(true);
  });

  it('does not carry a thumbnail type outside the display allowlist', () => {
    const payload = media('m.image', {
      mimetype: 'image/png',
      thumbnail_url: 'mxc://hs/thumb',
      thumbnail_info: { mimetype: 'image/svg+xml; charset=utf-8' },
    });

    expect(payload?.thumbnailMimeType).toBe('application/octet-stream');
  });

  it('keeps an allowlisted thumbnail type and leaves an undeclared one unset', () => {
    const declared = media('m.image', {
      thumbnail_url: 'mxc://hs/thumb',
      thumbnail_info: { mimetype: 'image/jpeg' },
    });
    const undeclared = media('m.image', { thumbnail_url: 'mxc://hs/thumb' });

    expect(declared?.thumbnailMimeType).toBe('image/jpeg');
    expect(undeclared?.thumbnailMimeType).toBeUndefined();
  });
});

describe('isDisplayableMessage', () => {
  /** Only the reads isDisplayableMessage makes. */
  const event = (o: {
    type: string;
    state?: boolean;
    replace?: boolean;
  }): MatrixEvent =>
    ({
      getType: () => o.type,
      isState: () => o.state ?? false,
      isRelation: (relType?: string) =>
        o.replace === true &&
        (relType === undefined || relType === 'm.replace'),
    }) as unknown as MatrixEvent;

  it('accepts a message, a sticker and a poll start', () => {
    expect(isDisplayableMessage(event({ type: 'm.room.message' }))).toBe(true);
    expect(isDisplayableMessage(event({ type: 'm.sticker' }))).toBe(true);
    expect(isDisplayableMessage(event({ type: 'm.poll.start' }))).toBe(true);
  });

  it('rejects an edit', () => {
    expect(
      isDisplayableMessage(event({ type: 'm.room.message', replace: true })),
    ).toBe(false);
  });

  // A state event is never a message row, whatever its type says: a state key makes it
  // room state, and nothing about its sender or timing makes it a conversation turn.
  it.each(['m.room.message', 'm.sticker', 'm.poll.start'])(
    'rejects a state event of type %s',
    (type) => {
      expect(isDisplayableMessage(event({ type, state: true }))).toBe(false);
    },
  );
});
