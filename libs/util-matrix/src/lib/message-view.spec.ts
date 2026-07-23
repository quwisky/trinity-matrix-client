import { describe, expect, it } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import {
  MAX_NAMED_REACTORS,
  collectMessageSenders,
  firstUrl,
  isEditableMessage,
  linkifyText,
  parseGeoUri,
  parseLocationInput,
  reactionDetailsFor,
  reactionsFor,
  safeBuildMessageView,
  sanitizeMatrixHtml,
  type MessageKind,
  type MessageView,
} from './message-view';

describe('safeBuildMessageView', () => {
  it('degrades a hostile event that throws to an unsupported row (no crash)', () => {
    // A projection error must not propagate — it would crash the whole timeline map.
    const hostile = {
      getSender: () => '@evil:hs',
      getType: () => 'm.room.message',
      isDecryptionFailure: () => false,
      isRedacted: () => false,
      getContent: () => {
        throw new Error('boom');
      },
      getId: () => '$x',
      getTs: () => 123,
    } as unknown as MatrixEvent;
    const room = { getMember: () => null } as unknown as Room;
    const client = { getUserId: () => '@me:hs' } as unknown as MatrixClient;

    const view = safeBuildMessageView(client, room, hostile);

    expect(view.kind).toBe('unsupported');
    expect(view.body).toBe('[unsupported message]');
    expect(view.id).toBe('$x');
    expect(view.senderId).toBe('@evil:hs');
  });
});

function view(over: Partial<MessageView> = {}): MessageView {
  return {
    id: '$1',
    senderId: '@me:hs',
    senderName: 'Me',
    senderInitial: 'M',
    senderAvatarMxc: null,
    body: 'hi',
    html: null,
    timestamp: 0,
    isOwn: true,
    decryptionFailed: false,
    edited: false,
    reactions: [],
    replyTo: null,
    status: null,
    kind: 'text',
    media: null,
    caption: null,
    captionHtml: null,
    readReceipts: [],
    poll: null,
    ...over,
  };
}

describe('isEditableMessage', () => {
  it('allows editing own confirmed text/emote/notice messages', () => {
    for (const kind of ['text', 'emote', 'notice'] as MessageKind[]) {
      expect(isEditableMessage(view({ kind }))).toBe(true);
    }
  });

  it('never edits polls or locations (a text replace would corrupt them)', () => {
    // media is null for both, so the old `!message.media` gate wrongly allowed it.
    expect(isEditableMessage(view({ kind: 'poll' }))).toBe(false);
    expect(
      isEditableMessage(
        view({ kind: 'location', location: { lat: 1, lng: 2, label: 'x' } }),
      ),
    ).toBe(false);
    expect(isEditableMessage(view({ kind: 'unsupported' }))).toBe(false);
  });

  it('never edits others’ messages, unsent/failed sends, or decryption failures', () => {
    expect(isEditableMessage(view({ isOwn: false }))).toBe(false);
    expect(isEditableMessage(view({ status: 'sending' }))).toBe(false);
    expect(isEditableMessage(view({ status: 'failed' }))).toBe(false);
    expect(isEditableMessage(view({ decryptionFailed: true }))).toBe(false);
  });
});

describe('parseGeoUri', () => {
  it('parses lat/lng from a geo URI', () => {
    expect(parseGeoUri('geo:52.51,13.38')).toEqual({ lat: 52.51, lng: 13.38 });
  });

  it('handles negative coordinates and ignores an uncertainty suffix', () => {
    expect(parseGeoUri('geo:-33.86,151.21;u=35')).toEqual({
      lat: -33.86,
      lng: 151.21,
    });
  });

  it('returns null for a non-geo or malformed value', () => {
    expect(parseGeoUri('https://example.com')).toBeNull();
    expect(parseGeoUri('geo:not,coords')).toBeNull();
    expect(parseGeoUri(undefined)).toBeNull();
  });
});

describe('parseLocationInput', () => {
  it('parses a plain "lat, lng" pair (comma or space separated)', () => {
    expect(parseLocationInput('48.8584, 2.2945')).toEqual({
      lat: 48.8584,
      lng: 2.2945,
    });
    expect(parseLocationInput('-33.8568 151.2153')).toEqual({
      lat: -33.8568,
      lng: 151.2153,
    });
  });

  it('parses a geo: URI and rejects an out-of-range one', () => {
    expect(parseLocationInput('geo:52.51,13.38')).toEqual({
      lat: 52.51,
      lng: 13.38,
    });
    // parseGeoUri itself doesn't range-check, so this exercises the range guard
    // on the geo branch specifically.
    expect(parseLocationInput('geo:91,0')).toBeNull();
  });

  it('parses an Apple Maps ?ll= link', () => {
    expect(
      parseLocationInput('https://maps.apple.com/?ll=48.8584,2.2945'),
    ).toEqual({ lat: 48.8584, lng: 2.2945 });
  });

  it('parses an OpenStreetMap link (marker params and map fragment)', () => {
    expect(
      parseLocationInput(
        'https://www.openstreetmap.org/?mlat=48.8584&mlon=2.2945#map=16/48.8584/2.2945',
      ),
    ).toEqual({ lat: 48.8584, lng: 2.2945 });
    expect(
      parseLocationInput('https://www.openstreetmap.org/#map=5/-33.86/151.21'),
    ).toEqual({ lat: -33.86, lng: 151.21 });
  });

  it('parses a Google Maps link (@lat,lng segment and ?q= query)', () => {
    expect(
      parseLocationInput(
        'https://www.google.com/maps/place/Eiffel+Tower/@48.8584,2.2945,17z',
      ),
    ).toEqual({ lat: 48.8584, lng: 2.2945 });
    expect(
      parseLocationInput('https://maps.google.com/?q=40.7128,-74.006'),
    ).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  it('rejects out-of-range, empty, and unrecognised input', () => {
    expect(parseLocationInput('91, 0')).toBeNull();
    expect(parseLocationInput('0, 181')).toBeNull();
    expect(parseLocationInput('not a location')).toBeNull();
    expect(parseLocationInput('https://example.com/no/coords/here')).toBeNull();
    expect(parseLocationInput('   ')).toBeNull();
    expect(parseLocationInput(undefined)).toBeNull();
    expect(parseLocationInput(42)).toBeNull();
  });
});

describe('firstUrl', () => {
  it('returns the first http(s) URL', () => {
    expect(firstUrl('see https://example.com/x and http://b.test')).toBe(
      'https://example.com/x',
    );
  });

  it('trims trailing sentence punctuation', () => {
    expect(firstUrl('go to https://example.com.')).toBe('https://example.com');
    expect(firstUrl('(https://example.com)')).toBe('https://example.com');
  });

  it('returns null when there is no URL', () => {
    expect(firstUrl('no links here')).toBeNull();
  });
});

/** Parse sanitized HTML back into a document fragment for attribute assertions. */
function parse(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('linkifyText', () => {
  it('wraps a bare URL in an anchor, keeping the surrounding text', () => {
    expect(linkifyText('check https://example.com now')).toBe(
      'check <a href="https://example.com">https://example.com</a> now',
    );
  });

  it('returns null when there is no URL (keeps plain-text rendering)', () => {
    expect(linkifyText('just some text')).toBeNull();
  });

  it('leaves trailing sentence punctuation outside the link', () => {
    expect(linkifyText('see https://example.com.')).toBe(
      'see <a href="https://example.com">https://example.com</a>.',
    );
  });

  it('linkifies multiple URLs', () => {
    const html = linkifyText('https://a.com and https://b.com');
    expect(html).toContain('<a href="https://a.com">https://a.com</a>');
    expect(html).toContain('<a href="https://b.com">https://b.com</a>');
  });

  it('HTML-escapes the surrounding text and the URL', () => {
    // The `<script>` is escaped (not executable), and `&` in the query is escaped.
    const html = linkifyText('<script> https://x.com/?a=1&b=2');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="https://x.com/?a=1&amp;b=2"');
  });

  it('renders newlines as <br>', () => {
    expect(linkifyText('a\nhttps://x.com')).toBe(
      'a<br><a href="https://x.com">https://x.com</a>',
    );
  });
});

describe('sanitizeMatrixHtml — spoilers', () => {
  it('tags a spoiler with the mx-spoiler class and makes it keyboard-activatable', () => {
    const clean = sanitizeMatrixHtml(
      'peek: <span data-mx-spoiler>the butler did it</span>',
    );
    // The mx-spoiler *class* is what the renderer keys off — it survives Angular's
    // [innerHTML] sanitizer, unlike the data-mx-spoiler attribute.
    const spoiler = parse(clean).querySelector('.mx-spoiler');

    expect(spoiler).not.toBeNull();
    expect(spoiler?.textContent).toBe('the butler did it');
    expect(spoiler?.getAttribute('tabindex')).toBe('0');
    expect(spoiler?.getAttribute('role')).toBe('button');
  });

  it('keeps a spoiler reason on the attribute', () => {
    const clean = sanitizeMatrixHtml(
      '<span data-mx-spoiler="ending">she lives</span>',
    );
    const spoiler = parse(clean).querySelector('[data-mx-spoiler]');
    expect(spoiler?.getAttribute('data-mx-spoiler')).toBe('ending');
  });

  it('does not make ordinary spans focusable', () => {
    const clean = sanitizeMatrixHtml('<span>just text</span>');
    const span = parse(clean).querySelector('span');
    expect(span?.hasAttribute('tabindex')).toBe(false);
    expect(span?.hasAttribute('role')).toBe(false);
  });

  it('still strips dangerous markup around a spoiler', () => {
    const clean = sanitizeMatrixHtml(
      '<span data-mx-spoiler onclick="steal()">x</span><script>bad()</script>',
    );
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('<script');
  });
});

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

    collectMessageSenders(room, message, senders);

    expect([...senders]).toEqual([
      '@author:hs',
      '@alice:hs',
      '@bob:hs',
      '@carol:hs',
    ]);
  });
});
