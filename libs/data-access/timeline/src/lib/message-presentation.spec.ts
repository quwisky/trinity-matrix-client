import { describe, expect, it } from 'vitest';
import {
  isEditableMessage,
  isQuotableMessage,
  savableMediaKind,
  presentNormalizedTimelineEvent,
  type MessageView,
  type NormalizedTimelineEvent,
} from './message-presentation';

const BASE = {
  id: '$event',
  senderId: '@alice:example.org',
  senderName: 'Alice',
  senderInitial: 'A',
  senderAvatarMxc: null,
  timestamp: 42,
  isOwn: false,
  edited: false,
  reactions: [],
  replyTo: null,
  status: null,
  readReceipts: [],
  shield: null,
} as const;

describe('Message Presentation', () => {
  it.each([
    ['missing-key', '⚠️ Unable to decrypt this message', false],
    [
      'device-unverified',
      '⚠️ You can’t read this message because this device wasn’t verified when it was sent',
      true,
    ],
    [
      'history-locked',
      '⚠️ Unlock your encrypted messages on this device to read messages sent before you signed in',
      true,
    ],
    [
      'withheld',
      '⚠️ The sender didn’t share the key for this message with this device',
      false,
    ],
    [
      'sent-before-sign-in',
      '⚠️ This message was sent before you signed in on this device, and there’s no backup to restore it from',
      false,
    ],
    [
      'sent-before-joining',
      '⚠️ This message was sent before you joined the room',
      false,
    ],
    ['unverified-sender-device', '⚠️ Sent from an unverified device', false],
    [
      'sender-identity-changed',
      '⚠️ The sender’s identity changed after you verified them',
      false,
    ],
  ] as const)(
    'explains an undecryptable message (%s)',
    (reason, body, deviceFixable) => {
      const presentation = presentNormalizedTimelineEvent({
        ...BASE,
        type: 'unsupported',
        fallback: 'undecryptable-message',
        decryptionFailed: true,
        body: '',
        replyFallback: false,
        undecryptableReason: reason,
      });

      expect(presentation).toMatchObject({
        kind: 'unsupported',
        body,
        decryptionFailed: true,
        undecryptable: { reason, deviceFixable },
      });
      expect(Object.isFrozen(presentation?.undecryptable)).toBe(true);
    },
  );

  it('keeps the generic text when no reason was recorded', () => {
    const presentation = presentNormalizedTimelineEvent({
      ...BASE,
      type: 'unsupported',
      fallback: 'undecryptable-message',
      decryptionFailed: true,
      body: '',
      replyFallback: false,
    });

    expect(presentation).toMatchObject({
      body: '⚠️ Unable to decrypt this message',
      undecryptable: { reason: 'missing-key', deviceFixable: false },
    });
  });

  it('says nothing about decryption for other unsupported messages', () => {
    const presentation = presentNormalizedTimelineEvent({
      ...BASE,
      type: 'unsupported',
      fallback: 'unsupported-message',
      decryptionFailed: false,
      body: 'a custom event',
      replyFallback: false,
    });

    expect(presentation).toMatchObject({
      body: 'a custom event',
      undecryptable: null,
    });
  });
  it('presents normalized plain text with an HTTPS-only preview policy', () => {
    const event: NormalizedTimelineEvent = {
      ...BASE,
      type: 'text',
      messageKind: 'text',
      body: 'Read https://example.org/docs and javascript:alert(1)',
      formattedBody: null,
      replyFallback: false,
      addressesViewer: false,
      mentionNames: {},
      roomEncrypted: true,
      roomId: '!room:example.org',
    };

    const presentation = presentNormalizedTimelineEvent(event);

    expect(presentation).toMatchObject({
      kind: 'text',
      body: event.body,
      previewUrl: 'https://example.org/docs',
      previewEncrypted: true,
      previewRoomId: '!room:example.org',
    });
    expect(presentation?.html).toContain(
      '<a href="https://example.org/docs" target="_blank" rel="noopener noreferrer">https://example.org/docs</a>',
    );
    expect(presentation?.html).not.toContain('href="javascript:');
    expect(Object.isFrozen(presentation)).toBe(true);
  });

  it('sanitizes formatted text inside the boundary', () => {
    const presentation = presentNormalizedTimelineEvent({
      ...BASE,
      type: 'text',
      messageKind: 'notice',
      body: 'const',
      formattedBody:
        '<script>alert(1)</script><pre><code class="language-typescript">const</code></pre><a href="javascript:alert(2)">bad</a>',
      replyFallback: false,
      addressesViewer: false,
      mentionNames: {},
      roomEncrypted: false,
      roomId: '!room:example.org',
    });

    expect(presentation?.kind).toBe('notice');
    expect(presentation?.html).not.toContain('<script');
    expect(presentation?.html).not.toContain('javascript:');
    expect(presentation?.html).toContain('language-typescript');
  });

  it('keeps link previews restricted to ordinary text messages', () => {
    for (const messageKind of ['emote', 'notice'] as const) {
      const presentation = presentNormalizedTimelineEvent({
        ...BASE,
        type: 'text',
        messageKind,
        body: 'https://example.org/private-context',
        formattedBody: null,
        replyFallback: false,
        addressesViewer: false,
        mentionNames: {},
        roomEncrypted: true,
        roomId: '!room:example.org',
      });

      expect(presentation?.previewUrl).toBeNull();
    }
  });

  it('presents supported normalized system changes with an explicit category', () => {
    const presentation = presentNormalizedTimelineEvent({
      ...BASE,
      edited: true,
      reactions: [{ key: '👍', count: 1, reacted: false, reactors: ['Alice'] }],
      readReceipts: [
        {
          userId: '@bob:example.org',
          name: 'Bob',
          initial: 'B',
          avatarMxc: null,
        },
      ],
      shield: {
        level: 'red',
        reason: 'Unsigned',
        explanation: 'Ignored on system rows',
      },
      type: 'system',
      change: {
        kind: 'room-name',
        actorName: 'Alice',
        previousName: 'Lobby',
        name: 'General',
      },
    });

    expect(presentation).toMatchObject({
      kind: 'event',
      summary: 'Alice changed the room name to "General"',
      body: 'Alice changed the room name to "General"',
      systemCategory: 'room',
      edited: false,
      reactions: [],
      readReceipts: [],
      shield: null,
    });
    expect(Object.isFrozen(presentation)).toBe(true);
  });

  it('turns a normalization failure into an explicit immutable fallback', () => {
    const presentation = presentNormalizedTimelineEvent({
      ...BASE,
      type: 'unsupported',
      fallback: 'unsupported-message',
      decryptionFailed: false,
      body: '',
      replyFallback: false,
    });

    expect(presentation).toMatchObject({
      kind: 'unsupported',
      body: '[unsupported message]',
      decryptionFailed: false,
    });
    expect(Object.isFrozen(presentation)).toBe(true);
  });

  it('preserves safe plaintext for unsupported message types', () => {
    const presentation = presentNormalizedTimelineEvent({
      ...BASE,
      type: 'unsupported',
      fallback: 'unsupported-message',
      decryptionFailed: false,
      body: 'Readable custom event',
      replyFallback: false,
    });

    expect(presentation).toMatchObject({
      kind: 'unsupported',
      body: 'Readable custom event',
      html: null,
    });
  });

  it('strips a reply fallback from unsupported plaintext', () => {
    const presentation = presentNormalizedTimelineEvent({
      ...BASE,
      type: 'unsupported',
      fallback: 'unsupported-message',
      decryptionFailed: false,
      body: '> <@alice:example.org> quoted\n\nReadable custom reply',
      replyFallback: true,
    });

    expect(presentation?.body).toBe('Readable custom reply');
  });

  it('uses the normalized mention fact without reconstructing Matrix content', () => {
    const presentation = presentNormalizedTimelineEvent({
      ...BASE,
      type: 'text',
      messageKind: 'text',
      body: '@me:example.org',
      formattedBody: '<a href="https://matrix.to/#/@me:example.org">Me</a>',
      replyFallback: false,
      addressesViewer: true,
      mentionNames: {},
      roomEncrypted: false,
      roomId: '!room:example.org',
    });

    expect(presentation?.html).toContain('mention--self');
  });

  it('names mention pills from the normalized member names', () => {
    const presentation = presentNormalizedTimelineEvent({
      ...BASE,
      type: 'text',
      messageKind: 'text',
      body: '@Boss',
      formattedBody: '<a href="https://matrix.to/#/@a:example.org">@Boss</a>',
      replyFallback: false,
      addressesViewer: false,
      mentionNames: { '@a:example.org': 'Ann' },
      roomEncrypted: false,
      roomId: '!room:example.org',
    });

    expect(presentation?.html).toContain('>@Ann</a>');
  });
});

function view(over: Partial<MessageView> = {}): MessageView {
  const presentation = presentNormalizedTimelineEvent({
    ...BASE,
    type: 'text',
    messageKind: 'text',
    body: 'hi',
    formattedBody: null,
    replyFallback: false,
    addressesViewer: false,
    mentionNames: {},
    roomEncrypted: false,
    roomId: '!room:example.org',
  });
  if (!presentation) throw new Error('Text presentation unexpectedly absent');
  return { ...presentation, isOwn: true, ...over };
}

describe('Message Presentation capabilities', () => {
  it('edits only own confirmed decryptable text-like messages', () => {
    for (const kind of ['text', 'emote', 'notice'] as const) {
      expect(isEditableMessage(view({ kind }))).toBe(true);
    }
    expect(isEditableMessage(view({ kind: 'poll' }))).toBe(false);
    expect(isEditableMessage(view({ isOwn: false }))).toBe(false);
    expect(isEditableMessage(view({ status: 'failed' }))).toBe(false);
    expect(isEditableMessage(view({ decryptionFailed: true }))).toBe(false);
  });

  it('quotes meaningful decryptable text-like bodies only', () => {
    expect(isQuotableMessage(view({ isOwn: false }))).toBe(true);
    expect(isQuotableMessage(view({ status: 'sending' }))).toBe(true);
    expect(isQuotableMessage(view({ kind: 'image' }))).toBe(false);
    expect(isQuotableMessage(view({ decryptionFailed: true }))).toBe(false);
    expect(isQuotableMessage(view({ body: '   ' }))).toBe(false);
  });

  it('offers saving only for image and video messages with a media payload', () => {
    const media = { id: 'm' } as MessageView['media'];
    expect(savableMediaKind(view({ kind: 'image', media }))).toBe('image');
    expect(savableMediaKind(view({ kind: 'video', media }))).toBe('video');
    expect(savableMediaKind(view({ kind: 'image', media: null }))).toBeNull();
    expect(savableMediaKind(view({ kind: 'file', media }))).toBeNull();
    expect(savableMediaKind(view({ kind: 'text' }))).toBeNull();
    expect(savableMediaKind(view({ kind: 'sticker', media }))).toBeNull();
    expect(
      savableMediaKind(view({ kind: 'redacted', media: null })),
    ).toBeNull();
  });

  it('does not offer saving media that is still unsent or failed', () => {
    const media = { id: 'm' } as MessageView['media'];
    expect(
      savableMediaKind(view({ kind: 'image', media, status: 'sending' })),
    ).toBeNull();
    expect(
      savableMediaKind(view({ kind: 'video', media, status: 'failed' })),
    ).toBeNull();
  });
});
