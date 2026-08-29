import { describe, expect, it } from 'vitest';
import { setCodeHighlighter } from '@trinity/util/matrix';
import {
  isEditableMessage,
  isQuotableMessage,
  presentNormalizedTimelineEvent,
  presentNormalizedTimelineEvents,
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
  it('presents normalized plain text with an HTTPS-only preview policy', () => {
    const event: NormalizedTimelineEvent = {
      ...BASE,
      type: 'text',
      messageKind: 'text',
      body: 'Read https://example.org/docs and javascript:alert(1)',
      formattedBody: null,
      replyFallback: false,
      addressesViewer: false,
      roomEncrypted: true,
    };

    const presentation = presentNormalizedTimelineEvent(event);

    expect(presentation).toMatchObject({
      kind: 'text',
      body: event.body,
      previewUrl: 'https://example.org/docs',
      previewEncrypted: true,
    });
    expect(presentation?.html).toContain(
      '<a href="https://example.org/docs">https://example.org/docs</a>',
    );
    expect(presentation?.html).not.toContain('href="javascript:');
    expect(Object.isFrozen(presentation)).toBe(true);
  });

  it('sanitizes formatted text and applies highlighting inside the boundary', () => {
    setCodeHighlighter((_source, _language, document) => {
      const fragment = document.createDocumentFragment();
      const token = document.createElement('span');
      token.className = 'tok-keyword';
      token.textContent = 'const';
      fragment.append(token);
      return fragment;
    });

    try {
      const presentation = presentNormalizedTimelineEvent({
        ...BASE,
        type: 'text',
        messageKind: 'notice',
        body: 'const',
        formattedBody:
          '<script>alert(1)</script><pre><code class="language-typescript">const</code></pre><a href="javascript:alert(2)">bad</a>',
        replyFallback: false,
        addressesViewer: false,
        roomEncrypted: false,
      });

      expect(presentation?.kind).toBe('notice');
      expect(presentation?.html).not.toContain('<script');
      expect(presentation?.html).not.toContain('javascript:');
      expect(presentation?.html).toContain('tok-keyword');
    } finally {
      setCodeHighlighter(null);
    }
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
        roomEncrypted: true,
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

  it('reports content-free per-event and batch timing evidence', () => {
    const event: NormalizedTimelineEvent = {
      ...BASE,
      type: 'text',
      messageKind: 'text',
      body: 'secret body that diagnostics must not retain',
      formattedBody: null,
      replyFallback: false,
      addressesViewer: false,
      roomEncrypted: false,
    };

    const batch = presentNormalizedTimelineEvents([event, event]);

    expect(batch.messages).toHaveLength(2);
    expect(batch.metrics.eventCount).toBe(2);
    expect(batch.metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(batch.metrics.averageEventDurationMs).toBe(
      batch.metrics.durationMs / 2,
    );
    expect(JSON.stringify(batch.metrics)).not.toContain(event.body);
    expect(Object.isFrozen(batch.metrics)).toBe(true);
    expect(Object.isFrozen(batch.messages)).toBe(true);
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
      roomEncrypted: false,
    });

    expect(presentation?.html).toContain('mention--self');
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
    roomEncrypted: false,
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
});
