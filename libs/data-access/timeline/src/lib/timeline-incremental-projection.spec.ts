import type { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  Direction,
  EventStatus,
  EventTimeline,
  MatrixEvent,
  Room,
  createClient,
  type IRoomEvent,
  type IStateEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import {
  CryptoEvent,
  EventShieldColour,
  EventShieldReason,
} from 'matrix-js-sdk/lib/crypto-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pollEndContent,
  pollResponseContent,
  pollStartContent,
} from '@trinity/util/matrix';
import { TimelineService } from './timeline.service';
import { revisionOf } from './js-sdk/event-revision';
import { shieldSubject } from './js-sdk/shields';
import { trimLiveTimeline } from './live-timeline-trim';
import type { MessageView } from './message-presentation';
import {
  matrixProvider,
  mediaProvider,
  privacyProvider,
  systemLinesProvider,
} from './timeline.spec-harness';

// What a refresh may skip is only as good as what tells it a row changed. These specs drive
// a real SDK client and Room through each way a loaded row can change, so a path the
// projection stops noticing fails here rather than leaving a stale row on screen.

type IMessagesResponse = Awaited<
  ReturnType<MatrixClient['createMessagesRequest']>
>;
type Crypto = Parameters<MatrixEvent['attemptDecryption']>[0];
type Raw = Partial<IRoomEvent> & { state_key?: string; redacts?: string };

const ME = '@me:hs';
const ROOM = '!r:hs';
const PAGE = 30;
const T0 = 1_700_000_000_000;

/** `$<n>` is the room's n-th event; `b<n>` pages back from just before it. */
const id = (n: number) => `$${n}`;
const before = (n: number) => `b${n}`;

function message(n: number, overrides: Raw = {}): IRoomEvent {
  return {
    event_id: id(n),
    room_id: ROOM,
    type: 'm.room.message',
    sender: '@a:hs',
    origin_server_ts: T0 + n * 1000,
    content: { msgtype: 'm.text', body: `message ${n}` },
    unsigned: {},
    ...overrides,
  };
}

/** A later event, one the server never held in its history. */
function live(eventId: string, overrides: Raw = {}): IRoomEvent {
  return message(0, {
    event_id: eventId,
    origin_server_ts: T0 * 2,
    ...overrides,
  });
}

function reply(n: number, to: number, overrides: Raw = {}): Raw {
  return {
    content: {
      msgtype: 'm.text',
      body: `reply ${n}`,
      'm.relates_to': { 'm.in_reply_to': { event_id: id(to) } },
    },
    ...overrides,
  };
}

function member(
  userId: string,
  displayname: string,
  avatar_url?: string,
): IStateEvent {
  return {
    event_id: `$member-${userId}-${displayname}`,
    room_id: ROOM,
    type: 'm.room.member',
    state_key: userId,
    sender: userId,
    origin_server_ts: T0 * 2,
    content: { membership: 'join', displayname, avatar_url },
    unsigned: {},
  };
}

function receipt(eventId: string, userId: string, ts = 1): MatrixEvent {
  return new MatrixEvent({
    type: 'm.receipt',
    room_id: ROOM,
    content: { [eventId]: { 'm.read': { [userId]: { ts } } } },
  });
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

/** The slice of the crypto API that resolves shields. */
interface ShieldProbe {
  getEncryptionInfoForEvent(event: MatrixEvent): Promise<unknown>;
  isEncryptionEnabledInRoom(roomId: string): Promise<boolean>;
}

/** A crypto API that vouches for every event: an encrypted edit shows once it is checked. */
const TRUSTING: ShieldProbe = {
  getEncryptionInfoForEvent: () => Promise.resolve(null),
  isEncryptionEnabledInRoom: () => Promise.resolve(true),
};

const ENCRYPTED: Raw = {
  type: 'm.room.encrypted',
  content: {
    algorithm: 'm.megolm.v1.aes-sha2',
    ciphertext: 'opaque',
    session_id: 's',
    sender_key: 'k',
    device_id: 'D',
  },
};

/** A crypto backend that answers each decryption the way `outcome` does. */
function decryptor(outcome: () => Promise<unknown>): Crypto {
  return { decryptEvent: outcome } as unknown as Crypto;
}

/**
 * A real SDK client and Room in front of a homeserver holding `history` events, with the
 * newest `shown` already in the live timeline and the Conversation open on it.
 */
async function openConversation(
  history: number,
  shown: number,
  overrides: Record<number, Raw> = {},
  options: { providers?: Provider[]; crypto?: ShieldProbe } = {},
) {
  const raw = (n: number) => message(n, overrides[n]);
  const client = createClient({
    baseUrl: 'https://hs',
    userId: ME,
    fetchFn: () => Promise.reject(new Error('no network in unit tests')),
  });
  vi.spyOn(client, 'supportsThreads').mockReturnValue(true);
  if (options.crypto) {
    vi.spyOn(client, 'getCrypto').mockReturnValue(
      options.crypto as unknown as ReturnType<MatrixClient['getCrypto']>,
    );
  }
  const room = new Room(ROOM, client, ME);
  vi.spyOn(client, 'getRoom').mockReturnValue(room);
  vi.spyOn(room, 'loadMembersIfNeeded').mockResolvedValue(true);
  // Decryption is the test's to drive (see `decryptor`), never the client's.
  const mapper = client.getEventMapper({ decrypt: false });
  /** State the next page carries, as a lazy-loading server sends its senders' members. */
  const pageState: IStateEvent[] = [];
  vi.spyOn(client, 'createMessagesRequest').mockImplementation(
    async (_roomId, from, limit) => {
      const position = Number(String(from).slice(1));
      const oldest = Math.max(1, position - (limit ?? PAGE));
      const chunk: IRoomEvent[] = [];
      for (let n = position - 1; n >= oldest; n--) chunk.push(raw(n));
      const res: IMessagesResponse = {
        chunk,
        start: String(from),
        end: chunk.length === 0 || oldest === 1 ? undefined : before(oldest),
        state: pageState.splice(0),
      };
      return res;
    },
  );
  const first = history - shown + 1;
  room
    .getLiveTimeline()
    .setPaginationToken(first > 1 ? before(first) : null, Direction.Backward);
  const initial: MatrixEvent[] = [];
  for (let n = first; n <= history; n++) initial.push(mapper(raw(n)));
  await room.addLiveEvents(initial, { addToState: true });

  TestBed.configureTestingModule({
    providers: [
      TimelineService,
      matrixProvider(client),
      mediaProvider(),
      ...(options.providers ?? []),
    ],
  });
  const svc = TestBed.inject(TimelineService);
  svc.open(ROOM, client);

  const row = (eventId: string): MessageView | undefined =>
    svc.messages().find((m) => m.id === eventId);
  return {
    client,
    room,
    svc,
    row,
    pageState,
    event: (n: number | string) =>
      room.findEventById(typeof n === 'number' ? id(n) : n) as MatrixEvent,
    /** What a sync delivers: events appended to the live timeline. */
    receive: async (...events: (IRoomEvent | IStateEvent)[]) => {
      await room.addLiveEvents(events.map(mapper), { addToState: true });
      await settle();
    },
    pageBack: async () => {
      await firstValueFrom(svc.loadOlder());
      await settle();
    },
  };
}

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [privacyProvider(true)] });
  // Unfocused: no read receipts go out, so nothing here waits on the network.
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
});
afterEach(() => vi.restoreAllMocks());

describe('TimelineService incremental projection', () => {
  describe('paging history', () => {
    it('loads each page with the same work, however much history is already loaded', async () => {
      const { room, pageBack } = await openConversation(PAGE * 6, PAGE);
      // Each row's "seen by" receipts are read once per fingerprint, so the reads count the
      // rows a page re-examines.
      const reads = vi.spyOn(room, 'getUsersReadUpTo');
      const workOfOnePage = async () => {
        reads.mockClear();
        await pageBack();
        return reads.mock.calls.length;
      };

      const first = await workOfOnePage();
      await workOfOnePage();
      await workOfOnePage();
      const fourth = await workOfOnePage();

      expect(first).toBeGreaterThan(0);
      expect(fourth).toBe(first);
    });

    it('keeps the rows already shown as they were', async () => {
      const { svc, pageBack } = await openConversation(PAGE * 3, PAGE);
      const shown = svc.messages();

      await pageBack();

      const after = svc.messages();
      expect(after).toHaveLength(PAGE * 2);
      expect(after.slice(PAGE)).toEqual(shown);
      after.slice(PAGE).forEach((view, i) => expect(view).toBe(shown[i]));
    });

    it('fills in a quote once the message it quotes is paged in', async () => {
      const { row, pageBack } = await openConversation(PAGE * 2, PAGE, {
        [PAGE + 5]: reply(PAGE + 5, 3),
      });
      expect(row(id(PAGE + 5))?.replyTo).toBeNull();

      await pageBack();

      expect(row(id(PAGE + 5))?.replyTo?.body).toBe('message 3');
    });

    it('names a sender whose member event arrives with a page', async () => {
      const { row, pageBack, pageState } = await openConversation(
        PAGE * 2,
        PAGE,
        { [PAGE + 2]: { sender: '@c:hs' } },
      );
      expect(row(id(PAGE + 2))?.senderName).toBe('@c:hs');

      pageState.push(member('@c:hs', 'Carol'));
      await pageBack();

      expect(row(id(PAGE + 2))?.senderName).toBe('Carol');
    });
  });

  describe('a loaded row changes', () => {
    it('shows a message decrypted late, and the quote of it in a reply', async () => {
      const { row, event } = await openConversation(10, 10, {
        3: ENCRYPTED,
        7: reply(7, 3),
      });
      const decrypt = (outcome: () => Promise<unknown>) =>
        event(3).attemptDecryption(decryptor(outcome));

      // No key yet: an unreadable row, and a quote with nothing to show.
      await decrypt(() => Promise.reject(new Error('no key')));
      await settle();
      expect(row(id(3))?.decryptionFailed).toBe(true);
      expect(row(id(7))?.replyTo?.body).not.toBe('the secret');

      // The key arrives later.
      await decrypt(() =>
        Promise.resolve({
          clearEvent: {
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'the secret' },
          },
        }),
      );
      await settle();

      expect(row(id(3))?.decryptionFailed).toBe(false);
      expect(row(id(3))?.body).toBe('the secret');
      expect(row(id(7))?.replyTo?.body).toBe('the secret');
    });

    it('shows an edit of an old message, in the message and in a quote of it', async () => {
      const { row, receive } = await openConversation(40, 40, {
        9: reply(9, 2),
      });

      await receive(
        live('$edit', {
          content: {
            msgtype: 'm.text',
            body: '* changed',
            'm.new_content': { msgtype: 'm.text', body: 'changed' },
            'm.relates_to': { rel_type: 'm.replace', event_id: id(2) },
          },
        }),
      );

      expect(row(id(2))?.body).toBe('changed');
      expect(row(id(2))?.edited).toBe(true);
      expect(row(id(9))?.replyTo?.body).toBe('changed');
    });

    it('shows an encrypted edit once it is decrypted', async () => {
      const { row, event, receive } = await openConversation(
        10,
        10,
        {},
        { crypto: TRUSTING },
      );
      await receive(
        live('$secret-edit', {
          type: 'm.room.encrypted',
          content: {
            algorithm: 'm.megolm.v1.aes-sha2',
            ciphertext: 'opaque',
            session_id: 's',
            sender_key: 'k',
            device_id: 'D',
            'm.relates_to': { rel_type: 'm.replace', event_id: id(2) },
          },
        }),
      );
      expect(row(id(2))?.body).toBe('message 2');

      await event('$secret-edit').attemptDecryption(
        decryptor(() =>
          Promise.resolve({
            clearEvent: {
              type: 'm.room.message',
              content: {
                msgtype: 'm.text',
                body: '* changed',
                'm.new_content': { msgtype: 'm.text', body: 'changed' },
                'm.relates_to': { rel_type: 'm.replace', event_id: id(2) },
              },
            },
          }),
        ),
      );

      await vi.waitFor(() => expect(row(id(2))?.body).toBe('changed'));
    });

    it('removes a deleted message, and the quote of it in a reply', async () => {
      const { row, receive } = await openConversation(40, 40, {
        9: reply(9, 2),
      });

      await receive(
        live('$redaction', {
          type: 'm.room.redaction',
          redacts: id(2),
          content: { redacts: id(2) },
        }),
      );

      expect(row(id(2))?.kind).toBe('redacted');
      expect(row(id(9))?.replyTo?.body).toBe('(message deleted)');
    });

    it("keeps no copy of a deleted message's text in its fingerprint", async () => {
      const { client, room, row, event, receive } = await openConversation(
        10,
        10,
        {
          2: { content: { msgtype: 'm.text', body: 'words to forget' } },
        },
      );
      expect(row(id(2))?.body).toBe('words to forget');

      await receive(
        live('$redaction', {
          type: 'm.room.redaction',
          redacts: id(2),
          content: { redacts: id(2) },
        }),
      );

      // The SDK empties the content object in place; a memo keyed by that object must not
      // keep serving (and the row cache keep storing) the text that was deleted.
      expect(row(id(2))?.kind).toBe('redacted');
      expect(revisionOf(client, room, event(2), false).content).not.toContain(
        'words to forget',
      );
    });

    it('counts a reaction as it is added and removed', async () => {
      const { row, receive } = await openConversation(40, 40);

      await receive(
        live('$like', {
          type: 'm.reaction',
          sender: '@b:hs',
          content: {
            'm.relates_to': {
              rel_type: 'm.annotation',
              event_id: id(4),
              key: '👍',
            },
          },
        }),
      );
      expect(row(id(4))?.reactions).toEqual([
        { key: '👍', count: 1, reacted: false, reactors: ['@b:hs'] },
      ]);

      await receive(
        live('$unlike', {
          type: 'm.room.redaction',
          sender: '@b:hs',
          redacts: '$like',
          content: { redacts: '$like' },
        }),
      );
      expect(row(id(4))?.reactions).toEqual([]);
    });

    it('tallies a poll vote as it arrives', async () => {
      const { row, receive } = await openConversation(20, 20, {
        5: {
          type: 'org.matrix.msc3381.poll.start',
          content: pollStartContent('Lunch?', ['Soup', 'Salad']),
        },
      });
      expect(row(id(5))?.poll?.totalVotes).toBe(0);

      await receive(
        live('$vote', {
          type: 'org.matrix.msc3381.poll.response',
          sender: '@b:hs',
          content: pollResponseContent(id(5), ['a1']),
        }),
      );

      expect(row(id(5))?.poll?.totalVotes).toBe(1);
      expect(row(id(5))?.poll?.options[1].votes).toBe(1);
    });

    it('closes a poll in an encrypted room on its encrypted end after an unencrypted one', async () => {
      const { row, event, receive } = await openConversation(20, 20, {
        1: {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        },
        5: {
          type: 'org.matrix.msc3381.poll.start',
          content: pollStartContent('Lunch?', ['Soup', 'Salad']),
        },
      });
      await receive(
        live('$clear-end', {
          type: 'org.matrix.msc3381.poll.end',
          origin_server_ts: T0 + 6000,
          content: pollEndContent(id(5)),
        }),
      );
      expect(row(id(5))?.poll?.ended).toBe(false);

      await receive(
        live('$end', {
          ...ENCRYPTED,
          content: {
            ...ENCRYPTED.content,
            'm.relates_to': { rel_type: 'm.reference', event_id: id(5) },
          },
        }),
      );
      await event('$end').attemptDecryption(
        decryptor(() =>
          Promise.resolve({
            clearEvent: {
              type: 'org.matrix.msc3381.poll.end',
              content: pollEndContent(id(5)),
            },
          }),
        ),
      );
      await settle();

      expect(row(id(5))?.poll?.ended).toBe(true);
    });

    describe('who may end a poll changes', () => {
      const pollRoom = () =>
        openConversation(20, 20, {
          1: {
            type: 'm.room.create',
            state_key: '',
            content: { room_version: '10' },
          },
          2: {
            type: 'm.room.member',
            state_key: '@mod:hs',
            sender: '@mod:hs',
            content: { membership: 'join' },
          },
          3: {
            type: 'm.room.member',
            state_key: '@c:hs',
            sender: '@c:hs',
            content: { membership: 'join' },
          },
          5: {
            type: 'org.matrix.msc3381.poll.start',
            content: pollStartContent('Lunch?', ['Soup', 'Salad']),
          },
        });
      const end = (sender: string) =>
        live(`$end-${sender}`, {
          type: 'org.matrix.msc3381.poll.end',
          sender,
          content: pollEndContent(id(5)),
        });
      let revision = 0;
      const levels = (users: Record<string, number>) =>
        live(`$levels-${revision++}`, {
          type: 'm.room.power_levels',
          state_key: '',
          content: { users },
        });

      it('ends the poll once the sender of an ignored end may redact it', async () => {
        const { row, receive } = await pollRoom();
        await receive(end('@c:hs'));
        expect(row(id(5))?.poll?.ended).toBe(false);

        await receive(levels({ '@mod:hs': 100, '@c:hs': 100 }));

        expect(row(id(5))?.poll?.ended).toBe(true);
      });

      it('reopens the poll when the moderator who ended it is demoted', async () => {
        const { row, receive } = await pollRoom();
        await receive(levels({ '@mod:hs': 100 }));
        await receive(end('@mod:hs'));
        expect(row(id(5))?.poll?.ended).toBe(true);

        await receive(levels({}));

        expect(row(id(5))?.poll?.ended).toBe(false);
      });

      it('reopens the poll when the moderator who ended it leaves', async () => {
        const { row, receive } = await pollRoom();
        await receive(levels({ '@mod:hs': 100 }));
        await receive(end('@mod:hs'));
        expect(row(id(5))?.poll?.ended).toBe(true);

        await receive(
          live('$left', {
            type: 'm.room.member',
            state_key: '@mod:hs',
            sender: '@mod:hs',
            content: { membership: 'leave' },
          }),
        );

        expect(row(id(5))?.poll?.ended).toBe(false);
      });
    });

    it("drops a vote when a ban takes the voter's messages with it", async () => {
      const { row, receive } = await openConversation(20, 20, {
        1: {
          type: 'm.room.power_levels',
          state_key: '',
          content: { users: { '@mod:hs': 100 } },
        },
        2: {
          type: 'm.room.member',
          state_key: '@mod:hs',
          sender: '@mod:hs',
          content: { membership: 'join' },
        },
        5: {
          type: 'org.matrix.msc3381.poll.start',
          content: pollStartContent('Lunch?', ['Soup', 'Salad']),
        },
      });
      await receive(
        live('$vote', {
          type: 'org.matrix.msc3381.poll.response',
          sender: '@c:hs',
          content: pollResponseContent(id(5), ['a0']),
        }),
      );
      expect(row(id(5))?.poll?.totalVotes).toBe(1);

      // MSC4293: the ban redacts everything the member sent; no redaction event arrives.
      await receive(
        live('$ban', {
          type: 'm.room.member',
          state_key: '@c:hs',
          sender: '@mod:hs',
          content: {
            membership: 'ban',
            'org.matrix.msc4293.redact_events': true,
          },
        }),
      );

      expect(row(id(5))?.poll?.totalVotes).toBe(0);
    });

    it('moves "seen by" when a read receipt moves', async () => {
      const { room, row } = await openConversation(10, 10);

      room.addReceipt(receipt(id(4), '@r:hs', 1));
      await settle();
      expect(row(id(4))?.readReceipts.map((r) => r.userId)).toEqual(['@r:hs']);

      room.addReceipt(receipt(id(8), '@r:hs', 2));
      await settle();
      expect(row(id(4))?.readReceipts).toEqual([]);
      expect(row(id(8))?.readReceipts.map((r) => r.userId)).toEqual(['@r:hs']);
    });

    it('moves "seen by" off a message once its reader sends one', async () => {
      const { room, row, receive } = await openConversation(10, 10);
      room.addReceipt(receipt(id(9), '@r:hs', 1));
      await settle();
      expect(row(id(9))?.readReceipts.map((r) => r.userId)).toEqual(['@r:hs']);

      await receive(live('$from-reader', { sender: '@r:hs' }));

      expect(row(id(9))?.readReceipts).toEqual([]);
    });

    it('renames someone everywhere they appear when their profile changes', async () => {
      const { row, receive } = await openConversation(40, 40, {
        2: { sender: '@c:hs' },
        30: reply(30, 2, { sender: '@b:hs' }),
      });
      await receive(
        live('$like', {
          type: 'm.reaction',
          sender: '@c:hs',
          content: {
            'm.relates_to': {
              rel_type: 'm.annotation',
              event_id: id(10),
              key: '👍',
            },
          },
        }),
      );

      await receive(member('@c:hs', 'Carol', 'mxc://hs/carol'));

      expect(row(id(2))?.senderName).toBe('Carol');
      expect(row(id(2))?.senderAvatarMxc).toBe('mxc://hs/carol');
      expect(row(id(30))?.replyTo?.senderName).toBe('Carol');
      expect(row(id(10))?.reactions[0].reactors).toEqual(['Carol']);
    });

    it('names a reader whose member loads after their receipt', async () => {
      const { room, row } = await openConversation(10, 10);
      room.addReceipt(receipt(id(6), '@r:hs', 1));
      await settle();
      expect(row(id(6))?.readReceipts[0].name).toBe('@r:hs');

      // A reader who never posted is known only once the members load.
      room
        .getLiveTimeline()
        .getState(EventTimeline.FORWARDS)
        ?.setStateEvents([new MatrixEvent(member('@r:hs', 'Rosa'))]);
      await settle();

      expect(row(id(6))?.readReceipts[0].name).toBe('Rosa');
    });

    it('turns a local echo into the sent message', async () => {
      const { room, row } = await openConversation(10, 10);
      const echo = new MatrixEvent({
        event_id: '~!r:hs:t1',
        room_id: ROOM,
        type: 'm.room.message',
        sender: ME,
        origin_server_ts: T0 * 2,
        content: { msgtype: 'm.text', body: 'on its way' },
        unsigned: { transaction_id: 't1' },
      });
      echo.setStatus(EventStatus.SENDING);
      room.addPendingEvent(echo, 't1');
      await settle();
      expect(row('~!r:hs:t1')?.status).toBe('sending');

      room.updatePendingEvent(echo, EventStatus.SENT, '$sent');
      await settle();

      expect(row('~!r:hs:t1')).toBeUndefined();
      expect(row('$sent')?.status).toBeNull();
      expect(row('$sent')?.body).toBe('on its way');
    });

    it('shows an edit of a thread root and keeps its thread out of the timeline', async () => {
      const { row, svc, receive } = await openConversation(10, 10);

      await receive(
        live('$in-thread', {
          sender: '@b:hs',
          content: {
            msgtype: 'm.text',
            body: 'threaded',
            'm.relates_to': { rel_type: 'm.thread', event_id: id(5) },
          },
        }),
      );
      await receive(
        live('$root-edit', {
          content: {
            msgtype: 'm.text',
            body: '* root, edited',
            'm.new_content': { msgtype: 'm.text', body: 'root, edited' },
            'm.relates_to': { rel_type: 'm.replace', event_id: id(5) },
          },
        }),
      );

      expect(svc.messages().map((m) => m.id)).not.toContain('$in-thread');
      expect(row(id(5))?.body).toBe('root, edited');
    });

    it('shows a message that failed to send', async () => {
      const { room, row } = await openConversation(10, 10);
      const echo = new MatrixEvent({
        event_id: '~!r:hs:t2',
        room_id: ROOM,
        type: 'm.room.message',
        sender: ME,
        origin_server_ts: T0 * 2,
        content: { msgtype: 'm.text', body: 'lost' },
        unsigned: { transaction_id: 't2' },
      });
      echo.setStatus(EventStatus.SENDING);
      room.addPendingEvent(echo, 't2');
      await settle();
      expect(row('~!r:hs:t2')?.status).toBe('sending');

      room.updatePendingEvent(echo, EventStatus.NOT_SENT);
      await settle();

      expect(row('~!r:hs:t2')?.status).toBe('failed');
    });

    it('marks old plaintext messages once the room turns encryption on', async () => {
      const { row, receive } = await openConversation(10, 10, {
        6: {
          content: { msgtype: 'm.text', body: 'see https://example.org' },
        },
      });
      expect(row(id(6))?.shield ?? null).toBeNull();
      expect(row(id(6))?.previewEncrypted).toBe(false);

      await receive(
        live('$encryption', {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        }),
      );

      expect(row(id(6))?.shield?.level).toBe('unencrypted-history');
      expect(row(id(6))?.previewEncrypted).toBe(true);
    });

    it('marks the quoted clear message of an encrypted reply once the crypto store reports the room encrypted', async () => {
      let learn: (encrypted: boolean) => void = () => undefined;
      const crypto: ShieldProbe = {
        ...TRUSTING,
        isEncryptionEnabledInRoom: () =>
          new Promise<boolean>((resolve) => (learn = resolve)),
      };
      const { row, event } = await openConversation(
        10,
        10,
        { 7: { ...ENCRYPTED, ...reply(7, 6) } },
        { crypto },
      );
      await event(7).attemptDecryption(
        decryptor(() =>
          Promise.resolve({
            clearEvent: {
              type: 'm.room.message',
              content: {
                msgtype: 'm.text',
                body: 'reply 7',
                'm.relates_to': { 'm.in_reply_to': { event_id: id(6) } },
              },
            },
          }),
        ),
      );
      await settle();
      expect(row(id(7))?.replyTo?.body).toBe('message 6');
      expect(row(id(7))?.replyTo?.shield ?? null).toBeNull();

      learn(true);
      await settle();

      expect(row(id(7))?.replyTo?.shield?.level).toBe('unencrypted');
    });
  });

  describe('shields', () => {
    const shieldOf = (colour: EventShieldColour) => ({
      shieldColour: colour,
      shieldReason: EventShieldReason.UNSIGNED_DEVICE,
    });
    const plaintext = (body: string, extra: object = {}) =>
      decryptor(() =>
        Promise.resolve({
          clearEvent: {
            type: 'm.room.message',
            content: { msgtype: 'm.text', body, ...extra },
          },
        }),
      );

    it('shows the shield of an edit that replaced an encrypted message', async () => {
      const crypto: ShieldProbe = {
        getEncryptionInfoForEvent: (e) =>
          Promise.resolve(
            shieldOf(
              e.getId() === '$edit'
                ? EventShieldColour.RED
                : EventShieldColour.GREY,
            ),
          ),
        isEncryptionEnabledInRoom: () => Promise.resolve(true),
      };
      const { row, event, receive } = await openConversation(
        10,
        10,
        { 3: ENCRYPTED },
        { crypto },
      );
      await event(3).attemptDecryption(plaintext('original'));
      await vi.waitFor(() => expect(row(id(3))?.shield?.level).toBe('grey'));

      await receive(
        live('$edit', {
          ...ENCRYPTED,
          content: {
            ...ENCRYPTED.content,
            'm.relates_to': { rel_type: 'm.replace', event_id: id(3) },
          },
        }),
      );
      await event('$edit').attemptDecryption(
        plaintext('* changed', {
          'm.new_content': { msgtype: 'm.text', body: 'changed' },
          'm.relates_to': { rel_type: 'm.replace', event_id: id(3) },
        }),
      );

      await vi.waitFor(() => expect(row(id(3))?.shield?.level).toBe('red'));
      expect(row(id(3))?.body).toBe('changed');
    });

    it('drops a shield once the sender is verified', async () => {
      let verified = false;
      const crypto: ShieldProbe = {
        getEncryptionInfoForEvent: () =>
          Promise.resolve(
            shieldOf(
              verified ? EventShieldColour.NONE : EventShieldColour.GREY,
            ),
          ),
        isEncryptionEnabledInRoom: () => Promise.resolve(true),
      };
      const { client, row, event } = await openConversation(
        10,
        10,
        { 3: ENCRYPTED },
        { crypto },
      );
      await event(3).attemptDecryption(plaintext('hello'));
      await vi.waitFor(() => expect(row(id(3))?.shield?.level).toBe('grey'));

      verified = true;
      client.emit(CryptoEvent.UserTrustStatusChanged, '@a:hs', {} as never);

      await vi.waitFor(() => expect(row(id(3))?.shield ?? null).toBeNull());
    });
  });

  // A server bundles a message's latest edit in `unsigned`, and the SDK attaches it
  // without checking who sent it or what it replaces.
  describe('an edit the server bundles with a message', () => {
    const editOf = (target: string, over: Raw = {}): Raw => ({
      event_id: '$bundled',
      room_id: ROOM,
      type: 'm.room.message',
      sender: '@a:hs',
      origin_server_ts: T0 * 2,
      content: {
        msgtype: 'm.text',
        body: '* changed',
        'm.new_content': { msgtype: 'm.text', body: 'changed' },
        'm.relates_to': { rel_type: 'm.replace', event_id: target },
      },
      ...over,
    });
    const bundling = (edit: Raw, over: Raw = {}): Raw => ({
      ...over,
      unsigned: { 'm.relations': { 'm.replace': edit } } as never,
    });
    const sealedEditOf = (target: string, sender = '@a:hs'): Raw => ({
      ...ENCRYPTED,
      event_id: '$bundled',
      room_id: ROOM,
      sender,
      origin_server_ts: T0 * 2,
      content: {
        ...ENCRYPTED.content,
        'm.relates_to': { rel_type: 'm.replace', event_id: target },
      },
    });
    const editedText = (target: string) =>
      decryptor(() =>
        Promise.resolve({
          clearEvent: {
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: '* changed',
              'm.new_content': { msgtype: 'm.text', body: 'changed' },
              'm.relates_to': { rel_type: 'm.replace', event_id: target },
            },
          },
        }),
      );

    it('applies an edit its sender made, and marks it edited', async () => {
      const { row } = await openConversation(10, 10, {
        2: bundling(editOf(id(2))),
      });

      expect(row(id(2))?.body).toBe('changed');
      expect(row(id(2))?.edited).toBe(true);
    });

    it('ignores an edit from someone else, and does not mark it edited', async () => {
      const { row } = await openConversation(10, 10, {
        2: bundling(editOf(id(2), { sender: '@m:hs' })),
      });

      expect(row(id(2))?.body).toBe('message 2');
      expect(row(id(2))?.edited).toBe(false);
    });

    it('ignores an edit of another message', async () => {
      const { row } = await openConversation(10, 10, {
        2: bundling(editOf(id(5))),
      });

      expect(row(id(2))?.body).toBe('message 2');
      expect(row(id(2))?.edited).toBe(false);
    });

    it('keeps the text when the edit carries no m.new_content', async () => {
      const { row } = await openConversation(10, 10, {
        2: bundling(
          editOf(id(2), {
            content: {
              msgtype: 'm.text',
              body: '* changed',
              'm.relates_to': { rel_type: 'm.replace', event_id: id(2) },
            },
          }),
        ),
      });

      expect(row(id(2))?.body).toBe('message 2');
      expect(row(id(2))?.edited).toBe(false);
    });

    it("ignores another member's encrypted edit of an encrypted message", async () => {
      const { row, event } = await openConversation(10, 10, {
        3: bundling(sealedEditOf(id(3), '@m:hs'), ENCRYPTED),
      });
      await event(3).attemptDecryption(
        decryptor(() =>
          Promise.resolve({
            clearEvent: {
              type: 'm.room.message',
              content: { msgtype: 'm.text', body: 'original' },
            },
          }),
        ),
      );
      await event(3)
        .replacingEvent()!
        .attemptDecryption(editedText(id(3)));
      await settle();

      expect(row(id(3))?.body).toBe('original');
      expect(row(id(3))?.edited).toBe(false);
    });

    it("shows only the edit's own text, nothing from an edit bundled with the edit", async () => {
      const forged: Raw = {
        event_id: '$nested',
        room_id: ROOM,
        type: 'm.room.message',
        sender: '@m:hs',
        origin_server_ts: T0 * 3,
        content: {
          'm.new_content': {
            'm.new_content': { msgtype: 'm.text', body: 'FORGED' },
          },
        },
      };
      const { row, event } = await openConversation(10, 10, {
        2: bundling(bundling(forged, editOf(id(2)))),
        3: bundling(
          bundling(
            forged,
            editOf(id(3), {
              event_id: '$empty',
              content: {
                msgtype: 'm.text',
                body: '* changed',
                'm.relates_to': { rel_type: 'm.replace', event_id: id(3) },
              },
            }),
          ),
        ),
      });

      expect(event(2).replacingEvent()?.replacingEvent()?.getId()).toBe(
        '$nested',
      );
      expect(row(id(2))?.body).toBe('changed');
      expect(row(id(2))?.edited).toBe(true);
      expect(shieldSubject(event(2)).getId()).toBe('$bundled');
      expect(row(id(3))?.body).toBe('message 3');
      expect(row(id(3))?.edited).toBe(false);
      expect(shieldSubject(event(3))).toBe(event(3));
    });

    it('shows the edit once it decrypts, and the original until then', async () => {
      const { row, event } = await openConversation(
        10,
        10,
        { 2: bundling(sealedEditOf(id(2))) },
        { crypto: TRUSTING },
      );
      expect(row(id(2))?.body).toBe('message 2');
      expect(row(id(2))?.edited).toBe(false);

      await event(2)
        .replacingEvent()!
        .attemptDecryption(editedText(id(2)));

      await vi.waitFor(() => expect(row(id(2))?.body).toBe('changed'));
      expect(row(id(2))?.edited).toBe(true);
    });

    /** A message decrypted with `originalInfo`, whose bundled edit decrypts later. */
    async function lateEdit(originalInfo: unknown) {
      let resolveEdit: (info: unknown) => void = () => undefined;
      const editInfo = new Promise((resolve) => (resolveEdit = resolve));
      const probe = vi.fn((e: MatrixEvent) =>
        e.getId() === '$bundled' ? editInfo : Promise.resolve(originalInfo),
      );
      const crypto: ShieldProbe = {
        getEncryptionInfoForEvent: probe,
        isEncryptionEnabledInRoom: () => Promise.resolve(true),
      };
      const conversation = await openConversation(
        10,
        10,
        { 3: bundling(sealedEditOf(id(3)), ENCRYPTED) },
        { crypto },
      );
      const { event } = conversation;
      await event(3).attemptDecryption(
        decryptor(() =>
          Promise.resolve({
            clearEvent: {
              type: 'm.room.message',
              content: { msgtype: 'm.text', body: 'original' },
            },
          }),
        ),
      );
      await vi.waitFor(() =>
        expect(probe.mock.calls.map(([e]) => e.getId())).toContain(id(3)),
      );
      await event(3)
        .replacingEvent()!
        .attemptDecryption(editedText(id(3)));
      await vi.waitFor(() =>
        expect(probe.mock.calls.map(([e]) => e.getId())).toContain('$bundled'),
      );
      await settle();
      return { ...conversation, resolveEdit };
    }

    it("shows a late edit over a trusted message only once the edit's own shield resolves", async () => {
      const { row, resolveEdit } = await lateEdit(null);

      expect(row(id(3))?.body).toBe('original');
      expect(row(id(3))?.edited).toBe(false);
      expect(row(id(3))?.shield).toBeNull();

      resolveEdit(null);
      await vi.waitFor(() => expect(row(id(3))?.body).toBe('changed'));
      expect(row(id(3))?.edited).toBe(true);
      expect(row(id(3))?.shield).toBeNull();
    });

    it("shows a late edit's text with its own shield once that resolves as unverified", async () => {
      const grey = {
        shieldColour: EventShieldColour.GREY,
        shieldReason: EventShieldReason.UNSIGNED_DEVICE,
      };
      const { row, resolveEdit } = await lateEdit(grey);

      expect(row(id(3))?.body).toBe('original');
      expect(row(id(3))?.shield?.level).toBe('grey');

      resolveEdit({ ...grey, shieldColour: EventShieldColour.RED });
      await vi.waitFor(() => expect(row(id(3))?.body).toBe('changed'));
      expect(row(id(3))?.edited).toBe(true);
      expect(row(id(3))?.shield?.level).toBe('red');
    });

    it("shows the message's own shield while an edit that arrived with it is pending", async () => {
      const probe = vi.fn((e: MatrixEvent) =>
        e.getId() === '$bundled'
          ? new Promise(() => undefined)
          : Promise.resolve({
              shieldColour: EventShieldColour.GREY,
              shieldReason: EventShieldReason.UNSIGNED_DEVICE,
            }),
      );
      const { row, event, receive } = await openConversation(
        10,
        10,
        { 3: bundling(sealedEditOf(id(3)), ENCRYPTED) },
        {
          crypto: {
            getEncryptionInfoForEvent: probe,
            isEncryptionEnabledInRoom: () => Promise.resolve(true),
          },
        },
      );
      // The edit decrypts first, so it is already the row's subject when the message does.
      await event(3)
        .replacingEvent()!
        .attemptDecryption(editedText(id(3)));
      await event(3).attemptDecryption(
        decryptor(() =>
          Promise.resolve({
            clearEvent: {
              type: 'm.room.message',
              content: { msgtype: 'm.text', body: 'original' },
            },
          }),
        ),
      );

      await vi.waitFor(() =>
        expect(probe.mock.calls.map(([e]) => e.getId())).toContain('$bundled'),
      );
      // Any later refresh shows what has resolved so far.
      await receive(live('$later'));

      expect(row(id(3))?.shield?.level).toBe('grey');
      expect(row(id(3))?.body).toBe('original');
    });

    it("quotes a message in a reply as the message's row shows it", async () => {
      let resolveEdit: (info: unknown) => void = () => undefined;
      const editInfo = new Promise((resolve) => (resolveEdit = resolve));
      const probe = vi.fn((e: MatrixEvent) =>
        e.getId() === '$bundled' ? editInfo : Promise.resolve(null),
      );
      const { row, event } = await openConversation(
        10,
        10,
        { 3: bundling(sealedEditOf(id(3)), ENCRYPTED), 7: reply(7, 3) },
        {
          crypto: {
            getEncryptionInfoForEvent: probe,
            isEncryptionEnabledInRoom: () => Promise.resolve(true),
          },
        },
      );
      await event(3).attemptDecryption(
        decryptor(() =>
          Promise.resolve({
            clearEvent: {
              type: 'm.room.message',
              content: { msgtype: 'm.text', body: 'original' },
            },
          }),
        ),
      );
      await event(3)
        .replacingEvent()!
        .attemptDecryption(editedText(id(3)));
      await vi.waitFor(() =>
        expect(probe.mock.calls.map(([e]) => e.getId())).toContain('$bundled'),
      );
      await settle();

      expect(row(id(7))?.replyTo?.body).toBe('original');

      resolveEdit(null);
      await vi.waitFor(() => expect(row(id(3))?.body).toBe('changed'));
      expect(row(id(7))?.replyTo?.body).toBe('changed');
    });

    it("checks an edit on its own, even when it reuses a trusted message's id", async () => {
      let resolveEdit: (info: unknown) => void = () => undefined;
      const editInfo = new Promise((resolve) => (resolveEdit = resolve));
      const probe = vi.fn((e: MatrixEvent) =>
        e.getId() === id(2) && e.getSender() === '@a:hs' && e.isRelation()
          ? editInfo
          : Promise.resolve(null),
      );
      const { row, event } = await openConversation(
        10,
        10,
        {
          2: { ...ENCRYPTED, sender: '@b:hs' },
          3: bundling({ ...sealedEditOf(id(3)), event_id: id(2) }, ENCRYPTED),
        },
        {
          crypto: {
            getEncryptionInfoForEvent: probe,
            isEncryptionEnabledInRoom: () => Promise.resolve(true),
          },
        },
      );
      const plain = (body: string) =>
        decryptor(() =>
          Promise.resolve({
            clearEvent: {
              type: 'm.room.message',
              content: { msgtype: 'm.text', body },
            },
          }),
        );
      await event(2).attemptDecryption(plain('see you'));
      await event(3).attemptDecryption(plain('original'));
      const edit = event(3).replacingEvent()!;
      await edit.attemptDecryption(editedText(id(3)));
      await vi.waitFor(() =>
        expect(probe.mock.calls.map(([e]) => e)).toContain(edit),
      );
      await settle();

      expect(row(id(2))?.body).toBe('see you');
      expect(row(id(3))?.body).toBe('original');
      expect(row(id(3))?.edited).toBe(false);

      resolveEdit({
        shieldColour: EventShieldColour.RED,
        shieldReason: EventShieldReason.UNKNOWN_DEVICE,
      });
      await vi.waitFor(() => expect(row(id(3))?.body).toBe('changed'));
      expect(row(id(3))?.shield?.level).toBe('red');
    });

    it("judges the shield by the message, not by someone else's edit", async () => {
      const crypto: ShieldProbe = {
        getEncryptionInfoForEvent: (e) =>
          Promise.resolve(
            e.getId() === '$bundled'
              ? null
              : {
                  shieldColour: EventShieldColour.GREY,
                  shieldReason: EventShieldReason.UNSIGNED_DEVICE,
                },
          ),
        isEncryptionEnabledInRoom: () => Promise.resolve(true),
      };
      const { row, event } = await openConversation(
        10,
        10,
        { 3: bundling(sealedEditOf(id(3), '@m:hs'), ENCRYPTED) },
        { crypto },
      );
      await event(3).attemptDecryption(
        decryptor(() =>
          Promise.resolve({
            clearEvent: {
              type: 'm.room.message',
              content: { msgtype: 'm.text', body: 'original' },
            },
          }),
        ),
      );
      await event(3)
        .replacingEvent()!
        .attemptDecryption(editedText(id(3)));

      await vi.waitFor(() => expect(row(id(3))?.shield?.level).toBe('grey'));
    });
  });

  describe('system lines', () => {
    it('shows a hidden line again with a name that changed while it was hidden', async () => {
      const lines = systemLinesProvider({ membership: false });
      const { row, receive } = await openConversation(
        10,
        10,
        {
          4: {
            type: 'm.room.member',
            state_key: '@c:hs',
            sender: '@b:hs',
            content: { membership: 'invite' },
          },
        },
        { providers: [lines.provider] },
      );
      expect(row(id(4))).toBeUndefined();

      await receive(member('@c:hs', 'Carol'));
      lines.membership.set(true);
      TestBed.tick();
      await settle();

      expect(row(id(4))?.summary).toBe('@b:hs invited Carol');
    });
  });

  describe('the live timeline is replaced', () => {
    it('drops a quote whose message a trim removed', async () => {
      const { room, row, pageBack } = await openConversation(PAGE * 4, PAGE, {
        [PAGE * 4 - 5]: reply(PAGE * 4 - 5, 5),
      });
      await pageBack();
      await pageBack();
      await pageBack();
      expect(row(id(PAGE * 4 - 5))?.replyTo?.body).toBe('message 5');

      expect(trimLiveTimeline(room, ME)).toBeGreaterThan(0);
      await settle();

      expect(row(id(5))).toBeUndefined();
      expect(row(id(PAGE * 4 - 5))?.replyTo).toBeNull();
    });

    it('shows only what a gappy sync delivers after it resets the timeline', async () => {
      const { room, svc, receive } = await openConversation(10, 10);

      room.resetLiveTimeline('gap');
      await receive(
        live('$after-gap', { content: { msgtype: 'm.text', body: 'new' } }),
      );

      expect(svc.messages().map((m) => m.id)).toEqual(['$after-gap']);
    });
  });
});
