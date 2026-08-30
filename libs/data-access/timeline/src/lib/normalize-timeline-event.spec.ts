import { describe, expect, it } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { normalizeTimelineEvent } from './normalize-timeline-event';

const client = {
  getUserId: () => '@me:example.org',
} as unknown as MatrixClient;

const room = {
  getMember: (userId: string) =>
    userId === '@alice:example.org'
      ? {
          name: 'Alice',
          getMxcAvatarUrl: () => 'mxc://example.org/alice',
        }
      : null,
  getUsersReadUpTo: () => [],
  findEventById: () => null,
  hasEncryptionStateEvent: () => true,
  getUnfilteredTimelineSet: () => ({ relations: undefined }),
} as unknown as Room;

function event(over: Record<string, unknown> = {}): MatrixEvent {
  return {
    getId: () => '$event',
    getSender: () => '@alice:example.org',
    getTs: () => 123,
    getType: () => 'm.room.message',
    getContent: () => ({ msgtype: 'm.text', body: 'hello' }),
    getPrevContent: () => ({}),
    getStateKey: () => undefined,
    isState: () => false,
    isRedacted: () => false,
    isDecryptionFailure: () => false,
    replacingEvent: () => null,
    getAssociatedStatus: () => null,
    isRelation: () => false,
    replyEventId: undefined,
    ...over,
  } as unknown as MatrixEvent;
}

describe('normalizeTimelineEvent', () => {
  it('turns an SDK text event into a frozen plain record', () => {
    const normalized = normalizeTimelineEvent(client, room, event(), null);

    expect(normalized).toMatchObject({
      type: 'text',
      id: '$event',
      senderId: '@alice:example.org',
      senderName: 'Alice',
      senderAvatarMxc: 'mxc://example.org/alice',
      messageKind: 'text',
      body: 'hello',
      roomEncrypted: true,
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    if (normalized) {
      expect(Object.isFrozen(normalized.reactions)).toBe(true);
      expect(Object.isFrozen(normalized.readReceipts)).toBe(true);
    }
  });

  it('degrades throwing federated input before presentation sees it', () => {
    const hostile = event({
      getContent: () => {
        throw new Error('hostile getter');
      },
    });

    const normalized = normalizeTimelineEvent(client, room, hostile, null);

    expect(normalized).toMatchObject({
      type: 'unsupported',
      fallback: 'unsupported-message',
      id: '$event',
      senderId: '@alice:example.org',
    });
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('bounds malformed profile data before deriving sender presentation', () => {
    const malformedRoom = {
      ...room,
      getMember: () => ({
        name: { unexpected: true },
        getMxcAvatarUrl: () => ({ not: 'an mxc string' }),
      }),
    } as unknown as Room;

    const normalized = normalizeTimelineEvent(
      client,
      malformedRoom,
      event(),
      null,
    );

    expect(normalized).toMatchObject({
      senderName: '@alice:example.org',
      senderInitial: 'A',
      senderAvatarMxc: null,
    });
  });

  it('bounds malformed event identity fields without escaping the fallback', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({
        getId: () => ({ hostile: true }),
        getSender: () => ({ hostile: true }),
        getTs: () => Number.POSITIVE_INFINITY,
        getContent: () => {
          throw new Error('hostile content');
        },
      }),
      null,
    );

    expect(normalized).toMatchObject({
      type: 'unsupported',
      id: '',
      senderId: '',
      senderName: 'Unknown',
      senderInitial: 'U',
      timestamp: 0,
    });
  });

  it('retains safe plaintext from an unsupported message type', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({
        getContent: () => ({
          msgtype: 'com.example.custom',
          body: 'Readable custom event',
          formatted_body: '<script>unsafe</script>',
        }),
      }),
      null,
    );

    expect(normalized).toMatchObject({
      type: 'unsupported',
      fallback: 'unsupported-message',
      body: 'Readable custom event',
    });
  });

  it('marks unsupported replies so presentation can remove their fallback', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({
        replyEventId: '$parent',
        getContent: () => ({
          msgtype: 'com.example.custom',
          body: '> quoted\n\nReadable custom reply',
        }),
      }),
      null,
    );

    expect(normalized).toMatchObject({
      type: 'unsupported',
      replyFallback: true,
    });
  });

  it('turns a recognized text type with a non-string body into a fallback', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({
        getContent: () => ({ msgtype: 'm.text', body: { hostile: true } }),
      }),
      null,
    );

    expect(normalized).toMatchObject({
      type: 'unsupported',
      fallback: 'unsupported-message',
      body: '',
    });
  });

  it('normalizes membership transitions without carrying SDK objects forward', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({
        getType: () => 'm.room.member',
        isState: () => true,
        getStateKey: () => '@alice:example.org',
        getContent: () => ({ membership: 'join', displayname: 'Alice' }),
        getPrevContent: () => ({ membership: 'invite' }),
      }),
      null,
    );

    expect(normalized).toMatchObject({
      type: 'system',
      change: {
        kind: 'membership',
        membership: 'join',
        previousMembership: 'invite',
        targetName: 'Alice',
      },
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalized).not.toHaveProperty('event');
    expect(normalized).not.toHaveProperty('room');
    expect(normalized).not.toHaveProperty('client');
  });

  it('bounds malformed actor and target member names in system events', () => {
    const malformedRoom = {
      ...room,
      getMember: () => ({ name: { hostile: true } }),
    } as unknown as Room;
    const normalized = normalizeTimelineEvent(
      client,
      malformedRoom,
      event({
        getSender: () => '@actor:example.org',
        getType: () => 'm.room.member',
        isState: () => true,
        getStateKey: () => '@target:example.org',
        getContent: () => ({ membership: 'join' }),
        getPrevContent: () => ({ membership: 'invite' }),
      }),
      null,
    );

    expect(normalized).toMatchObject({
      type: 'system',
      change: {
        actorName: '@actor:example.org',
        targetName: '@target:example.org',
      },
    });
  });

  it('normalizes media source data before the Media Pipeline presents it', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({
        getContent: () => ({
          msgtype: 'm.image',
          body: 'photo.png',
          url: 'mxc://example.org/photo',
          info: { mimetype: 'image/png', w: 640, h: 480 },
        }),
      }),
      null,
    );

    expect(normalized).toMatchObject({
      type: 'media',
      messageKind: 'image',
      body: 'photo.png',
      media: {
        kind: 'image',
        mxc: 'mxc://example.org/photo',
        width: 640,
        height: 480,
      },
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalized).not.toHaveProperty('event');
    expect(normalized).not.toHaveProperty('room');
    expect(normalized).not.toHaveProperty('client');
  });
});
