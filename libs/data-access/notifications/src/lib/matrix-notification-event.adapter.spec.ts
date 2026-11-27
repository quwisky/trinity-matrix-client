import { describe, expect, it } from 'vitest';
import type { MatrixEvent, Room } from 'matrix-js-sdk';
import { normalizeNotificationEvent } from './matrix-notification-event.adapter';

const room = { roomId: '!r:hs', name: 'Alice' } as unknown as Room;

function ringEvent(notificationType: string): MatrixEvent {
  const content = { notification_type: notificationType };
  return {
    getSender: () => '@alice:hs',
    sender: { name: 'Alice' },
    getId: () => '$ring',
    getType: () => 'org.matrix.msc4075.rtc.notification',
    getOriginalContent: () => content,
    isRedacted: () => false,
    replacingEvent: () => null,
    isEncrypted: () => true,
  } as unknown as MatrixEvent;
}

describe('normalizeNotificationEvent for a call event', () => {
  it('reads a ring as an incoming call', () => {
    expect(
      normalizeNotificationEvent('a', ringEvent('ring'), room, true),
    ).toMatchObject({ body: 'Incoming call', kind: 'message' });
  });

  it('reads a plain call notification as a started call', () => {
    expect(
      normalizeNotificationEvent('a', ringEvent('notification'), room, true),
    ).toMatchObject({ body: 'Call started', kind: 'message' });
  });

  it('carries whether the room is a direct chat', () => {
    expect(
      normalizeNotificationEvent('a', ringEvent('ring'), room, true, true),
    ).toMatchObject({ direct: true });
    expect(
      normalizeNotificationEvent('a', ringEvent('ring'), room, true, false),
    ).toMatchObject({ direct: false });
  });
});
