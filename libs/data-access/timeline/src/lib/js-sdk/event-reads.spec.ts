import { describe, expect, it } from 'vitest';
import {
  ConnectionError,
  EventStatus,
  MatrixError,
  MatrixEvent as SdkMatrixEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { MAX_NAMED_REACTORS } from '@trinity/util/matrix';
import {
  collectMessageSenders,
  isDisplayableMessage,
  mapStatus,
  reactionDetailsFor,
  reactionsFor,
  readReceiptsFor,
  replyPreview,
} from './event-reads';

/** A reaction (`m.annotation`) event stub: only sender, redaction and timestamp are read. */
function reaction(sender: string, redacted = false, ts = 0): MatrixEvent {
  return {
    getSender: () => sender,
    isRedacted: () => redacted,
    getTs: () => ts,
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

  it('counts each sender once per key, and orders keys by those counts', () => {
    const room = reactedRoom(
      {
        '✅ Verified': [
          reaction('@mallory:hs'),
          reaction('@mallory:hs'),
          reaction('@mallory:hs'),
        ],
        '👍': [reaction('@alice:hs'), reaction('@bob:hs')],
      },
      {
        '@mallory:hs': { name: 'Mallory' },
        '@alice:hs': { name: 'Alice' },
        '@bob:hs': { name: 'Bob' },
      },
    );

    const pills = reactionsFor(ME, room, REACTED_MESSAGE);

    expect(pills.map((p) => [p.key, p.count])).toEqual([
      ['👍', 2],
      ['✅ Verified', 1],
    ]);
    expect(pills[1].reactors).toEqual(['Mallory']);
  });
});

describe('reaction key order', () => {
  it('breaks a tie by the key seen first, not by how many events it has', () => {
    // The SDK sorts by raw event count, so one sender's repeats put their key first.
    const room = reactedRoom({
      '🚩': Array.from({ length: 50 }, () => reaction('@mallory:hs', false, 5)),
      '👍': [reaction('@alice:hs', false, 1)],
    });

    expect(reactionsFor(ME, room, REACTED_MESSAGE).map((p) => p.key)).toEqual([
      '👍',
      '🚩',
    ]);
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

  it('lists a sender who reacted twice with the same key once', () => {
    const room = reactedRoom(
      { '👍': [reaction('@alice:hs'), reaction('@alice:hs')] },
      { '@alice:hs': { name: 'Alice' } },
    );

    expect(
      reactionDetailsFor(ME, room, REACTED_MESSAGE)[0].reactors.map(
        (r) => r.userId,
      ),
    ).toEqual(['@alice:hs']);
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
      getType: () => 'm.room.message',
      isRedacted: () => false,
      replacingEvent: () => null,
      getOriginalContent: () => ({}),
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
      getType: () => 'm.room.message',
      isRedacted: () => false,
      replacingEvent: () => null,
      getOriginalContent: () => ({}),
    } as unknown as MatrixEvent;
    const senders = new Set<string>();

    collectMessageSenders(ME, room, message, senders);

    // Not ourselves: our own receipt is never rendered, so nothing depends on it.
    expect([...senders]).toEqual(['@author:hs', '@reader:hs']);
  });

  it('registers the users a mention pill names', () => {
    const message = {
      getId: () => '$m',
      getSender: () => '@author:hs',
      getType: () => 'm.room.message',
      isRedacted: () => false,
      replacingEvent: () => null,
      getOriginalContent: () => ({
        format: 'org.matrix.custom.html',
        formatted_body: '<a href="https://matrix.to/#/@named:hs">@Someone</a>',
      }),
    } as unknown as MatrixEvent;
    const senders = new Set<string>();

    collectMessageSenders(ME, reactedRoom({}), message, senders);

    expect([...senders]).toEqual(['@author:hs', '@named:hs']);
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
      getType: () => 'm.room.message',
    } as unknown as MatrixEvent;

    expect(readReceiptsFor(ME, room, message).map((r) => r.userId)).toEqual([
      '@reader:hs',
    ]);
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

describe('replyPreview', () => {
  const roomWith = (
    over: {
      encrypted?: boolean;
      redacted?: boolean;
      status?: string | null;
      ts?: number;
      encryptedAt?: number;
    } = {},
  ) =>
    ({
      findEventById: () =>
        ({
          getSender: () => '@a:hs',
          getOriginalContent: () => ({ body: 'sign in here' }),
          getTs: () => over.ts ?? 200,
          isRedacted: () => over.redacted ?? false,
          isEncrypted: () => over.encrypted ?? false,
          isState: () => false,
          replacingEvent: () => null,
          status: over.status ?? null,
        }) as unknown as MatrixEvent,
      getMember: () => null,
      getLiveTimeline: () => ({
        getState: () => ({
          getStateEvents: () =>
            over.encryptedAt === undefined
              ? null
              : { getTs: () => over.encryptedAt },
        }),
      }),
    }) as unknown as Room;

  it('quotes text that arrived unencrypted in an encrypted room, marked unencrypted', () => {
    expect(replyPreview(roomWith(), '$t', true)).toMatchObject({
      body: 'sign in here',
      mark: 'unencrypted',
    });
  });

  it('marks it unencrypted-history when it predates the encryption event', () => {
    expect(
      replyPreview(roomWith({ ts: 100, encryptedAt: 150 }), '$t', true)?.mark,
    ).toBe('unencrypted-history');
  });

  it('leaves encrypted text, an unencrypted room, a local echo and a redaction unmarked', () => {
    expect(
      replyPreview(roomWith({ encrypted: true }), '$t', true),
    ).toMatchObject({ body: 'sign in here', mark: null });
    expect(replyPreview(roomWith(), '$t', false)).toMatchObject({
      body: 'sign in here',
      mark: null,
    });
    expect(
      replyPreview(roomWith({ status: 'sending' }), '$t', true)?.mark,
    ).toBeNull();
    expect(
      replyPreview(roomWith({ redacted: true }), '$t', true),
    ).toMatchObject({ body: '(message deleted)', mark: null });
  });

  it('judges the mark on the subject whose text is shown', () => {
    const encryptedEdit = {
      isEncrypted: () => true,
      isState: () => false,
      isRedacted: () => false,
      status: null,
    } as unknown as MatrixEvent;
    expect(
      replyPreview(roomWith(), '$t', true, undefined, () => encryptedEdit)
        ?.mark,
    ).toBeNull();
  });
});

describe('mapStatus', () => {
  const notSent = (error: unknown): MatrixEvent => {
    const event = new SdkMatrixEvent({
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'hi' },
    });
    event.status = EventStatus.NOT_SENT;
    event.error = error as MatrixError;
    return event;
  };

  it('is waiting for a NOT_SENT echo that failed only because it was offline', () => {
    expect(mapStatus(notSent(new ConnectionError('offline')))).toBe('waiting');
  });

  it('is failed for every other NOT_SENT echo', () => {
    expect(mapStatus(notSent(new Error('refused')))).toBe('failed');
  });
});

describe('replyPreview of an edited message', () => {
  const ALICE = '@alice:hs';
  const MALLORY = '@mallory:hs';

  /** A real SDK message, in the clear unless `encrypted`, when it is sealed as sent. */
  function sdkMessage(
    id: string,
    content: Record<string, unknown>,
    { sender = ALICE, encrypted = false } = {},
  ): MatrixEvent {
    const event = new SdkMatrixEvent({
      event_id: id,
      room_id: '!r:hs',
      sender,
      type: 'm.room.message',
      origin_server_ts: 1000,
      content,
    });
    if (encrypted) {
      // `m.relates_to` travels outside the ciphertext, as the spec requires.
      const relation = content['m.relates_to'];
      event.makeEncrypted(
        'm.room.encrypted',
        {
          algorithm: 'm.megolm.v1.aes-sha2',
          ciphertext: 'sealed',
          ...(relation ? { 'm.relates_to': relation } : {}),
        },
        'curve',
        'ed',
      );
    }
    return event;
  }

  /** An `m.replace` of `target`, with the parts a test can get wrong. */
  function sdkEdit(
    target: string,
    body: string,
    opts: { sender?: string; encrypted?: boolean; newContent?: unknown } = {},
  ): MatrixEvent {
    const { sender = ALICE, encrypted = false } = opts;
    const newContent =
      'newContent' in opts ? opts.newContent : { msgtype: 'm.text', body };
    return sdkMessage(
      `${target}~${sender}~${body}`,
      {
        msgtype: 'm.text',
        body: `* ${body}`,
        ...(newContent === undefined ? {} : { 'm.new_content': newContent }),
        'm.relates_to': { rel_type: 'm.replace', event_id: target },
      },
      { sender, encrypted },
    );
  }

  function editedWith(edit: MatrixEvent, encrypted = false): MatrixEvent {
    const event = sdkMessage(
      '$orig',
      { msgtype: 'm.text', body: 'v1' },
      { encrypted },
    );
    event.makeReplaced(edit);
    return event;
  }

  const roomWith = (target: MatrixEvent) =>
    ({
      roomId: '!r:hs',
      findEventById: () => target,
      getMember: () => null,
    }) as unknown as Room;
  const forged = () =>
    editedWith(sdkEdit('$orig', 'forged', { sender: MALLORY }));

  it('shows a valid edit', () => {
    const event = editedWith(sdkEdit('$orig', 'v2'));

    expect(replyPreview(roomWith(event), '$orig', false)?.body).toBe('v2');
  });

  it('shows the original over an edit from another sender', () => {
    expect(replyPreview(roomWith(forged()), '$orig', false)?.body).toBe('v1');
  });

  it('shows an encrypted message over its unencrypted edit', () => {
    const event = editedWith(sdkEdit('$orig', 'v2'), true);

    expect(replyPreview(roomWith(event), '$orig', false)?.body).toBe('v1');
  });
});
