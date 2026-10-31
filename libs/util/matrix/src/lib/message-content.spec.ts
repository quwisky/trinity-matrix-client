import { describe, expect, it } from 'vitest';
import { MatrixEvent, type Room } from 'matrix-js-sdk';
import {
  editMessageContent,
  emoteMessageContent,
  locationMessageContent,
  mediaCaptionFields,
  messagePreview,
  parseSlashCommand,
  replyMessageContent,
  slashCommandContent,
  textMessageContent,
  type Mention,
} from './message-content';
import { renderMarkdown, type RenderedMarkdown } from './markdown-render';

describe('custom emoji in content builders', () => {
  it('an emoji-only message still sends formatted_body', () => {
    const content = textMessageContent(
      ':wave:',
      renderMarkdown(':wave:', new Map([['wave', 'mxc://hs/wave']])),
    );

    expect(content).toMatchObject({
      body: ':wave:',
      format: 'org.matrix.custom.html',
    });
    expect('formatted_body' in content ? content.formatted_body : '').toMatch(
      /^<p><img data-mx-emoticon="" src="mxc:\/\/hs\/wave" alt=":wave:" title=":wave:" height="32"><\/p>/,
    );
  });
});

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

/** A room whose `findEventById` returns the replied-to event, or nothing when omitted. */
function replyRoom(target?: { sender: string; body: string }): Room {
  return {
    roomId: '!r:hs',
    findEventById: () =>
      target && {
        getSender: () => target.sender,
        isDecryptionFailure: () => false,
        isRedacted: () => false,
        replacingEvent: () => null,
        getOriginalContent: () => ({ body: target.body }),
      },
  } as unknown as Room;
}

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
    const room = replyRoom({ sender: '@a"><img src=x>:hs', body: 'orig' });

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
    const room = replyRoom({ sender: '@bob:hs', body: 'original' });
    const text = 'line one\nline two';

    const html = replyMessageContent(room, '$t', text, renderMarkdown(text), [])
      .formatted_body as string;

    expect(html).toContain('line one<br>line two');
    expect(html).not.toContain('line one\nline two');
  });

  it('a reply pings the replied-to author plus any reply mentions', () => {
    const room = replyRoom({ sender: '@bob:hs', body: 'original' });
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

  it('quotes a target the caller fetched when the room no longer holds it', () => {
    const room = replyRoom();
    const target = {
      getSender: () => '@bob:hs',
      isDecryptionFailure: () => false,
      isRedacted: () => false,
      replacingEvent: () => null,
      getOriginalContent: () => ({ body: 'from the server' }),
    } as unknown as MatrixEvent;

    const content = replyMessageContent(
      room,
      '$t',
      'yes',
      renderMarkdown('yes'),
      [],
      target,
    );

    expect(content.body).toBe('> <@bob:hs> from the server\n\nyes');
    expect(mentionIds(content)).toEqual(['@bob:hs']);
  });

  it('pings the author of a target that failed to decrypt without quoting it', () => {
    const room = replyRoom();
    const target = {
      getSender: () => '@bob:hs',
      isRedacted: () => false,
      replacingEvent: () => null,
      getOriginalContent: () => ({ body: '** Unable to decrypt: no key **' }),
      isDecryptionFailure: () => true,
    } as unknown as MatrixEvent;

    const content = replyMessageContent(
      room,
      '$t',
      'yes',
      renderMarkdown('yes'),
      [],
      target,
    );

    expect(content.body).toBe('yes');
    expect(content.formatted_body).not.toContain('<mx-reply>');
    expect(content['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$t' },
    });
    expect(mentionIds(content)).toEqual(['@bob:hs']);
  });

  it('sends a reply to an unknown target without an empty quote', () => {
    const room = replyRoom();
    const text = 'thanks @Alice';

    const content = replyMessageContent(
      room,
      '$t',
      text,
      renderMarkdown(text),
      [ALICE],
    );

    expect(content.body).toBe(text);
    expect(content.formatted_body).not.toContain('<mx-reply>');
    expect(content.formatted_body).toContain('matrix.to/#/@alice:hs');
    expect(content['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$t' },
    });
    expect(mentionIds(content)).toEqual(['@alice:hs']);
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
  encrypted?: boolean;
  edit?: MatrixEvent;
}): MatrixEvent {
  return {
    getOriginalContent: () => ({ body: o.body ?? '' }),
    isRedacted: () => o.redacted ?? false,
    isDecryptionFailure: () => o.decryptFail ?? false,
    isEncrypted: () => o.encrypted ?? false,
    isState: () => false,
    replacingEvent: () => o.edit ?? null,
    status: null,
  } as unknown as MatrixEvent;
}

describe('messagePreview', () => {
  // The SDK's setClearData puts the content back when a decrypt outlasts the deletion.
  it('hides the text of a message deleted while it was decrypting', async () => {
    const event = new MatrixEvent({
      type: 'm.room.encrypted',
      event_id: '$event',
      sender: '@alice:hs',
      room_id: '!r:hs',
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'opaque' },
    });
    let answer: (result: { clearEvent: object }) => void = () => undefined;
    const decrypting = event.attemptDecryption({
      decryptEvent: () => new Promise((resolve) => (answer = resolve)),
    } as unknown as Parameters<MatrixEvent['attemptDecryption']>[0]);
    await Promise.resolve();
    event.makeRedacted(
      new MatrixEvent({ type: 'm.room.redaction', content: {} }),
      {} as Room,
    );
    answer({
      clearEvent: {
        type: 'm.room.message',
        content: { msgtype: 'm.text', body: 'secret' },
      },
    });
    await decrypting;

    expect(event.getContent()['body']).toBe('secret');
    expect(messagePreview(event)).toBe('(message deleted)');
  });

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

  it('previews an encrypted message as sent, not its edit that arrived in the clear', () => {
    const edit = {
      getSender: () => '@a:hs',
      getType: () => 'm.room.message',
      getRelation: () => ({ rel_type: 'm.replace', event_id: '$e' }),
      getOriginalContent: () => ({ 'm.new_content': { body: 'edited' } }),
      isEncrypted: () => false,
      isRedacted: () => false,
      isState: () => false,
      status: null,
    } as unknown as MatrixEvent;
    const event = Object.assign(
      fakeEvent({ body: 'original', encrypted: true, edit }),
      {
        getId: () => '$e',
        getSender: () => '@a:hs',
        getType: () => 'm.room.message',
        isRelation: () => false,
      },
    );
    expect(messagePreview(event)).toBe('original');
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
    const room = replyRoom({ sender: '@bob:hs', body: '@room everyone look' });
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
