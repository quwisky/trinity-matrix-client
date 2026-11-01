import { describe, expect, it } from 'vitest';
import { PREVIEW_LIMIT } from '../notification-policy';
import { inboxPreview, mergeInboxRows, type InboxRow } from './inbox-rows';

const row = (eventId: string, ts: number, roomName = 'Room'): InboxRow => ({
  accountId: '@me:hs',
  eventId,
  roomId: '!r:hs',
  roomName,
  senderName: null,
  ts,
  preview: { kind: 'unavailable' },
  unread: false,
  threadRootId: null,
});

describe('mergeInboxRows', () => {
  it('merges by event ID, newest first, and the first list wins', () => {
    const merged = mergeInboxRows(
      [row('$b', 2, 'first'), row('$a', 1)],
      [row('$c', 3), row('$b', 2, 'second')],
    );
    expect(merged.map((r) => r.eventId)).toEqual(['$c', '$b', '$a']);
    expect(merged[1]?.roomName).toBe('first');
  });

  it('orders one millisecond by event ID, as the index does', () => {
    expect(
      mergeInboxRows([row('$a', 1), row('$b', 1)]).map((r) => r.eventId),
    ).toEqual(['$b', '$a']);
  });
});

describe('inboxPreview', () => {
  it('caps preview text at PREVIEW_LIMIT', () => {
    const preview = inboxPreview('show', 'x'.repeat(PREVIEW_LIMIT + 1));
    expect(preview).toEqual({ kind: 'text', text: 'x'.repeat(PREVIEW_LIMIT) });
  });

  it('shows text under hide-on-lock-screen and none under Always hide', () => {
    expect(inboxPreview('hide-on-lock-screen', 'hi')).toEqual({
      kind: 'text',
      text: 'hi',
    });
    expect(inboxPreview('always-hide', 'hi')).toEqual({ kind: 'hidden' });
  });

  it('falls back to the generic body with no text, as notifications do', () => {
    expect(inboxPreview('show', null)).toEqual({ kind: 'hidden' });
    expect(inboxPreview('show', '  \n ')).toEqual({ kind: 'hidden' });
  });
});
