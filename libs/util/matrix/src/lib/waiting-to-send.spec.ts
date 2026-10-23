import {
  ConnectionError,
  EventStatus,
  MatrixError,
  MatrixEvent,
} from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import { isWaitingToSend } from './waiting-to-send';

function echo({
  type = 'm.room.message',
  content = { msgtype: 'm.text', body: 'hello' },
  status = EventStatus.NOT_SENT,
  error = new ConnectionError('offline'),
}: {
  readonly type?: string;
  readonly content?: Record<string, unknown>;
  readonly status?: EventStatus | null;
  readonly error?: unknown;
} = {}): MatrixEvent {
  const event = new MatrixEvent({ type, content });
  event.status = status;
  event.error = error as MatrixError;
  return event;
}

describe('isWaitingToSend', () => {
  it.each(['m.text', 'm.emote', 'm.notice'])(
    'is true for a %s echo that failed with a ConnectionError',
    (msgtype) => {
      expect(isWaitingToSend(echo({ content: { msgtype, body: 'hi' } }))).toBe(
        true,
      );
    },
  );

  it('is false for an echo that failed with an AbortError or a 4xx', () => {
    expect(
      isWaitingToSend(
        echo({ error: new DOMException('timed out', 'AbortError') }),
      ),
    ).toBe(false);
    expect(
      isWaitingToSend(
        echo({
          error: new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
        }),
      ),
    ).toBe(false);
  });

  it('is false for a sent echo', () => {
    expect(isWaitingToSend(echo({ status: EventStatus.SENT }))).toBe(false);
  });

  it.each(['m.image', 'm.file', 'm.video', 'm.audio'])(
    'is false for %s, whose echo the media pipeline owns',
    (msgtype) => {
      expect(isWaitingToSend(echo({ content: { msgtype, body: 'x' } }))).toBe(
        false,
      );
    },
  );

  it.each([
    ['a sticker', 'm.sticker'],
    ['a reaction', 'm.reaction'],
    ['a redaction', 'm.room.redaction'],
  ])('is false for %s', (_name, type) => {
    expect(isWaitingToSend(echo({ type, content: {} }))).toBe(false);
  });

  it('is false for an m.replace edit', () => {
    expect(
      isWaitingToSend(
        echo({
          content: {
            msgtype: 'm.text',
            body: '* fixed',
            'm.new_content': { msgtype: 'm.text', body: 'fixed' },
            'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
          },
        }),
      ),
    ).toBe(false);
  });
});
