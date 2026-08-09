import { describe, expect, it } from 'vitest';
import type { MatrixEvent, Room } from 'matrix-js-sdk';
import {
  editMessageContent,
  emoteMessageContent,
  locationMessageContent,
  mediaCaptionFields,
  messagePreview,
  parseSlashCommand,
  renderMarkdown,
  replyMessageContent,
  slashCommandContent,
  textMessageContent,
  type Mention,
  type RenderedMarkdown,
} from './message-content';

describe('locationMessageContent', () => {
  it('builds an m.location with a geo URI and MSC3488 fields', () => {
    const content = locationMessageContent(52.51, 13.38, 'Berlin') as Record<
      string,
      unknown
    >;
    expect(content['msgtype']).toBe('m.location');
    expect(content['geo_uri']).toBe('geo:52.51,13.38');
    expect(content['body']).toBe('Berlin');
    expect(content['org.matrix.msc3488.location']).toMatchObject({
      uri: 'geo:52.51,13.38',
    });
  });
});

describe('parseSlashCommand', () => {
  it('parses a known command and its trimmed argument', () => {
    expect(parseSlashCommand('/me waves hello')).toEqual({
      command: 'me',
      arg: 'waves hello',
    });
    expect(parseSlashCommand('/shrug')).toEqual({ command: 'shrug', arg: '' });
  });

  it('is case-insensitive on the command', () => {
    expect(parseSlashCommand('/ME hi')?.command).toBe('me');
  });

  it('returns null for unknown commands and non-commands', () => {
    expect(parseSlashCommand('/method chain')).toBeNull(); // not /me
    expect(parseSlashCommand('/etc/passwd')).toBeNull();
    expect(parseSlashCommand('hello /me')).toBeNull(); // not leading
    expect(parseSlashCommand('/unknown x')).toBeNull();
  });
});

describe('slashCommandContent', () => {
  const plain: RenderedMarkdown = { formatted: false, html: '' };
  const render = () => plain;

  it('builds an m.emote for /me', () => {
    expect(slashCommandContent('/me waves', render)).toMatchObject({
      msgtype: 'm.emote',
      body: 'waves',
    });
  });

  it('carries @-mentions through /me (pill + m.mentions)', () => {
    const html = '<p>waves at @Bob</p>';
    const content = slashCommandContent(
      '/me waves at @Bob',
      () => ({ formatted: false, html }),
      [{ userId: '@bob:hs', display: '@Bob' }],
    ) as Record<string, unknown>;

    expect(content['msgtype']).toBe('m.emote');
    expect(content['formatted_body']).toContain(
      '<a href="https://matrix.to/#/@bob:hs">@Bob</a>',
    );
    expect(content['m.mentions']).toEqual({ user_ids: ['@bob:hs'] });
  });

  it('appends the shrug for /shrug (with and without text)', () => {
    expect(slashCommandContent('/shrug', render)).toMatchObject({
      msgtype: 'm.text',
      body: '¯\\_(ツ)_/¯',
    });
    expect(
      (slashCommandContent('/shrug oh well', render) as { body: string }).body,
    ).toBe('oh well ¯\\_(ツ)_/¯');
  });

  it('sends /plain as plain text (no formatting)', () => {
    expect(slashCommandContent('/plain **not bold**', render)).toEqual({
      msgtype: 'm.text',
      body: '**not bold**',
      // Every user-authored body carries the marker, or the command is a hole through it.
      'm.mentions': {},
    });
  });

  it('keeps line breaks inside a multi-line /spoiler', () => {
    // A spoiler always sets format: html, so it renders under `white-space: normal` and
    // cannot fall back to the plain-text branch that preserves newlines.
    const content = slashCommandContent(
      '/spoiler line one\nline two',
      renderMarkdown,
    ) as { formatted_body: string };

    expect(content.formatted_body).toBe(
      '<span data-mx-spoiler>line one<br>line two</span>',
    );
  });

  it('wraps /spoiler text in a spoiler span', () => {
    const content = slashCommandContent(
      '/spoiler the butler did it',
      render,
    ) as {
      formatted_body: string;
    };
    expect(content.formatted_body).toBe(
      '<span data-mx-spoiler>the butler did it</span>',
    );
  });

  it('returns null for a non-command (send it literally)', () => {
    expect(slashCommandContent('just a message', render)).toBeNull();
  });

  it('returns null for an empty-argument command (nothing to send)', () => {
    expect(slashCommandContent('/me', render)).toBeNull();
    expect(slashCommandContent('/spoiler', render)).toBeNull();
  });
});

// `formatted` decides whether a message goes on the wire as plain `body` or gains a
// `formatted_body`. It is a round-trip test — render, strip the tags, compare — so
// turning on `breaks` (a single newline becomes <br>) put it at risk: <br> contributes
// nothing to textContent, and without restoring it every multi-line plain message would
// have been promoted to HTML.
describe('renderMarkdown — plain vs formatted', () => {
  it.each([
    ['a single line', 'hello there'],
    ['a soft line break', 'line one\nline two'],
    ['a paragraph break', 'a\n\nb'],
    ['several blank lines', 'a\n\n\nb'],
    ['a two-space hard break', 'x  \ny'],
    ['a Windows line ending', 'a\r\nb'],
    ['trailing whitespace', 'hello   '],
    ['a bare URL', 'https://a.test/x'],
    ['characters that merely escape', '5 < 3 & 4 > 2'],
    ['an underscore inside a word', 'snake_case_word'],
    ['asterisks used as multiplication', '2 * 3 * 4'],
    ['a Windows path', 'C:\\path\\to'],
    ['a hash that is not a heading', '#hashtag'],
    ['nothing at all', ''],
  ])('sends %s as plain text', (_label, text) => {
    expect(renderMarkdown(text).formatted).toBe(false);
  });

  it.each([
    ['emphasis', '**bold**'],
    ['emphasis beside a line break', '**bold**\nline two'],
    ['a heading', '# H'],
    ['a quote', '> q'],
    ['a bullet list', '- a\n- b'],
    ['inline code', '`code`'],
    ['a fenced block', '```js\nlet a = 1;\n```'],
    ['a task list', '- [x] done'],
    ['strikethrough', '~~gone~~'],
  ])('sends %s as HTML', (_label, text) => {
    expect(renderMarkdown(text).formatted).toBe(true);
  });

  it('keeps a soft line break as a <br> rather than losing it', () => {
    // The bug this whole change exists for: the plain branch renders under
    // `white-space: pre-wrap` and kept the newline, but the formatted branch emitted a
    // bare \n under `white-space: normal`, which collapsed it to a space — so bolding
    // one word silently deleted every line break in the message.
    expect(renderMarkdown('**bold**\nline two').html).toContain('<br>');
  });

  it('leaves an indented single line as plain text (documented false negative)', () => {
    // "    code" is a code block to marked, but both sides normalise to "code" so it
    // compares equal. Unreachable from the composer, which trims first, and harmless
    // under pre-wrap — pinned so it cannot silently widen.
    expect(renderMarkdown('    code').formatted).toBe(false);
    expect(renderMarkdown('x\n\n    code').formatted).toBe(true);
  });

  it('treats input that sanitizes away to nothing as plain text', () => {
    // Sending an empty formatted_body is worse than sending the text.
    expect(renderMarkdown('<!-- just a comment -->')).toEqual({
      formatted: false,
      html: '',
    });
  });
});

describe('renderMarkdown — outgoing sanitization', () => {
  it('renders GFM task lists as ballot glyphs, not checkboxes', () => {
    // `input` is in neither allowlist, so marked's <input type="checkbox"> was stripped
    // on the way out and the done/not-done state was lost before the event was sent.
    const { html } = renderMarkdown('- [x] done\n- [ ] todo');

    expect(html).toContain('☑ done');
    expect(html).toContain('☐ todo');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('checked');
    expect(html).not.toContain('type=');
  });

  it('sends a remote image as a link rather than a broken one', () => {
    // Matrix requires an mxc: source, so the <img> would sanitize to an empty box — and
    // because every client prefers formatted_body over body, the URL would vanish with it.
    const { html } = renderMarkdown('![pic](https://x.test/a.png)');

    expect(html).toContain('<a href="https://x.test/a.png">pic</a>');
    expect(html).not.toContain('<img');
  });

  it('points a linked remote image at the target, not at the image', () => {
    // `[![badge](img)](target)` — the badge-linking shape. Rendering the image as an <a>
    // inside the link's <a> is not representable: the parser splits the nested anchors and
    // the message goes out as an empty link plus a link to the IMAGE, losing the target.
    const { html } = renderMarkdown(
      '[![badge](https://img.test/b.svg)](https://target.test/x)',
    );

    expect(html).toContain('<a href="https://target.test/x">badge</a>');
    expect(html).not.toContain('img.test');
    expect(html).not.toMatch(/<a[^>]*><\/a>/);
  });

  it('never puts a data: image on the wire', () => {
    // Matrix requires an mxc: source, so a base64 payload arrives as the empty box this
    // renderer exists to prevent — after shipping the whole blob, which on a real image
    // would blow the 65 KiB event limit on its own.
    const { html } = renderMarkdown('![diagram](data:image/png;base64,AAAA)');

    expect(html).not.toContain('base64');
    expect(html).not.toContain('<img');
    expect(html).toContain('diagram');
  });

  it('applies the mxc-only image rule to raw HTML too', () => {
    // `image()` only sees markdown image tokens — marked hands raw HTML straight through, so
    // the same payload walked out the other door. Both are settled on the way out now.
    const data = renderMarkdown(
      '<img src="data:image/png;base64,AAAA" alt="diagram">',
    );
    expect(data.html).not.toContain('base64');
    expect(data.html).not.toContain('<img');
    expect(data.html).toContain('diagram');

    // A remote source keeps its src stripped by the allowlist, which left a src-less <img> —
    // the empty box the markdown renderer exists to avoid.
    const remote = renderMarkdown('<img src="https://x.test/a.png" alt="pic">');
    expect(remote.html).not.toContain('<img');
    expect(remote.html).toContain('pic');
  });

  it('does not fall back to a data: URI as the link text', () => {
    // `text || href` would otherwise put the payload on the wire as the caption instead.
    const { html } = renderMarkdown('![](data:image/png;base64,AAAA)');

    expect(html).not.toContain('base64');
  });

  it('keeps an image whose source Matrix does carry', () => {
    const { html } = renderMarkdown('![pic](mxc://hs/abc)');

    expect(html).toContain('<img src="mxc://hs/abc"');
    expect(html).toContain('alt="pic"');
  });

  it('drops tags Angular allowed but Matrix does not', () => {
    // The point of routing sends through the Matrix allowlist: the client can no longer
    // emit a formatted_body its own renderer would strip.
    for (const raw of [
      '<audio src="x"></audio>',
      '<mark>x</mark>',
      '<ins>x</ins>',
    ]) {
      const { html } = renderMarkdown(raw);
      expect(html, raw).not.toMatch(/<(audio|mark|ins)\b/);
    }
  });

  it('drops the href from a relative or fragment link', () => {
    // The Matrix allowlist requires an absolute scheme on href, so a relative link keeps
    // its text and loses its target. It always rendered that way on arrival too — this
    // just stops us sending one that only ever looked like a link.
    for (const raw of ['[docs](/help/start)', '[top](#intro)']) {
      const { html } = renderMarkdown(raw);
      expect(html, raw).not.toContain('href');
      expect(html, raw).toContain('</a>');
    }
    expect(renderMarkdown('[ok](https://a.test/x)').html).toContain(
      'href="https://a.test/x"',
    );
  });

  it('still strips script and event handlers', () => {
    const { html } = renderMarkdown(
      '<img src=x onerror=alert(1)><script>bad()</script>',
    );

    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
  });
});

describe('mediaCaptionFields', () => {
  it('uses the filename as the body when there is no caption', () => {
    expect(mediaCaptionFields('pic.png', '')).toEqual({
      body: 'pic.png',
    });
    // Whitespace-only is treated as no caption.
    expect(mediaCaptionFields('pic.png', '   ')).toEqual({
      body: 'pic.png',
    });
  });

  it('sets body=caption + filename for a plain caption (MSC2530)', () => {
    expect(mediaCaptionFields('pic.png', 'a caption')).toEqual({
      body: 'a caption',
      filename: 'pic.png',
      // A caption REPLACES the filename as the body, so a push rule matches it.
      'm.mentions': {},
    });
  });

  it('trims the caption', () => {
    expect(mediaCaptionFields('pic.png', '  hi  ')).toEqual({
      body: 'hi',
      filename: 'pic.png',
      'm.mentions': {},
    });
  });

  it('adds a formatted_body for a markdown caption', () => {
    const fields = mediaCaptionFields('pic.png', 'a **bold** caption');
    expect(fields['body']).toBe('a **bold** caption');
    expect(fields['filename']).toBe('pic.png');
    expect(fields['format']).toBe('org.matrix.custom.html');
    expect(fields['formatted_body']).toContain('<strong>bold</strong>');
  });

  it('omits format for a caption with no markdown formatting', () => {
    const fields = mediaCaptionFields('pic.png', 'just text');
    expect(fields['format']).toBeUndefined();
    expect(fields['formatted_body']).toBeUndefined();
  });
});

/** Extract `m.mentions.user_ids` from a built content object. */
function mentionIds(content: unknown): string[] {
  const block = (content as Record<string, { user_ids?: string[] }>)[
    'm.mentions'
  ];
  return block?.user_ids ?? [];
}

const ALICE: Mention = { userId: '@alice:hs', display: '@Alice' };

describe('mentions in content builders', () => {
  it('adds m.mentions and a matrix.to pill for a plain-text mention', () => {
    const text = 'hey @Alice';
    const content = textMessageContent(text, renderMarkdown(text), [
      ALICE,
    ]) as Record<string, unknown>;

    expect(content['body']).toBe('hey @Alice'); // plain body keeps the readable @name
    expect(content['format']).toBe('org.matrix.custom.html');
    expect(content['formatted_body']).toContain(
      '<a href="https://matrix.to/#/@alice:hs">@Alice</a>',
    );
    expect(mentionIds(content)).toEqual(['@alice:hs']);
  });

  it('stays plain text with no mention and no markdown', () => {
    const text = 'just text';
    expect(textMessageContent(text, renderMarkdown(text))).toEqual({
      msgtype: 'm.text',
      body: 'just text',
      // Present but EMPTY, deliberately: its presence is what makes the homeserver skip
      // the legacy body-matching push rules. See the m.mentions describe block below.
      'm.mentions': {},
    });
  });

  it("carries an edit's mentions at BOTH levels", () => {
    const text = 'fixed @Alice';
    const content = editMessageContent('$m', text, renderMarkdown(text), [
      ALICE,
    ]) as Record<string, unknown>;

    // The top-level block used to be omitted, on the reasoning that `.m.rule.suppress_edits`
    // would stop an edit re-notifying. Measured against Synapse 1.119, it does not: the
    // legacy body rules fire on the `* …` fallback FIRST, so an edit that merely corrects a
    // typo in a quote re-highlighted everyone the quote named. The nested copy is the
    // effective content; the top-level one is what suppresses the legacy rules.
    expect(mentionIds(content)).toEqual(['@alice:hs']);
    const newContent = content['m.new_content'];
    expect(mentionIds(newContent)).toEqual(['@alice:hs']);
    expect((newContent as Record<string, string>)['formatted_body']).toContain(
      'matrix.to/#/@alice:hs',
    );
  });

  it('escapes a hostile user id in a mention-pill href (no attribute breakout)', () => {
    const evil: Mention = {
      userId: '@a"><img src=x onerror=alert(1)>:hs',
      display: '@X',
    };
    const text = 'hi @X';
    const html = (
      textMessageContent(text, renderMarkdown(text), [evil]) as Record<
        string,
        unknown
      >
    )['formatted_body'] as string;

    expect(html).not.toContain('"><img'); // no raw attribute breakout
    expect(html).toContain('&quot;'); // the quote was escaped in the href
  });

  it('escapes a hostile sender id in a reply href', () => {
    const room = {
      roomId: '!r:hs',
      findEventById: () => ({
        getSender: () => '@a"><img src=x>:hs',
        getContent: () => ({ body: 'orig' }),
      }),
    } as unknown as Room;

    const html = replyMessageContent(
      room,
      '$t',
      'hello',
      renderMarkdown('hello'),
      [],
    ).formatted_body as string;

    expect(html).not.toContain('"><img');
    expect(html).toContain('&quot;');
  });

  it('keeps line breaks in a multi-line reply', () => {
    // A reply always sets format: html, so an unformatted one still renders under
    // `white-space: normal` — the plain-text branch that preserves newlines is not
    // available to it, and a raw \n would arrive as a space.
    const room = {
      roomId: '!r:hs',
      findEventById: () => ({
        getSender: () => '@bob:hs',
        getContent: () => ({ body: 'original' }),
      }),
    } as unknown as Room;
    const text = 'line one\nline two';

    const html = replyMessageContent(room, '$t', text, renderMarkdown(text), [])
      .formatted_body as string;

    expect(html).toContain('line one<br>line two');
    expect(html).not.toContain('line one\nline two');
  });

  it('a reply pings the replied-to author plus any reply mentions', () => {
    const room = {
      roomId: '!r:hs',
      findEventById: () => ({
        getSender: () => '@bob:hs',
        getContent: () => ({ body: 'original' }),
      }),
    } as unknown as Room;
    const text = 'thanks @Alice';
    const content = replyMessageContent(
      room,
      '$t',
      text,
      renderMarkdown(text),
      [ALICE],
    );

    expect(mentionIds(content)).toEqual(
      expect.arrayContaining(['@bob:hs', '@alice:hs']),
    );
    expect(content.formatted_body).toContain('matrix.to/#/@alice:hs');
  });

  it('pills and lists every mention in a multi-mention message', () => {
    const text = 'hi @Alice and @Bob';
    const content = textMessageContent(text, renderMarkdown(text), [
      ALICE,
      { userId: '@bob:hs', display: '@Bob' },
    ]) as Record<string, unknown>;

    expect(mentionIds(content)).toEqual(['@alice:hs', '@bob:hs']);
    expect(content['formatted_body']).toContain('matrix.to/#/@alice:hs');
    expect(content['formatted_body']).toContain('matrix.to/#/@bob:hs');
  });

  it('HTML-escapes a mention display in the pill', () => {
    const text = 'hi @A&B';
    const content = textMessageContent(text, renderMarkdown(text), [
      { userId: '@ab:hs', display: '@A&B' },
    ]) as Record<string, unknown>;

    // The pill text is escaped (matches the form marked emitted); no raw ampersand.
    expect(content['formatted_body']).toContain(
      '<a href="https://matrix.to/#/@ab:hs">@A&amp;B</a>',
    );
  });

  it.each([
    ['an apostrophe', "@O'Brien", '@ob:hs'],
    ['a quote', '@say "hi"', '@sh:hs'],
    ['a less-than', '@a<b', '@ab:hs'],
  ])('pills a display name containing %s', (_label, display, userId) => {
    // The pill is placed by finding the display in the sanitized HTML, so the needle has
    // to be escaped the way the SANITIZER writes text — not the way escapeHtml does.
    // DOMPurify re-serializes `&#39;`/`&quot;` back to raw characters, so matching on the
    // fully-escaped form silently found nothing and the mention rendered as inert text.
    const text = `hi ${display}`;
    const content = textMessageContent(text, renderMarkdown(text), [
      { userId, display },
    ]) as Record<string, unknown>;

    expect(content['formatted_body']).toContain(
      `<a href="https://matrix.to/#/${userId}">`,
    );
    expect(content['m.mentions']).toEqual({ user_ids: [userId] });
  });

  it('never sends an empty formatted_body, even with a mention', () => {
    // A mention takes the rich branch regardless of `formatted`, so input that sanitizes
    // away to nothing would have produced `formatted_body: ''` — and every client prefers
    // formatted_body over body, rendering a blank message.
    const content = textMessageContent(
      '<!-- x -->',
      renderMarkdown('<!-- x -->'),
      [{ userId: '@a:hs', display: '@A' }],
    ) as Record<string, unknown>;

    expect(content['formatted_body']).toBeUndefined();
    expect(content['format']).toBeUndefined();
    expect(content['body']).toBe('<!-- x -->');
  });

  it('still notifies the people mentioned when the markup sanitizes away', () => {
    // `m.mentions` is what makes a modern homeserver notify them. Dropping it along with the
    // empty formatted_body means the message arrives and the person named never hears of it.
    const content = textMessageContent(
      '<!-- x -->',
      renderMarkdown('<!-- x -->'),
      [{ userId: '@a:hs', display: '@A' }],
    ) as Record<string, unknown>;

    expect(content['m.mentions']).toEqual({ user_ids: ['@a:hs'] });
  });

  it('still notifies the people mentioned in an emote that sanitizes away', () => {
    const content = emoteMessageContent(
      '<!-- x -->',
      renderMarkdown('<!-- x -->'),
      [{ userId: '@a:hs', display: '@A' }],
    ) as Record<string, unknown>;

    expect(content['m.mentions']).toEqual({ user_ids: ['@a:hs'] });
  });
});

// A fake shaped like the bits messagePreview() reads off a MatrixEvent.
function fakeEvent(o: {
  body?: string;
  redacted?: boolean;
  decryptFail?: boolean;
}): MatrixEvent {
  return {
    getContent: () => ({ body: o.body ?? '' }),
    isRedacted: () => o.redacted ?? false,
    isDecryptionFailure: () => o.decryptFail ?? false,
  } as unknown as MatrixEvent;
}

describe('messagePreview', () => {
  it('returns the body trimmed and with internal whitespace collapsed', () => {
    expect(messagePreview(fakeEvent({ body: '  hello   world  \n\n' }))).toBe(
      'hello world',
    );
  });

  it('strips a reply fallback quote, keeping only the actual message', () => {
    const event = fakeEvent({
      body: '> <@user:hs> quoted\n\nactual',
    });
    expect(messagePreview(event)).toBe('actual');
  });

  it("returns '(message deleted)' for a redacted event", () => {
    const event = fakeEvent({ body: 'gone now', redacted: true });
    expect(messagePreview(event)).toBe('(message deleted)');
  });

  it("returns '⚠️ Unable to decrypt' for a decryption failure, before checking redaction", () => {
    const event = fakeEvent({ decryptFail: true, redacted: true });
    expect(messagePreview(event)).toBe('⚠️ Unable to decrypt');
  });

  it("returns '…' for an empty or whitespace-only body", () => {
    expect(messagePreview(fakeEvent({ body: '' }))).toBe('…');
    expect(messagePreview(fakeEvent({ body: '   \n  ' }))).toBe('…');
  });
});

/**
 * `m.mentions` is always sent, which is what stops a message notifying people it merely
 * NAMES rather than addresses. Verified against Synapse 1.119: an identical quoted body
 * highlights the named user when the key is absent and is silent when it is present.
 */
describe('m.mentions is always present', () => {
  it('emits an empty block for a message that mentions nobody', () => {
    const text = 'hello';
    const content = textMessageContent(text, renderMarkdown(text)) as Record<
      string,
      unknown
    >;

    // The KEY has to exist. Omitting it when there is nothing to say is what let a quoted
    // display name re-fire `.m.rule.contains_display_name` on the reader's account.
    expect(content).toHaveProperty('m.mentions');
    expect(content['m.mentions']).toEqual({});
  });

  it('still carries deliberate mentions', () => {
    const text = 'hi @Alice';
    const content = textMessageContent(text, renderMarkdown(text), [
      { userId: '@alice:hs', display: '@Alice' },
    ]) as Record<string, unknown>;

    expect(content['m.mentions']).toEqual({ user_ids: ['@alice:hs'] });
  });

  it('marks a room mention the sender actually wrote', () => {
    const text = '@room standup in five';
    const content = textMessageContent(text, renderMarkdown(text)) as Record<
      string,
      unknown
    >;

    // Without this, always sending m.mentions would silently remove @room entirely: the
    // legacy `.m.rule.roomnotif` is the only thing that made a typed @room work before.
    expect(content['m.mentions']).toEqual({ room: true });
  });

  it('does NOT mark a room mention that is only being quoted', () => {
    const text = '> @room heads up\n\nseen it';
    const content = textMessageContent(text, renderMarkdown(text)) as Record<
      string,
      unknown
    >;

    // The whole point: carrying someone else's words must not re-ping everyone.
    expect(content['m.mentions']).toEqual({});
  });

  it('recognises @room however it is punctuated', () => {
    // A whitespace-only boundary was the first attempt and is a trap: sending m.mentions
    // SUPPRESSES the legacy `.m.rule.roomnotif`, so any phrasing the client fails to
    // recognise loses its room ping entirely rather than falling back to the old rule.
    // These all matched the legacy word-boundary rule and must keep working.
    for (const text of [
      '@room standup in five',
      '@room, standup in five',
      '@room! now',
      'please review @room.',
      '(@room) heads up',
      '**@room** heads up',
      'ping @room',
    ]) {
      const content = textMessageContent(text, renderMarkdown(text)) as Record<
        string,
        unknown
      >;
      expect(content['m.mentions'], text).toEqual({ room: true });
    }
  });

  it('marks an edited @room, and an edited quote of one', () => {
    const own = 'heads up @room!';
    expect(
      (
        editMessageContent('$m', own, renderMarkdown(own)) as Record<
          string,
          unknown
        >
      )['m.mentions'],
    ).toEqual({ room: true });

    // And the case the top-level block exists for: an edit whose body quotes an @room.
    const quoted = '> @room heads up\n\nseen it';
    expect(
      (
        editMessageContent('$m', quoted, renderMarkdown(quoted)) as Record<
          string,
          unknown
        >
      )['m.mentions'],
    ).toEqual({});
  });

  it('reads @room as a word, not a substring', () => {
    for (const text of ['mail me @roomservice', 'the @rooms list', 'a@room']) {
      const content = textMessageContent(text, renderMarkdown(text)) as Record<
        string,
        unknown
      >;
      expect(content['m.mentions'], text).toEqual({});
    }
  });

  it('scans a reply’s OWN words, not the message it quotes', () => {
    // `replyMessageContent`'s fallback body starts `> <sender> …`, so scanning the BODY
    // would re-ping the room for anyone replying to a message that contained @room.
    const room = {
      roomId: '!r:hs',
      findEventById: () => ({
        getSender: () => '@bob:hs',
        getContent: () => ({ body: '@room everyone look' }),
      }),
    } as unknown as Room;
    const text = 'thanks';
    const reply = replyMessageContent(
      room,
      '$t',
      text,
      renderMarkdown(text),
    ) as Record<string, unknown>;

    expect(reply['body']).toContain('@room'); // the quoted fallback really does carry it
    expect(reply['m.mentions']).toEqual({ user_ids: ['@bob:hs'] });
  });
});
