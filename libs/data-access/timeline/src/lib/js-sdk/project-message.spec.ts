import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { projectMessage } from './project-message';

const room = {
  roomId: '!room:example.org',
  getMember: () => null,
  getUsersReadUpTo: () => [],
  findEventById: () => null,
  hasEncryptionStateEvent: () => false,
  getLiveTimeline: () => ({
    getState: () => ({ getStateEvents: () => null }),
  }),
  getUnfilteredTimelineSet: () => ({ relations: undefined }),
} as unknown as Room;

const content = () => ({
  msgtype: 'm.image',
  body: 'photo.png',
  url: 'mxc://example.org/photo',
  info: { mimetype: 'image/png', w: 640, h: 480 },
});

const imageEvent = {
  getId: () => '$event',
  getSender: () => '@alice:example.org',
  getTs: () => 123,
  getType: () => 'm.room.message',
  getContent: content,
  getOriginalContent: content,
  getPrevContent: () => ({}),
  getStateKey: () => undefined,
  getRelation: () => null,
  isState: () => false,
  isRedacted: () => false,
  isDecryptionFailure: () => false,
  isEncrypted: () => false,
  status: null,
  replacingEvent: () => null,
  getAssociatedStatus: () => null,
  isRelation: () => false,
  replyEventId: undefined,
} as unknown as MatrixEvent;

function project(userId: string | null) {
  const present = vi.fn(() => ({ id: 'presented' }) as never);
  projectMessage(
    { getUserId: () => userId } as unknown as MatrixClient,
    room,
    imageEvent,
    null,
    false,
    { present },
  );
  return present;
}

describe('projectMessage', () => {
  it('presents media for the projecting account', () => {
    expect(project('@me:example.org')).toHaveBeenCalledWith(
      expect.anything(),
      '@me:example.org',
    );
  });

  it('never falls back to the active account when the client has no user id', () => {
    expect(project(null)).toHaveBeenCalledWith(expect.anything(), '');
  });
});
