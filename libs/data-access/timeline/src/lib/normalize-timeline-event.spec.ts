import { describe, expect, it, vi } from 'vitest';
import { MatrixEvent, type MatrixClient, type Room } from 'matrix-js-sdk';
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api';
import { UNENCRYPTED_PREVIEW } from '@trinity/util/matrix';
import { normalizeTimelineEvent } from './normalize-timeline-event';

const client = {
  getUserId: () => '@me:example.org',
} as unknown as MatrixClient;

const room = {
  roomId: '!room:example.org',
  getMember: (userId: string) =>
    userId === '@alice:example.org'
      ? {
          name: 'Alice',
          getMxcAvatarUrl: () => 'mxc://example.org/alice',
        }
      : null,
  getUsersReadUpTo: () => [],
  findEventById: (eventId: string) => (eventId === '$parent' ? event() : null),
  hasEncryptionStateEvent: () => true,
  getUnfilteredTimelineSet: () => ({ relations: undefined }),
} as unknown as Room;

function event(over: Record<string, unknown> = {}): MatrixEvent {
  const fake: Record<string, unknown> = {
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
    isEncrypted: () => false,
    status: null,
    replacingEvent: () => null,
    getAssociatedStatus: () => null,
    isRelation: () => false,
    replyEventId: undefined,
    ...over,
  };
  const content = fake['getContent'] as () => Record<string, unknown>;
  // As the SDK reads it: the event's own relation, when it has a type and a target.
  const relation = () => {
    const r = content()['m.relates_to'] as Record<string, unknown> | undefined;
    return r?.['rel_type'] && r['event_id'] ? r : null;
  };
  // Unedited unless a test attaches an edit, so its own content is what it shows.
  return {
    getOriginalContent: content,
    getRelation: relation,
    ...fake,
  } as MatrixEvent;
}

describe('normalizeTimelineEvent', () => {
  it('keeps why a message could not be decrypted', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({
        isDecryptionFailure: () => true,
        decryptionFailureReason:
          DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE,
      }),
      null,
      false,
    );

    expect(normalized).toMatchObject({
      type: 'unsupported',
      fallback: 'undecryptable-message',
      decryptionFailed: true,
      undecryptableReason: 'device-unverified',
    });
  });

  it('records an unknown reason when the SDK gave none', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({
        isDecryptionFailure: () => true,
        decryptionFailureReason: null,
      }),
      null,
      false,
    );

    expect(normalized).toMatchObject({ undecryptableReason: 'missing-key' });
  });

  // The SDK's makeRedacted clears the clear event but keeps the failure reason, so a
  // message redacted after it failed to decrypt still reports a decryption failure.
  it('shows a redacted message as redacted even when it could not be decrypted', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({
        isRedacted: () => true,
        isDecryptionFailure: () => true,
        decryptionFailureReason:
          DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED,
      }),
      null,
      false,
    );

    expect(normalized).toMatchObject({
      type: 'unsupported',
      fallback: 'redacted-message',
      decryptionFailed: false,
      undecryptableReason: null,
    });
  });
  it('turns an SDK text event into a frozen plain record', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event(),
      null,
      false,
    );

    expect(normalized).toMatchObject({
      type: 'text',
      id: '$event',
      senderId: '@alice:example.org',
      senderName: 'Alice',
      senderAvatarMxc: 'mxc://example.org/alice',
      messageKind: 'text',
      body: 'hello',
      roomEncrypted: true,
      roomId: '!room:example.org',
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

    const normalized = normalizeTimelineEvent(
      client,
      room,
      hostile,
      null,
      false,
    );

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
      false,
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
      false,
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

  it('resolves the names of the users a message links to', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({
        getContent: () => ({
          msgtype: 'm.text',
          body: 'hi',
          format: 'org.matrix.custom.html',
          formatted_body:
            '<a href="https://matrix.to/#/@alice:example.org">@Boss</a>',
        }),
      }),
      null,
      false,
    );

    expect(normalized).toMatchObject({
      mentionNames: { '@alice:example.org': 'Alice' },
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
      false,
    );

    expect(normalized).toMatchObject({
      type: 'unsupported',
      fallback: 'unsupported-message',
      body: 'Readable custom event',
    });
  });

  it('omits the automatic thread fallback quote from a normal thread message', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({
        replyEventId: '$parent',
        getContent: () => ({
          msgtype: 'm.text',
          body: 'Normal thread message',
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: '$thread',
            is_falling_back: true,
            'm.in_reply_to': { event_id: '$parent' },
          },
        }),
      }),
      null,
      false,
    );

    expect(normalized).toMatchObject({
      type: 'text',
      body: 'Normal thread message',
      replyTo: null,
    });
  });

  describe('the automatic thread fallback quote', () => {
    const fallback = {
      rel_type: 'm.thread',
      event_id: '$thread',
      is_falling_back: true,
      'm.in_reply_to': { event_id: '$parent' },
    };
    const threadMessage = () =>
      new MatrixEvent({
        event_id: '$event',
        room_id: '!r:example.org',
        sender: '@alice:example.org',
        type: 'm.room.message',
        content: {
          msgtype: 'm.text',
          body: 'Normal thread message',
          'm.relates_to': fallback,
        },
      });

    it("stays omitted when an edit's new content claims otherwise", () => {
      const message = threadMessage();
      message.makeReplaced(
        new MatrixEvent({
          event_id: '$edit',
          room_id: '!r:example.org',
          sender: '@alice:example.org',
          type: 'm.room.message',
          content: {
            msgtype: 'm.text',
            body: '* changed',
            'm.new_content': {
              msgtype: 'm.text',
              body: 'changed',
              'm.relates_to': { ...fallback, is_falling_back: false },
            },
            'm.relates_to': { rel_type: 'm.replace', event_id: '$event' },
          },
        }),
      );

      expect(
        normalizeTimelineEvent(client, room, message, null, false),
      ).toMatchObject({ body: 'changed', replyTo: null });
    });

    it('is omitted from an encrypted thread message, whose relation is not encrypted', () => {
      const message = threadMessage();
      message.makeEncrypted(
        'm.room.encrypted',
        {
          algorithm: 'm.megolm.v1.aes-sha2',
          ciphertext: 'sealed',
          'm.relates_to': fallback,
        },
        'curve',
        'ed',
      );
      // Decrypted content never carries `m.relates_to`.
      vi.spyOn(message, 'getOriginalContent').mockReturnValue({
        msgtype: 'm.text',
        body: 'Normal thread message',
      });

      expect(
        normalizeTimelineEvent(client, room, message, null, false),
      ).toMatchObject({ body: 'Normal thread message', replyTo: null });
    });
  });

  it.each([
    {
      name: 'explicit in-thread reply',
      rel_type: 'm.thread',
      is_falling_back: false,
    },
    { name: 'in-thread reply without a fallback flag', rel_type: 'm.thread' },
    { name: 'ordinary room reply' },
  ])(
    'preserves the quote target for an $name',
    ({ name: _name, ...relation }) => {
      const normalized = normalizeTimelineEvent(
        client,
        room,
        event({
          replyEventId: '$parent',
          getContent: () => ({
            msgtype: 'm.text',
            body: 'Explicit reply',
            'm.relates_to': {
              ...relation,
              'm.in_reply_to': { event_id: '$parent' },
            },
          }),
        }),
        null,
        false,
      );

      expect(normalized?.replyTo).toMatchObject({
        id: '$parent',
        senderName: 'Alice',
        body: 'hello',
      });
    },
  );

  it('quotes an unencrypted message in an encrypted room as the unencrypted placeholder', () => {
    const normalized = normalizeTimelineEvent(
      client,
      room,
      event({ replyEventId: '$parent', isEncrypted: () => true }),
      null,
      true,
    );

    expect(normalized?.replyTo).toMatchObject({
      id: '$parent',
      body: UNENCRYPTED_PREVIEW,
    });
  });

  it("quotes an unencrypted message as the unencrypted placeholder while its encrypted edit's shield is pending", () => {
    const edit = event({
      getId: () => '$parent~edit',
      isEncrypted: () => true,
      getClearContent: () => ({}),
      getContent: () => ({
        'm.new_content': { msgtype: 'm.text', body: 'as edited' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$parent' },
      }),
    });
    const parent = event({
      getId: () => '$parent',
      replacingEvent: () => edit,
    });
    const editedRoom = {
      ...room,
      findEventById: (eventId: string) =>
        eventId === '$parent' ? parent : null,
    } as unknown as Room;

    const normalized = normalizeTimelineEvent(
      client,
      editedRoom,
      event({ replyEventId: '$parent', isEncrypted: () => true }),
      null,
      true,
    );

    expect(normalized?.replyTo).toMatchObject({
      id: '$parent',
      body: UNENCRYPTED_PREVIEW,
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
      false,
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
      false,
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
      false,
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
      false,
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
      false,
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

  it('drops a sticker that names an encrypted file next to its url', () => {
    const sticker = (content: Record<string, unknown>) =>
      normalizeTimelineEvent(
        client,
        room,
        event({
          getType: () => 'm.sticker',
          getContent: () => ({ body: 'parrot', ...content }),
        }),
        null,
        false,
      );

    expect(sticker({ url: 'mxc://example.org/parrot' })).toMatchObject({
      type: 'media',
      messageKind: 'sticker',
    });
    expect(
      sticker({
        url: 'mxc://example.org/parrot',
        file: {
          url: 'mxc://example.org/cipher',
          key: { k: 'k' },
          iv: 'iv',
          hashes: { sha256: 'h' },
          v: 'v2',
        },
      }),
    ).not.toMatchObject({ type: 'media' });
  });
});
