import { describe, expect, it } from 'vitest';
import { MatrixEvent, type Room } from 'matrix-js-sdk';
import { renderMarkdown } from './markdown-render';
import { messagePreview, replyMessageContent } from './message-content';
import { replyPreview } from './message-view';
import { displayContent, validReplacement } from './replacement';

const ALICE = '@alice:hs';
const MALLORY = '@mallory:hs';

/** A real SDK message, in the clear unless `encrypted`, when it is sealed as sent. */
function sdkMessage(
  id: string,
  content: Record<string, unknown>,
  { sender = ALICE, encrypted = false } = {},
): MatrixEvent {
  const event = new MatrixEvent({
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

describe('validReplacement and displayContent', () => {
  it('apply an edit from the same sender to the same event', () => {
    const edit = sdkEdit('$orig', 'v2');
    const event = editedWith(edit);

    expect(validReplacement(event)).toBe(edit);
    expect(displayContent(event)['body']).toBe('v2');
  });

  it('ignore an edit from another sender', () => {
    const event = editedWith(sdkEdit('$orig', 'forged', { sender: MALLORY }));

    expect(validReplacement(event)).toBeUndefined();
    expect(displayContent(event)['body']).toBe('v1');
  });

  it('ignore an edit that points at another event', () => {
    const event = editedWith(sdkEdit('$other', 'v2'));

    expect(validReplacement(event)).toBeUndefined();
    expect(displayContent(event)['body']).toBe('v1');
  });

  it('ignore an edit of another type', () => {
    const edit = new MatrixEvent({
      event_id: '$sticker-edit',
      sender: ALICE,
      type: 'm.sticker',
      content: {
        'm.new_content': { body: 'v2' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
      },
    });
    const event = editedWith(edit);

    expect(validReplacement(event)).toBeUndefined();
    expect(displayContent(event)['body']).toBe('v1');
  });

  it.each([
    ['missing', undefined],
    ['not an object', 'v2'],
    ['an array', [{ body: 'v2' }]],
    ['null', null],
  ])(
    'keep the original when m.new_content is %s instead of blanking it',
    (_, newContent) => {
      const event = editedWith(sdkEdit('$orig', 'v2', { newContent }));

      expect(validReplacement(event)).toBeUndefined();
      expect(displayContent(event)['body']).toBe('v1');
    },
  );

  it('apply an encrypted edit to an encrypted message, reading the relation from the wire', () => {
    const edit = sdkEdit('$orig', 'v2', { encrypted: true });
    const event = editedWith(edit, true);

    expect(validReplacement(event)).toBe(edit);
    expect(displayContent(event)['body']).toBe('v2');
  });

  it('ignore an encrypted edit from another member of an encrypted room', () => {
    const event = editedWith(
      sdkEdit('$orig', 'forged', { sender: MALLORY, encrypted: true }),
      true,
    );

    expect(validReplacement(event)).toBeUndefined();
    expect(displayContent(event)['body']).toBe('v1');
  });

  it('ignore an unencrypted edit of an encrypted message', () => {
    const event = editedWith(sdkEdit('$orig', 'v2'), true);

    expect(validReplacement(event)).toBeUndefined();
    expect(displayContent(event)['body']).toBe('v1');
  });

  it('apply an encrypted edit to an unencrypted message', () => {
    const edit = sdkEdit('$orig', 'v2', { encrypted: true });
    const event = editedWith(edit);

    expect(validReplacement(event)).toBe(edit);
    expect(displayContent(event)['body']).toBe('v2');
  });

  it('show the original while the edit is still undecrypted', () => {
    const sealed = new MatrixEvent({
      event_id: '$sealed-edit',
      sender: ALICE,
      type: 'm.room.encrypted',
      content: {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'sealed',
        'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
      },
    });
    const event = editedWith(sealed, true);

    expect(validReplacement(event)).toBeUndefined();
    expect(displayContent(event)['body']).toBe('v1');
  });

  it('judge a candidate edit other than the attached one', () => {
    const event = sdkMessage('$orig', { msgtype: 'm.text', body: 'v1' });

    expect(validReplacement(event, sdkEdit('$orig', 'v2'))).toBeDefined();
    expect(
      validReplacement(event, sdkEdit('$orig', 'v2', { sender: MALLORY })),
    ).toBeUndefined();
  });

  describe('for an edit that carries its own attached edit', () => {
    const nested = (newContent: unknown) =>
      new MatrixEvent({
        event_id: '$nested',
        room_id: '!r:hs',
        sender: MALLORY,
        type: 'm.room.message',
        content: { 'm.new_content': newContent },
      });

    it("apply the edit's own new content, nothing from the edit attached to it", () => {
      const edit = sdkEdit('$orig', 'v2');
      edit.makeReplaced(
        nested({ 'm.new_content': { msgtype: 'm.text', body: 'FORGED' } }),
      );
      const event = editedWith(edit);

      expect(validReplacement(event)).toBe(edit);
      expect(displayContent(event)['body']).toBe('v2');
      expect(messagePreview(event, false)).toBe('v2');
    });

    it('keep the original when only the attached edit has new content', () => {
      const edit = sdkEdit('$orig', 'v2', { newContent: undefined });
      edit.makeReplaced(
        nested({ 'm.new_content': { msgtype: 'm.text', body: 'FORGED' } }),
      );
      const event = editedWith(edit);

      expect(validReplacement(event)).toBeUndefined();
      expect(displayContent(event)['body']).toBe('v1');
    });
  });

  it('ignore an edit of an edit', () => {
    const first = sdkEdit('$orig', 'v2');
    const second = sdkEdit(first.getId()!, 'v3');
    first.makeReplaced(second);

    expect(validReplacement(first)).toBeUndefined();
    expect(displayContent(first)['m.new_content']).toEqual({
      msgtype: 'm.text',
      body: 'v2',
    });
  });

  it('never read a still-encrypted edit, even when its envelope claims new content', () => {
    const sealed = (id: string, content: Record<string, unknown>) =>
      new MatrixEvent({
        event_id: id,
        room_id: '!r:hs',
        sender: ALICE,
        type: 'm.room.encrypted',
        content: {
          algorithm: 'm.megolm.v1.aes-sha2',
          ciphertext: 'sealed',
          ...content,
        },
      });
    const event = sealed('$orig', {});
    event.makeReplaced(
      sealed('$sealed-edit', {
        'm.new_content': { msgtype: 'm.text', body: 'FORGED' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
      }),
    );

    expect(validReplacement(event)).toBeUndefined();
    expect(displayContent(event)['body']).toBeUndefined();
  });

  it('show an unedited message as it is', () => {
    const event = sdkMessage('$orig', { msgtype: 'm.text', body: 'v1' });

    expect(validReplacement(event)).toBeUndefined();
    expect(displayContent(event)['body']).toBe('v1');
  });
});

describe('previews of an edited message', () => {
  const forged = () =>
    editedWith(sdkEdit('$orig', 'forged', { sender: MALLORY }));
  const roomWith = (target: MatrixEvent) =>
    ({
      roomId: '!r:hs',
      findEventById: () => target,
      getMember: () => null,
    }) as unknown as Room;
  const replyQuote = (target: MatrixEvent) =>
    replyMessageContent(roomWith(target), '$orig', 'ok', renderMarkdown('ok'))
      .body;

  it('show a valid edit', () => {
    const event = editedWith(sdkEdit('$orig', 'v2'));

    expect(messagePreview(event, false)).toBe('v2');
    expect(replyPreview(roomWith(event), '$orig', false)?.body).toBe('v2');
    expect(replyQuote(event)).toContain('> <@alice:hs> v2');
  });

  it('show the original over an edit from another sender in a room-list preview', () => {
    expect(messagePreview(forged(), false)).toBe('v1');
  });

  it('show the original over an edit from another sender in a reply preview', () => {
    expect(replyPreview(roomWith(forged()), '$orig', false)?.body).toBe('v1');
  });

  it('show and quote an encrypted message over its unencrypted edit', () => {
    const event = () => editedWith(sdkEdit('$orig', 'v2'), true);

    expect(messagePreview(event(), false)).toBe('v1');
    expect(replyPreview(roomWith(event()), '$orig', false)?.body).toBe('v1');
    expect(replyQuote(event())).toContain('> <@alice:hs> v1');
  });

  it('quote the original over an edit from another sender in a reply', () => {
    expect(replyQuote(forged())).toContain('> <@alice:hs> v1');
  });
});
