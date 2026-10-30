import { describe, expect, it } from 'vitest';
import type { MatrixEvent, Room } from 'matrix-js-sdk';
import {
  outgoingReplyText,
  renderMarkdown,
  type Mention,
} from '@trinity/util/matrix';
import { replyMessageContent } from './outgoing-content';

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

describe('replyMessageContent', () => {
  it('escapes a hostile sender id in a reply href', () => {
    const room = replyRoom({ sender: '@a"><img src=x>:hs', body: 'orig' });

    const html = replyMessageContent(
      room,
      '$t',
      outgoingReplyText('hello', renderMarkdown('hello'), []),
    )['formatted_body'] as string;

    expect(html).not.toContain('"><img');
    expect(html).toContain('&quot;');
  });
  it('keeps line breaks in a multi-line reply', () => {
    // A reply always sets format: html, so an unformatted one still renders under
    // `white-space: normal` — the plain-text branch that preserves newlines is not
    // available to it, and a raw \n would arrive as a space.
    const room = replyRoom({ sender: '@bob:hs', body: 'original' });
    const text = 'line one\nline two';

    const html = replyMessageContent(
      room,
      '$t',
      outgoingReplyText(text, renderMarkdown(text), []),
    )['formatted_body'] as string;

    expect(html).toContain('line one<br>line two');
    expect(html).not.toContain('line one\nline two');
  });
  it('a reply pings the replied-to author plus any reply mentions', () => {
    const room = replyRoom({ sender: '@bob:hs', body: 'original' });
    const text = 'thanks @Alice';
    const content = replyMessageContent(
      room,
      '$t',
      outgoingReplyText(text, renderMarkdown(text), [ALICE]),
    );

    expect(mentionIds(content)).toEqual(
      expect.arrayContaining(['@bob:hs', '@alice:hs']),
    );
    expect(content['formatted_body']).toContain('matrix.to/#/@alice:hs');
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
      outgoingReplyText('yes', renderMarkdown('yes'), []),
      target,
    );

    expect(content['body']).toBe('> <@bob:hs> from the server\n\nyes');
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
      outgoingReplyText('yes', renderMarkdown('yes'), []),
      target,
    );

    expect(content['body']).toBe('yes');
    expect(content['formatted_body']).not.toContain('<mx-reply>');
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
      outgoingReplyText(text, renderMarkdown(text), [ALICE]),
    );

    expect(content['body']).toBe(text);
    expect(content['formatted_body']).not.toContain('<mx-reply>');
    expect(content['formatted_body']).toContain('matrix.to/#/@alice:hs');
    expect(content['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$t' },
    });
    expect(mentionIds(content)).toEqual(['@alice:hs']);
  });
  it('scans a reply’s OWN words, not the message it quotes', () => {
    // `replyMessageContent`'s fallback body starts `> <sender> …`, so scanning the BODY
    // would re-ping the room for anyone replying to a message that contained @room.
    const room = replyRoom({ sender: '@bob:hs', body: '@room everyone look' });
    const text = 'thanks';
    const reply = replyMessageContent(
      room,
      '$t',
      outgoingReplyText(text, renderMarkdown(text)),
    ) as Record<string, unknown>;

    expect(reply['body']).toContain('@room'); // the quoted fallback really does carry it
    expect(reply['m.mentions']).toEqual({ user_ids: ['@bob:hs'] });
  });
});
