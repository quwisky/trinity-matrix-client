import { afterEach, describe, expect, it } from 'vitest';
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
  sanitizeOutgoingHtml,
  setCodeHighlighter,
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

describe('sanitizeMatrixHtml — task items', () => {
  it('marks a task item so the renderer can drop its bullet', () => {
    // The checkbox is already a ☑/☐ glyph in the item's text, so a list marker beside it
    // reads as "• ☑ done". The class is what the stylesheet keys off, and it survives
    // Angular's [innerHTML] sanitizer.
    const clean = sanitizeMatrixHtml('<ul><li>☑ done</li><li>☐ todo</li></ul>');
    const items = parse(clean).querySelectorAll('li');

    expect(items[0].classList.contains('mx-task')).toBe(true);
    expect(items[1].classList.contains('mx-task')).toBe(true);
  });

  it('renders an incoming checkbox as the glyph our own task lists use', () => {
    // What Element and every other GFM client puts on the wire. `input` is in neither
    // allowlist, so this used to arrive as bare text with the done state simply gone.
    const clean = sanitizeMatrixHtml(
      '<ul><li><input type="checkbox" checked disabled> done</li>' +
        '<li><input type="checkbox" disabled> todo</li></ul>',
    );
    const items = parse(clean).querySelectorAll('li');

    expect(clean).not.toContain('<input');
    expect(items[0].textContent?.trimStart().startsWith('☑')).toBe(true);
    expect(items[1].textContent?.trimStart().startsWith('☐')).toBe(true);
    expect(items[0].classList.contains('mx-task')).toBe(true);
    expect(items[1].classList.contains('mx-task')).toBe(true);
  });

  it('drops a non-checkbox input, and leaks neither it nor its attributes', () => {
    // `input` is only let past DOMPurify so the checkbox above can be read; nothing of it
    // may survive the pass, and the attributes it needed must not ride out on anything else.
    const clean = sanitizeMatrixHtml(
      '<p><input type="text" value="pwned"></p><span type="text">hi</span>',
    );

    expect(clean).not.toContain('<input');
    expect(clean).not.toContain('type=');
    expect(clean).not.toContain('pwned');
  });

  it('leaves an incoming checkbox out of what we send', () => {
    // The send path keeps the untouched allowlist, so the tag is simply dropped there.
    const outgoing = sanitizeOutgoingHtml(
      '<ul><li><input type="checkbox" checked> done</li></ul>',
    );

    expect(outgoing).not.toContain('<input');
    expect(outgoing).not.toContain('☑');
  });

  it('leaves an ordinary list item alone', () => {
    // The glyph has to OPEN the item. Anywhere else it is just a character someone typed,
    // and the item is a normal one that should keep its bullet.
    const clean = sanitizeMatrixHtml(
      '<ul><li>milk</li><li>ticked it ☑</li></ul>',
    );
    const items = parse(clean).querySelectorAll('li');

    expect(items[0].classList.contains('mx-task')).toBe(false);
    expect(items[1].classList.contains('mx-task')).toBe(false);
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

// The send path shares one DOMPurify config with the render path — same allowlist, so
// the client can never emit a formatted_body its own renderer would strip — but none of
// the render-only normalisation, which has no business on the wire.
describe('sanitizeOutgoingHtml', () => {
  it('does not add the renderer’s spoiler attributes', () => {
    // `tabindex`/`role` are in neither allowlist. They survive on the render side only
    // because they are set after DOMPurify's attribute filter — which is exactly why
    // spoiler normalisation had to move out of the shared hook.
    const clean = sanitizeOutgoingHtml('<span data-mx-spoiler>x</span>');

    expect(clean).toContain('data-mx-spoiler');
    expect(clean).not.toContain('tabindex');
    expect(clean).not.toContain('role=');
    expect(clean).not.toContain('mx-spoiler"');
  });

  it('still applies every security filter the render path does', () => {
    const clean = sanitizeOutgoingHtml(
      '<script>bad()</script>' +
        '<img src="https://attacker.test/x.gif" alt="leak">' +
        '<a href="javascript:steal()" target="_blank">x</a>' +
        '<span class="ion-page">y</span>',
    );

    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('attacker.test');
    // The image reduces to its alt text. It used to keep the element and lose only the src,
    // which is the src-less empty box the markdown renderer goes out of its way to avoid —
    // and every client prefers formatted_body, so the address was gone for good.
    expect(clean).not.toContain('<img');
    expect(clean).toContain('leak');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('target=');
    expect(clean).not.toContain('ion-page');
  });

  it('keeps the class tokens Matrix sanctions', () => {
    expect(
      sanitizeOutgoingHtml('<code class="language-python">x</code>'),
    ).toContain('language-python');
  });
});

// A fenced block is captioned with the language it declares, shown on hover. The caption
// is an ATTRIBUTE read back by CSS, not an element — see renderCodeBlocks for why.
describe('sanitizeMatrixHtml — code language label', () => {
  const langOf = (html: string) =>
    parse(html).querySelector('pre')?.getAttribute('language') ?? null;

  it('captions a fenced block with its language', () => {
    expect(
      langOf(
        sanitizeMatrixHtml(
          '<pre><code class="language-python">x = 1</code></pre>',
        ),
      ),
    ).toBe('python');
  });

  it('keeps the caption out of the message text', () => {
    // Load-bearing beyond tidiness: the edit-history diff compares the TEXT of two
    // rendered revisions, so a caption node would make a fence-language-only edit read as
    // a text change and would appear in every diff of a message containing code.
    const clean = sanitizeMatrixHtml(
      '<pre><code class="language-ts">let a = 1;</code></pre>',
    );

    expect(parse(clean).textContent).toBe('let a = 1;');
  });

  it('captions a language no grammar is loaded for', () => {
    // Knowing a block is elixir is useful even when we cannot colour it.
    expect(
      langOf(
        sanitizeMatrixHtml(
          '<pre><code class="language-elixir">IO.puts 1</code></pre>',
        ),
      ),
    ).toBe('elixir');
  });

  it('lowercases the declared language', () => {
    expect(
      langOf(
        sanitizeMatrixHtml('<pre><code class="language-JS">a</code></pre>'),
      ),
    ).toBe('js');
  });

  it('captions nothing when the block declares no language', () => {
    expect(
      langOf(sanitizeMatrixHtml('<pre><code>plain</code></pre>')),
    ).toBeNull();
  });

  it('does not caption an outgoing message', () => {
    // The caption is presentation; the wire format stays the Matrix-sanctioned shape.
    expect(
      sanitizeOutgoingHtml('<pre><code class="language-python">x</code></pre>'),
    ).not.toContain('language="python"');
  });
});

describe('sanitizeMatrixHtml — code highlighting', () => {
  afterEach(() => {
    // The highlighter and the memo are module-scoped and live for the whole process;
    // setCodeHighlighter(null) clears both, so a spec that installs one must call it.
    setCodeHighlighter(null);
  });

  /** A highlighter that wraps the whole source in one token span. */
  function fakeHighlighter(code: string, lang: string, doc: Document) {
    const frag = doc.createDocumentFragment();
    const span = doc.createElement('span');
    span.className = `tok-keyword lang-${lang}`;
    span.textContent = code;
    frag.appendChild(span);
    return frag;
  }

  const BLOCK = '<pre><code class="language-python">x = 1</code></pre>';

  it('leaves the code itself untouched when no highlighter is installed', () => {
    const clean = sanitizeMatrixHtml(BLOCK);

    expect(clean).not.toContain('tok-');
    expect(parse(clean).querySelector('code')?.textContent).toBe('x = 1');
  });

  it('keeps token classes the sender allowlist would have stripped', () => {
    // The whole reason highlighting runs AFTER DOMPurify: ALLOWED_CLASS permits only
    // `language-*` and `mx-spoiler`, so `tok-*` could not survive the scrub itself.
    setCodeHighlighter(fakeHighlighter);

    const clean = sanitizeMatrixHtml(BLOCK);

    expect(clean).toContain('tok-keyword');
    expect(clean).toContain('lang-python');
    expect(parse(clean).querySelector('code')?.textContent).toBe('x = 1');
  });

  it('ignores a block with no language and one with no content', () => {
    setCodeHighlighter(fakeHighlighter);

    expect(sanitizeMatrixHtml('<pre><code>x = 1</code></pre>')).not.toContain(
      'tok-',
    );
    expect(
      sanitizeMatrixHtml('<pre><code class="language-py"></code></pre>'),
    ).not.toContain('tok-');
  });

  it('leaves the block alone when the highlighter declines the language', () => {
    setCodeHighlighter(() => null);

    expect(sanitizeMatrixHtml(BLOCK)).not.toContain('tok-');
  });

  it('leaves a block containing markup alone', () => {
    // The Matrix allowlist permits inline markup inside <code> — a link, bold, a spoiler.
    // Replacing the children would delete it, and only for languages we have a grammar
    // for, so the same body would render differently depending on its fence tag.
    setCodeHighlighter(fakeHighlighter);

    const clean = sanitizeMatrixHtml(
      '<pre><code class="language-python"><b>x</b> = 1</code></pre>',
    );

    expect(clean).toContain('<b>x</b>');
    expect(clean).not.toContain('tok-');
  });

  describe('the per-message tokenization budget', () => {
    /** Records what the highlighter was actually asked to tokenize. */
    function recorder() {
      const seen: number[] = [];
      setCodeHighlighter((code, _lang, doc) => {
        seen.push(code.length);
        return doc.createDocumentFragment();
      });
      return seen;
    }

    const block = (chars: number) =>
      `<pre><code class="language-python">${'x'.repeat(chars)}</code></pre>`;

    it('stops tokenizing once a message has spent its budget', () => {
      const seen = recorder();

      // 20_000 of budget: the first two fit, the third does not.
      sanitizeMatrixHtml(block(9_000) + block(9_000) + block(9_000));

      expect(seen).toEqual([9_000, 9_000]);
    });

    it('still highlights a small block after one too large to fit', () => {
      // `continue`, not `break`: one oversized listing must not un-colour everything
      // below it.
      const seen = recorder();

      sanitizeMatrixHtml(block(19_000) + block(5_000) + block(500));

      expect(seen).toEqual([19_000, 500]);
    });

    it('does not charge for a block the highlighter declines', () => {
      // A declined block costs nothing to tokenize, so charging for it would starve
      // blocks that could have been highlighted.
      const seen: number[] = [];
      setCodeHighlighter((code, _lang, doc) => {
        seen.push(code.length);
        return code.length > 15_000 ? null : doc.createDocumentFragment();
      });

      sanitizeMatrixHtml(block(16_000) + block(9_000) + block(9_000));

      expect(seen).toEqual([16_000, 9_000, 9_000]);
    });
  });

  it('re-sanitizes after the highlighter changes, rather than serving a stale memo', () => {
    expect(sanitizeMatrixHtml(BLOCK)).not.toContain('tok-');

    setCodeHighlighter(fakeHighlighter);

    expect(sanitizeMatrixHtml(BLOCK)).toContain('tok-keyword');
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
