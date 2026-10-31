import { describe, expect, it } from 'vitest';
import {
  ConnectionError,
  EventStatus,
  MatrixError,
  MatrixEvent as SdkMatrixEvent,
  createClient,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import {
  MAX_NAMED_REACTORS,
  collectMessageSenders,
  isDisplayableMessage,
  mapStatus,
  normalizeMediaPayload,
  reactionDetailsFor,
  reactionsFor,
  readReceiptsFor,
  replyPreview,
  trackEncryptedNonMessages,
} from './message-view';

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

describe('normalizeMediaPayload — encrypted sources', () => {
  const encrypted = (url: string) => ({
    url,
    key: { k: 'key' },
    iv: 'iv',
    hashes: { sha256: 'hash' },
    v: 'v2',
  });

  it('ignores url when file is present', () => {
    const payload = normalizeMediaPayload(
      {
        msgtype: 'm.image',
        body: 'pic',
        url: 'mxc://hs/other',
        file: encrypted('mxc://hs/cipher'),
      },
      'm.image',
    );

    expect(payload?.mxc).toBeNull();
    expect(payload?.file?.url).toBe('mxc://hs/cipher');
  });

  it('ignores thumbnail_url when thumbnail_file is present', () => {
    const payload = normalizeMediaPayload(
      {
        msgtype: 'm.image',
        body: 'pic',
        file: encrypted('mxc://hs/cipher'),
        info: {
          thumbnail_url: 'mxc://hs/other-thumb',
          thumbnail_file: encrypted('mxc://hs/thumb-cipher'),
        },
      },
      'm.image',
    );

    expect(payload?.thumbnailMxc).toBeNull();
    expect(payload?.thumbnailFile?.url).toBe('mxc://hs/thumb-cipher');
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

describe('isDisplayableMessage for a deleted event', () => {
  const ROOM = { getLiveTimeline: () => ({}) } as unknown as Room;
  const redaction = new SdkMatrixEvent({
    type: 'm.room.redaction',
    event_id: '$redaction',
    sender: '@mod:hs',
    room_id: '!r:hs',
    content: {},
  });
  type Decryptor = Parameters<SdkMatrixEvent['attemptDecryption']>[0];
  const answering = (
    outcome: () => Promise<{ clearEvent: object }>,
  ): Decryptor => ({ decryptEvent: outcome }) as unknown as Decryptor;

  /** A real client, so an event's Decrypted reaches a listener the way it does in the app. */
  const setUp = () => {
    const client = createClient({
      baseUrl: 'https://hs',
      userId: '@me:hs',
      fetchFn: () => Promise.reject(new Error('no network in unit tests')),
    });
    const map = client.getEventMapper({ decrypt: false });
    const wire = (over: object = {}): SdkMatrixEvent =>
      map({
        type: 'm.room.encrypted',
        event_id: '$event',
        sender: '@alice:hs',
        room_id: '!r:hs',
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'opaque' },
        ...over,
      });
    /** Decrypted `type`, with any relation on the wire too, where a sender must leave it. */
    const decrypted = async (
      type: string,
      content: Record<string, unknown> = {},
    ) => {
      const relation = content['m.relates_to'];
      const event = wire({
        content: {
          algorithm: 'm.megolm.v1.aes-sha2',
          ciphertext: 'opaque',
          ...(relation ? { 'm.relates_to': relation } : {}),
        },
      });
      await event.attemptDecryption(
        answering(() => Promise.resolve({ clearEvent: { type, content } })),
      );
      return event;
    };
    const arrivingRedacted = (over: object = {}): SdkMatrixEvent =>
      wire({
        content: {},
        unsigned: { redacted_because: redaction.event },
        ...over,
      });
    return { client, wire, decrypted, arrivingRedacted };
  };

  const REPLACES = {
    msgtype: 'm.text',
    'm.new_content': { msgtype: 'm.text', body: 'edited' },
    'm.relates_to': { rel_type: 'm.replace', event_id: '$target' },
  };

  it('keeps a decrypted message that is then deleted', async () => {
    const { decrypted } = setUp();
    const event = await decrypted('m.room.message', {
      msgtype: 'm.text',
      body: 'secret',
    });
    expect(isDisplayableMessage(event)).toBe(true);

    event.makeRedacted(redaction, ROOM);

    expect(event.getType()).toBe('m.room.encrypted');
    expect(isDisplayableMessage(event)).toBe(true);
  });

  it('keeps a deleted message that failed to decrypt', async () => {
    const { client, wire } = setUp();
    trackEncryptedNonMessages(client);
    const event = wire();
    await event.attemptDecryption(
      answering(() => Promise.reject(new Error('no key'))),
    );

    event.makeRedacted(redaction, ROOM);

    expect(isDisplayableMessage(event)).toBe(true);
  });

  it('keeps a message that arrives already deleted', () => {
    const event = setUp().arrivingRedacted();

    expect(event.getType()).toBe('m.room.encrypted');
    expect(isDisplayableMessage(event)).toBe(true);
  });

  it('skips an encrypted event still waiting to decrypt', () => {
    expect(isDisplayableMessage(setUp().wire())).toBe(false);
  });

  it('skips a deleted encrypted state event', () => {
    expect(
      isDisplayableMessage(setUp().arrivingRedacted({ state_key: '' })),
    ).toBe(false);
  });

  // The wire type survives redaction, and the SDK never encrypts a reaction.
  it('skips a deleted reaction sent in the clear', () => {
    const event = setUp().arrivingRedacted({ type: 'm.reaction' });

    expect(isDisplayableMessage(event)).toBe(false);
  });

  // Redaction wipes the clear type, so only hearing it decrypt can tell these apart.
  it.each<[string, string, Record<string, unknown>]>([
    [
      'reaction',
      'm.reaction',
      {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: '$target',
          key: '👍',
        },
      },
    ],
    ['edit', 'm.room.message', REPLACES],
    ['poll vote', 'org.matrix.msc3381.poll.response', {}],
    ['call', 'm.call.invite', {}],
  ])(
    'skips a deleted %s the client heard decrypt, unjudged until then',
    async (_name, type, content) => {
      const { client, decrypted } = setUp();
      trackEncryptedNonMessages(client);
      const event = await decrypted(type, content);

      event.makeRedacted(redaction, ROOM);

      expect(event.getType()).toBe('m.room.encrypted');
      expect(isDisplayableMessage(event)).toBe(false);
    },
  );

  it('learns nothing from being asked', async () => {
    const { decrypted } = setUp();
    const event = await decrypted('m.reaction');
    expect(isDisplayableMessage(event)).toBe(false);

    event.makeRedacted(redaction, ROOM);

    expect(isDisplayableMessage(event)).toBe(true);
  });

  it('stops listening when told to', async () => {
    const { client, decrypted } = setUp();
    trackEncryptedNonMessages(client)();
    const event = await decrypted('m.reaction');

    event.makeRedacted(redaction, ROOM);

    expect(isDisplayableMessage(event)).toBe(true);
  });

  // The object is what is remembered: the known limit for history paged back in, or a restart.
  it('cannot tell a non-message apart once a new object holds it', async () => {
    const { client, decrypted, arrivingRedacted } = setUp();
    trackEncryptedNonMessages(client);
    (await decrypted('m.reaction')).makeRedacted(redaction, ROOM);

    expect(isDisplayableMessage(arrivingRedacted())).toBe(true);
  });

  // Accepted for now: what "remove revision" leaves behind when the edit was not heard decrypting.
  // Nothing on the redacted event says it was an edit, in a plain room or an encrypted one.
  it('shows a removed revision as a deleted message once its relation is gone', () => {
    const { arrivingRedacted } = setUp();

    expect(isDisplayableMessage(arrivingRedacted())).toBe(true);
    expect(
      isDisplayableMessage(arrivingRedacted({ type: 'm.room.message' })),
    ).toBe(true);
  });

  // The SDK's setClearData doesn't look at redaction, so a decrypt finishing after the deletion
  // puts the clear type and content back.
  describe('when the deletion lands while a decrypt is in flight', () => {
    const inFlight = async (
      type: string,
      content: object,
      wireOver: object = {},
    ) => {
      const { client, wire } = setUp();
      trackEncryptedNonMessages(client);
      const event = wire(wireOver);
      let answer: (result: { clearEvent: object }) => void = () => undefined;
      const decrypting = event.attemptDecryption(
        answering(() => new Promise((resolve) => (answer = resolve))),
      );
      await Promise.resolve();
      event.makeRedacted(redaction, ROOM);
      answer({ clearEvent: { type, content } });
      await decrypting;
      return event;
    };

    it('keeps a message', async () => {
      const event = await inFlight('m.room.message', {
        msgtype: 'm.text',
        body: 'secret',
      });

      expect(event.getType()).toBe('m.room.message');
      expect(event.isRedacted()).toBe(true);
      expect(isDisplayableMessage(event)).toBe(true);
    });

    // The relation that marks an edit is only read off the wire, and that has been wiped.
    it('takes an edit for a message, the ghost this order leaves', async () => {
      const event = await inFlight('m.room.message', REPLACES, {
        content: {
          algorithm: 'm.megolm.v1.aes-sha2',
          ciphertext: 'opaque',
          'm.relates_to': REPLACES['m.relates_to'],
        },
      });

      expect(event.getType()).toBe('m.room.message');
      expect(event.getWireContent()).toEqual({});
      expect(event.isRelation()).toBe(false);
      expect(isDisplayableMessage(event)).toBe(true);
    });

    it('skips a non-message', async () => {
      const event = await inFlight('m.reaction', {});

      expect(event.getType()).toBe('m.reaction');
      expect(isDisplayableMessage(event)).toBe(false);
    });
  });
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
