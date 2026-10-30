import { describe, expect, it } from 'vitest';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api';
import { assertPlainData } from '@trinity/util/matrix';
import { unencryptedMarkFor } from '@trinity/data-access/matrix-client';
import { normalizeTimelineEvent } from './js-sdk/normalize-timeline-event';
import { shownSubject } from './js-sdk/shields';
import { toTimelineItem } from './js-sdk/timeline-item';
import { shieldText, unencryptedShield } from './shield-presentation';
import type { ShieldCode } from './timeline-engine';
import { normalizedFromItem, profileName } from './timeline-item-presentation';
import { presentNormalizedTimelineEvent } from './message-presentation';
import type { PresentedMediaReference } from '@trinity/data-access/media';

const ME = '@me:example.org';
const ALICE = '@alice:example.org';
const BOB = '@bob:example.org';

const client = { getUserId: () => ME } as unknown as MatrixClient;

const members: Record<string, Record<string, unknown>> = {
  [ME]: { name: 'Me', getMxcAvatarUrl: () => null },
  [ALICE]: { name: 'Alice', getMxcAvatarUrl: () => 'mxc://example.org/alice' },
  [BOB]: {
    name: `Alice (${BOB})`,
    rawDisplayName: 'Alice',
    disambiguate: true,
    getMxcAvatarUrl: () => null,
  },
};

const reactions: Record<string, [string, string[]][]> = {
  $reacted: [
    ['👍', [BOB, ME, ALICE, '@carol:example.org']],
    ['🎉', [ALICE]],
  ],
};

function baseRoom(over: Record<string, unknown> = {}): Room {
  return {
    roomId: '!room:example.org',
    getMember: (userId: string) => members[userId] ?? null,
    getUsersReadUpTo: (e: MatrixEvent) =>
      e.getId() === '$read' ? [ALICE, ME, BOB] : [],
    findEventById: (eventId: string) =>
      eventId === '$parent'
        ? event()
        : eventId === '$gone'
          ? event({ getId: () => '$gone', isRedacted: () => true })
          : null,
    hasEncryptionStateEvent: () => true,
    getLiveTimeline: () => ({
      getState: () => ({ getStateEvents: () => null }),
    }),
    getUnfilteredTimelineSet: () => ({ relations: undefined }),
    relations: {
      getChildEventsForEvent: (id: string) =>
        reactions[id]
          ? {
              getSortedAnnotationsByKey: () =>
                reactions[id].map(([key, senders]) => [
                  key,
                  new Set(
                    senders.map((sender, i) => ({
                      getSender: () => sender,
                      getId: () => `$r-${key}-${i}`,
                      isRedacted: () => false,
                      getTs: () => i,
                    })),
                  ),
                ]),
            }
          : undefined,
    },
    ...over,
  } as unknown as Room;
}

const room = baseRoom();

function event(over: Record<string, unknown> = {}): MatrixEvent {
  const fake: Record<string, unknown> = {
    getId: () => '$event',
    getSender: () => ALICE,
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
  const relation = () => {
    const r = content()['m.relates_to'] as Record<string, unknown> | undefined;
    return r?.['rel_type'] && r['event_id'] ? r : null;
  };
  return {
    getOriginalContent: content,
    getRelation: relation,
    ...fake,
  } as MatrixEvent;
}

interface Fixture {
  readonly event: MatrixEvent;
  readonly room?: Room;
  readonly shield?: ShieldCode | null;
  readonly roomEncrypted?: boolean;
}

const html = (body: string) => ({
  msgtype: 'm.text',
  body,
  format: 'org.matrix.custom.html',
  formatted_body: body,
});

/** The fixtures of normalize-timeline-event.spec.ts, plus one per item field. */
const fixtures: Record<string, Fixture> = {
  text: { event: event() },
  'undecryptable with a reason': {
    event: event({
      isDecryptionFailure: () => true,
      decryptionFailureReason:
        DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE,
    }),
  },
  'undecryptable without a reason': {
    event: event({
      isDecryptionFailure: () => true,
      decryptionFailureReason: null,
    }),
  },
  'redacted after failing to decrypt': {
    event: event({
      isRedacted: () => true,
      isDecryptionFailure: () => true,
      decryptionFailureReason:
        DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED,
    }),
  },
  'hostile content getter': {
    event: event({
      getContent: () => {
        throw new Error('hostile getter');
      },
    }),
  },
  'malformed profile': {
    event: event(),
    room: baseRoom({
      getMember: () => ({
        name: { unexpected: true },
        getMxcAvatarUrl: () => ({ not: 'an mxc string' }),
      }),
    }),
  },
  'malformed identity': {
    event: event({
      getId: () => ({ hostile: true }),
      getSender: () => ({ hostile: true }),
      getTs: () => Number.POSITIVE_INFINITY,
      getContent: () => {
        throw new Error('hostile content');
      },
    }),
  },
  mentions: {
    event: event({
      getContent: () =>
        html(
          '<a href="https://matrix.to/#/@alice:example.org">@Boss</a> <a href="https://matrix.to/#/@bob:example.org">b</a> <a href="https://matrix.to/#/@nobody:example.org">n</a>',
        ),
    }),
  },
  'unsupported msgtype': {
    event: event({
      getContent: () => ({
        msgtype: 'com.example.custom',
        body: 'Readable custom event',
        formatted_body: '<script>unsafe</script>',
      }),
    }),
  },
  'thread fallback': {
    event: event({
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
  },
  reply: {
    event: event({
      replyEventId: '$parent',
      getContent: () => ({
        msgtype: 'm.text',
        body: 'Explicit reply',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } },
      }),
    }),
  },
  'reply to a redacted message': {
    event: event({ replyEventId: '$gone' }),
  },
  'reply to a message not loaded': {
    event: event({ replyEventId: '$elsewhere' }),
  },
  'unencrypted quote in an encrypted room': {
    event: event({ replyEventId: '$parent', isEncrypted: () => true }),
    roomEncrypted: true,
  },
  'unencrypted message in an encrypted room': {
    event: event(),
    roomEncrypted: true,
  },
  'unsupported reply': {
    event: event({
      replyEventId: '$parent',
      getContent: () => ({
        msgtype: 'com.example.custom',
        body: '> quoted\n\nReadable custom reply',
      }),
    }),
  },
  'non-string body': {
    event: event({
      getContent: () => ({ msgtype: 'm.text', body: { hostile: true } }),
    }),
  },
  membership: {
    event: event({
      getType: () => 'm.room.member',
      isState: () => true,
      getStateKey: () => ALICE,
      getContent: () => ({ membership: 'join', displayname: 'Alice' }),
      getPrevContent: () => ({ membership: 'invite' }),
    }),
  },
  'membership of a stranger': {
    event: event({
      getSender: () => BOB,
      getType: () => 'm.room.member',
      isState: () => true,
      getStateKey: () => '@stranger:example.org',
      getContent: () => ({ membership: 'invite' }),
    }),
  },
  'malformed member names in a system event': {
    event: event({
      getSender: () => '@actor:example.org',
      getType: () => 'm.room.member',
      isState: () => true,
      getStateKey: () => '@target:example.org',
      getContent: () => ({ membership: 'join' }),
      getPrevContent: () => ({ membership: 'invite' }),
    }),
    room: baseRoom({ getMember: () => ({ name: { hostile: true } }) }),
  },
  'room name': {
    event: event({
      getType: () => 'm.room.name',
      isState: () => true,
      getStateKey: () => '',
      getContent: () => ({ name: 'New' }),
      getPrevContent: () => ({ name: 'Old' }),
    }),
  },
  image: {
    event: event({
      getContent: () => ({
        msgtype: 'm.image',
        body: 'photo.png',
        url: 'mxc://example.org/photo',
        info: { mimetype: 'image/png', w: 640, h: 480 },
      }),
    }),
  },
  'captioned file': {
    event: event({
      getContent: () => ({
        msgtype: 'm.file',
        body: 'see <b>this</b>',
        filename: 'doc.pdf',
        format: 'org.matrix.custom.html',
        formatted_body:
          'see <a href="https://matrix.to/#/@alice:example.org">A</a>',
        url: 'mxc://example.org/doc',
      }),
    }),
  },
  sticker: {
    event: event({
      getType: () => 'm.sticker',
      getContent: () => ({
        body: 'parrot',
        url: 'mxc://example.org/parrot',
        info: { w: 64 },
      }),
    }),
  },
  'sticker without a body': {
    event: event({
      getType: () => 'm.sticker',
      getContent: () => ({ url: 'mxc://example.org/parrot' }),
    }),
  },
  'sticker naming an encrypted file': {
    event: event({
      getType: () => 'm.sticker',
      getContent: () => ({
        body: 'parrot',
        url: 'mxc://example.org/parrot',
        file: {
          url: 'mxc://example.org/cipher',
          key: { k: 'k' },
          iv: 'iv',
          hashes: { sha256: 'h' },
          v: 'v2',
        },
      }),
    }),
  },
  location: {
    event: event({
      getContent: () => ({
        msgtype: 'm.location',
        body: 'Office',
        geo_uri: 'geo:51.5,-0.1',
      }),
    }),
  },
  emote: {
    event: event({
      getContent: () => ({ msgtype: 'm.emote', body: 'waves' }),
    }),
  },
  'reactions with the viewer among them': {
    event: event({ getId: () => '$reacted' }),
  },
  receipts: { event: event({ getId: () => '$read' }) },
  'resolved shield': {
    event: event({ isEncrypted: () => true }),
    shield: { colour: 'red', reason: 'unknown-device' },
    roomEncrypted: true,
  },
  'local echo': {
    event: event({
      getId: () => '~!room:example.org:txn1',
      getSender: () => ME,
      getTxnId: () => 'txn1',
      status: 'sending',
    }),
  },
};

describe('normalizedFromItem', () => {
  it.each(Object.entries(fixtures))(
    'normalizedFromItem(toTimelineItem(e)) deep-equals normalizeTimelineEvent(e): %s',
    (_name, fixture) => {
      const fixtureRoom = fixture.room ?? room;
      const roomEncrypted = fixture.roomEncrypted ?? false;
      const code = fixture.shield ?? null;
      const mark = unencryptedMarkFor(fixtureRoom, roomEncrypted)(
        fixture.event,
        shownSubject(fixture.event),
      );
      const expected = normalizeTimelineEvent(
        client,
        fixtureRoom,
        fixture.event,
        unencryptedShield(mark) ?? (code ? shieldText(code) : null),
        roomEncrypted,
      );

      const item = toTimelineItem(
        client,
        fixtureRoom,
        fixture.event,
        code,
        roomEncrypted,
      );

      expect(expected).not.toBeNull();
      expect(item).not.toBeNull();
      if (!item) return;
      expect(() => assertPlainData(item)).not.toThrow();
      expect(
        normalizedFromItem(item, {
          roomId: fixtureRoom.roomId,
          encrypted: fixtureRoom.hasEncryptionStateEvent(),
          viewerId: ME,
        }),
      ).toEqual(expected);
    },
  );
});

describe('stickerImage', () => {
  it("stickerImage carries the sticker's url, info and body", () => {
    const item = toTimelineItem(
      client,
      room,
      fixtures['sticker'].event,
      null,
      false,
    );
    if (!item) throw new Error('The sticker fixture was not projected');

    const view = presentNormalizedTimelineEvent(
      normalizedFromItem(item, {
        roomId: room.roomId,
        encrypted: false,
        viewerId: ME,
      }),
      () => ({}) as PresentedMediaReference,
    );

    expect(view?.stickerImage).toEqual({
      url: 'mxc://example.org/parrot',
      info: { w: 64 },
      body: 'parrot',
    });
  });

  it('leaves out the body a sticker does not have', () => {
    const event = fixtures['sticker without a body'].event;
    const item = toTimelineItem(client, room, event, null, false);
    if (!item) throw new Error('The sticker fixture was not projected');

    const view = presentNormalizedTimelineEvent(
      normalizedFromItem(item, {
        roomId: room.roomId,
        encrypted: false,
        viewerId: ME,
      }),
      () => ({}) as PresentedMediaReference,
    );

    expect(view?.stickerImage).toEqual({ url: 'mxc://example.org/parrot' });
  });
});

describe('profileName', () => {
  it('matches member.name for an ambiguous name', () => {
    const item = toTimelineItem(
      client,
      room,
      event({ getSender: () => BOB }),
      null,
      false,
    );

    expect(item?.profiles[BOB]).toEqual({
      displayName: 'Alice',
      displayNameAmbiguous: true,
      avatarMxc: null,
    });
    expect(profileName(BOB, item?.profiles[BOB])).toBe(members[BOB]['name']);
    expect(profileName('@nobody:example.org', undefined)).toBe(
      '@nobody:example.org',
    );
  });
});
