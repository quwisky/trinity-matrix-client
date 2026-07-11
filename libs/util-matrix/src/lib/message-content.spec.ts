import { describe, expect, it } from 'vitest';
import type { DomSanitizer } from '@angular/platform-browser';
import type { MatrixEvent, Room } from 'matrix-js-sdk';
import {
  editMessageContent,
  locationMessageContent,
  mediaCaptionFields,
  messagePreview,
  parseSlashCommand,
  renderMarkdown,
  replyMessageContent,
  slashCommandContent,
  stickerContent,
  textMessageContent,
  type Mention,
  type RenderedMarkdown,
} from './message-content';
import type { PackImage } from './image-pack';

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

describe('stickerContent', () => {
  it('builds m.sticker content with the declared info fields', () => {
    const image: PackImage = {
      shortcode: 'party',
      url: 'mxc://hs/party',
      body: 'Party Blob',
      width: 128,
      height: 120,
      mimeType: 'image/png',
      size: 4096,
    };

    expect(stickerContent(image)).toEqual({
      body: 'Party Blob',
      url: 'mxc://hs/party',
      info: { w: 128, h: 120, mimetype: 'image/png', size: 4096 },
    });
  });

  it('omits absent info fields, leaving an empty info object', () => {
    const content = stickerContent({
      shortcode: 'wave',
      url: 'mxc://hs/wave',
      body: 'wave',
    });
    expect(content).toEqual({
      body: 'wave',
      url: 'mxc://hs/wave',
      info: {},
    });
  });
});

// mediaCaptionFields only uses the sanitizer via renderMarkdown (marked → sanitize);
// a passthrough stub is enough to exercise the markdown branch without a DOM.
const sanitizer = {
  sanitize: (_ctx: unknown, html: string | null) => html,
} as unknown as DomSanitizer;

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
    });
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
    expect(mediaCaptionFields(sanitizer, 'pic.png', '')).toEqual({
      body: 'pic.png',
    });
    // Whitespace-only is treated as no caption.
    expect(mediaCaptionFields(sanitizer, 'pic.png', '   ')).toEqual({
      body: 'pic.png',
    });
  });

  it('sets body=caption + filename for a plain caption (MSC2530)', () => {
    expect(mediaCaptionFields(sanitizer, 'pic.png', 'a caption')).toEqual({
      body: 'a caption',
      filename: 'pic.png',
    });
  });

  it('trims the caption', () => {
    expect(mediaCaptionFields(sanitizer, 'pic.png', '  hi  ')).toEqual({
      body: 'hi',
      filename: 'pic.png',
    });
  });

  it('adds a formatted_body for a markdown caption', () => {
    const fields = mediaCaptionFields(
      sanitizer,
      'pic.png',
      'a **bold** caption',
    );
    expect(fields['body']).toBe('a **bold** caption');
    expect(fields['filename']).toBe('pic.png');
    expect(fields['format']).toBe('org.matrix.custom.html');
    expect(fields['formatted_body']).toContain('<strong>bold</strong>');
  });

  it('omits format for a caption with no markdown formatting', () => {
    const fields = mediaCaptionFields(sanitizer, 'pic.png', 'just text');
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
    const content = textMessageContent(text, renderMarkdown(sanitizer, text), [
      ALICE,
    ]);

    expect(content.body).toBe('hey @Alice'); // plain body keeps the readable @name
    expect(content.format).toBe('org.matrix.custom.html');
    expect(content.formatted_body).toContain(
      '<a href="https://matrix.to/#/@alice:hs">@Alice</a>',
    );
    expect(mentionIds(content)).toEqual(['@alice:hs']);
  });

  it('stays plain text with no mention and no markdown', () => {
    const text = 'just text';
    expect(textMessageContent(text, renderMarkdown(sanitizer, text))).toEqual({
      msgtype: 'm.text',
      body: 'just text',
    });
  });

  it("keeps an edit's mentions in m.new_content, off the top-level replace", () => {
    const text = 'fixed @Alice';
    const content = editMessageContent(
      '$m',
      text,
      renderMarkdown(sanitizer, text),
      [ALICE],
    ) as Record<string, unknown>;

    // No top-level m.mentions → editing keeps existing pings from re-notifying.
    expect(mentionIds(content)).toEqual([]);
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
    const html = textMessageContent(text, renderMarkdown(sanitizer, text), [
      evil,
    ]).formatted_body as string;

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
      renderMarkdown(sanitizer, 'hello'),
      [],
    ).formatted_body as string;

    expect(html).not.toContain('"><img');
    expect(html).toContain('&quot;');
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
      renderMarkdown(sanitizer, text),
      [ALICE],
    );

    expect(mentionIds(content)).toEqual(
      expect.arrayContaining(['@bob:hs', '@alice:hs']),
    );
    expect(content.formatted_body).toContain('matrix.to/#/@alice:hs');
  });

  it('pills and lists every mention in a multi-mention message', () => {
    const text = 'hi @Alice and @Bob';
    const content = textMessageContent(text, renderMarkdown(sanitizer, text), [
      ALICE,
      { userId: '@bob:hs', display: '@Bob' },
    ]);

    expect(mentionIds(content)).toEqual(['@alice:hs', '@bob:hs']);
    expect(content.formatted_body).toContain('matrix.to/#/@alice:hs');
    expect(content.formatted_body).toContain('matrix.to/#/@bob:hs');
  });

  it('HTML-escapes a mention display in the pill', () => {
    const text = 'hi @A&B';
    const content = textMessageContent(text, renderMarkdown(sanitizer, text), [
      { userId: '@ab:hs', display: '@A&B' },
    ]);

    // The pill text is escaped (matches the form marked emitted); no raw ampersand.
    expect(content.formatted_body).toContain(
      '<a href="https://matrix.to/#/@ab:hs">@A&amp;B</a>',
    );
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
