import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  EventStatus,
  FeatureSupport,
  MatrixEvent,
  Room,
  Thread,
  createClient,
  type IRoomEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ImagePackEditorService,
  MediaService,
} from '@trinity/data-access/media';
import { DraftStoreService } from '@trinity/platform-native';
import { displayContent, validReplacement } from '@trinity/util/matrix';
import { CONVERSATION_MESSAGE_ADAPTER } from './conversation-message-adapter.service';
import { CONVERSATION_TEXT_SENDER } from './conversation-text-sender.service';
import type { ConversationTextSendRequest } from './conversation-compose';
import { ThreadsService } from './threads.service';

// A real SDK client, Room and Relations, for the reason thread-edit-echo.spec.ts gives.

const ROOM = '!r:hs';
const ME = '@me:hs';
const MESSAGE = '$message';
const KEY = { accountId: ME, roomId: ROOM } as const;

function rawEvent(
  id: string,
  ts: number,
  content: Record<string, unknown>,
  unsigned: Record<string, unknown> = {},
): IRoomEvent {
  return {
    event_id: id,
    room_id: ROOM,
    type: 'm.room.message',
    sender: ME,
    origin_server_ts: ts,
    content,
    unsigned,
  };
}

function messageRaw(unsigned: Record<string, unknown> = {}): IRoomEvent {
  return rawEvent(
    MESSAGE,
    1,
    { msgtype: 'm.text', body: 'original' },
    unsigned,
  );
}

function editRaw(id: string, ts: number, body: string): IRoomEvent {
  return rawEvent(id, ts, {
    msgtype: 'm.text',
    body: `* ${body}`,
    'm.new_content': { msgtype: 'm.text', body },
    'm.relates_to': { rel_type: 'm.replace', event_id: MESSAGE },
  });
}

/** An edit the SDK knows only as bundled on the message, as after a reload: in no Relations. */
function bundled(editId: string, ts: number, body: string) {
  return { 'm.relations': { 'm.replace': editRaw(editId, ts, body) } };
}

type SendAnswer = () => Promise<Response>;

const refuse: SendAnswer = () =>
  Promise.resolve(
    new Response(JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'refused' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
/** The request reached the server, or not: the client only ever sees a dropped connection. */
const dropConnection: SendAnswer = () =>
  Promise.reject(new TypeError('Failed to fetch'));

function deferredAnswer(): {
  answer: SendAnswer;
  settle: (result: SendAnswer) => void;
} {
  let settle!: (result: SendAnswer) => void;
  const pending = new Promise<SendAnswer>((resolve) => (settle = resolve));
  return { answer: () => pending.then((next) => next()), settle };
}

async function openRoom(message: IRoomEvent = messageRaw()) {
  Thread.setServerSideSupport(FeatureSupport.Stable);
  const answers: SendAnswer[] = [];
  const sentTxnIds: string[] = [];
  const client: MatrixClient = createClient({
    baseUrl: 'https://hs',
    userId: ME,
    fetchFn: (input) => {
      const send = /\/send\/m\.room\.message\/([^/?]+)/.exec(String(input));
      if (!send) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      const txnId = decodeURIComponent(send[1]);
      sentTxnIds.push(txnId);
      const accept: SendAnswer = () =>
        Promise.resolve(
          new Response(JSON.stringify({ event_id: `$sent-${txnId}` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      return (answers.shift() ?? accept)();
    },
  });
  // `threadSupport` is a startClient option; the client is never started here.
  vi.spyOn(client, 'supportsThreads').mockReturnValue(true);
  vi.spyOn(client, 'fetchRoomEvent').mockResolvedValue(messageRaw());
  const room = new Room(ROOM, client, ME);
  client.store.storeRoom(room);
  // The mapper is what sync and pagination use, and it re-emits Replaced to the client.
  const map = client.getEventMapper({ decrypt: false });
  const target = map(message);
  await room.addLiveEvents([target], { addToState: false });

  TestBed.configureTestingModule({
    providers: [
      ThreadsService,
      {
        provide: DraftStoreService,
        useValue: { holdWaiting: vi.fn(), releaseWaiting: vi.fn() },
      },
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client,
        clientFor: () => client,
      }),
      MockProvider(MediaService),
      MockProvider(ImagePackEditorService, {
        emoticons: signal(new Map<string, string>()),
      }),
      { provide: CONVERSATION_MESSAGE_ADAPTER, useValue: {} },
    ],
  });
  const sender = TestBed.inject(CONVERSATION_TEXT_SENDER);

  const edit = (body: string) =>
    sender.send({
      key: KEY,
      body,
      mentions: [],
      intent: { kind: 'edit', eventId: MESSAGE },
    } satisfies ConversationTextSendRequest);
  /** What a row reads, once the SDK's asynchronous re-aggregation has settled. */
  const expectShown = (body: string, edited: boolean) =>
    vi.waitFor(() => {
      expect(displayContent(target)['body']).toBe(body);
      expect(validReplacement(target) !== undefined).toBe(edited);
    });
  return {
    client,
    room,
    sender,
    target,
    map,
    answers,
    sentTxnIds,
    edit,
    expectShown,
  };
}

describe('a refused edit in the room timeline', () => {
  afterEach(() => {
    Thread.setServerSideSupport(FeatureSupport.None);
    vi.restoreAllMocks();
  });

  it('leaves the message on its original text, not marked edited', async () => {
    const { answers, edit, expectShown } = await openRoom();
    answers.push(refuse);

    await expect(firstValueFrom(edit('refused text').outcome)).resolves.toEqual(
      { kind: 'rejected', retryable: true },
    );

    await expectShown('original', false);
  });

  it('takes the echo out of the room, so the latest-message preview cannot read it', async () => {
    const { room, answers, edit } = await openRoom();
    answers.push(refuse);

    await firstValueFrom(edit('refused text').outcome);

    expect(
      room
        .getLiveTimeline()
        .getEvents()
        .map((e) => e.getId()),
    ).toEqual([MESSAGE]);
  });

  it('falls back to an earlier accepted edit, still marked edited', async () => {
    const { room, map, answers, edit, expectShown } = await openRoom();
    await room.addLiveEvents([map(editRaw('$edit1', 2, 'accepted'))], {
      addToState: false,
    });
    await expectShown('accepted', true);
    answers.push(refuse);

    await firstValueFrom(edit('refused text').outcome);

    await expectShown('accepted', true);
  });

  it('falls back to an accepted edit known only as bundled on the message', async () => {
    const { answers, edit, expectShown } = await openRoom(
      messageRaw(bundled('$edit1', 2, 'bundled')),
    );
    await expectShown('bundled', true);
    answers.push(refuse);

    await firstValueFrom(edit('refused text').outcome);

    await expectShown('bundled', true);
  });

  it('shows the new text when a retry lands', async () => {
    const { answers, edit, expectShown } = await openRoom();
    answers.push(refuse);

    await firstValueFrom(edit('typed text').outcome);
    await expectShown('original', false);

    await expect(firstValueFrom(edit('typed text').outcome)).resolves.toEqual(
      expect.objectContaining({ kind: 'accepted' }),
    );

    await expectShown('typed text', true);
  });

  it('shows the echo while the edit is pending', async () => {
    const { answers, edit, expectShown } = await openRoom();
    const { answer, settle } = deferredAnswer();
    answers.push(answer);

    const outcome = firstValueFrom(edit('pending text').outcome);

    await expectShown('pending text', true);
    settle(refuse);
    await outcome;
    await expectShown('original', false);
  });

  it('drops the echo even when nothing is subscribed any more', async () => {
    const { answers, edit, expectShown } = await openRoom();
    const { answer, settle } = deferredAnswer();
    answers.push(answer);

    const leftRoom = edit('pending text').outcome.subscribe();
    await expectShown('pending text', true);
    leftRoom.unsubscribe();
    settle(refuse);

    await expectShown('original', false);
  });

  it('falls back to a bundled edit when a queued edit is cancelled', async () => {
    const { answers, edit, sender, expectShown } = await openRoom(
      messageRaw(bundled('$edit1', 2, 'bundled')),
    );
    const head = deferredAnswer();
    answers.push(head.answer);
    const first = sender.send({
      key: KEY,
      body: 'ahead in the queue',
      mentions: [],
      intent: { kind: 'message' },
    });
    const firstOutcome = firstValueFrom(first.outcome);
    await vi.waitFor(() => expect(answers).toHaveLength(0));

    const queued = edit('queued text');
    const subscription = queued.outcome.subscribe();
    await expectShown('queued text', true);

    await vi.waitFor(() => expect(queued.cancel()).toBe(true));
    subscription.unsubscribe();

    await expectShown('bundled', true);
    head.settle(refuse);
    await firstOutcome;
  });

  it('touches neither an older pending edit nor another pending send', async () => {
    const { client, room, answers, sentTxnIds, edit, sender, target } =
      await openRoom();
    const txnIds = vi.spyOn(client, 'makeTxnId');
    // Still encrypting: the send queue is FIFO, so only that lets it outlive a newer refusal.
    const older = new MatrixEvent(editRaw('~older', 2, 'older pending'));
    older.setTxnId('older-txn');
    older.setStatus(EventStatus.SENDING);
    room.addPendingEvent(older, 'older-txn');
    room.updatePendingEvent(older, EventStatus.ENCRYPTING);
    const refused = deferredAnswer();
    answers.push(refused.answer);

    const outcome = firstValueFrom(edit('refused text').outcome);
    const otherSend = firstValueFrom(
      sender.send({
        key: KEY,
        body: 'another message',
        mentions: [],
        intent: { kind: 'message' },
      }).outcome,
    );
    await vi.waitFor(() => expect(sentTxnIds).toHaveLength(1));
    const otherTxn = txnIds.mock.results[1].value as string;
    refused.settle(refuse);
    await outcome;

    expect(room.getEventForTxnId(sentTxnIds[0])?.status).toBe(
      EventStatus.CANCELLED,
    );
    expect(older.status).toBe(EventStatus.ENCRYPTING);
    // The SDK fails all that was queued behind a refusal. That send stays failed, to retry.
    await otherSend;
    expect(room.getEventForTxnId(otherTxn)?.status).toBe(EventStatus.NOT_SENT);
    await vi.waitFor(() =>
      expect(displayContent(target)['body']).toBe('older pending'),
    );
  });

  it('keeps the failed echo of a plain send, for its Retry', async () => {
    const { room, answers, sender, sentTxnIds } = await openRoom();
    answers.push(refuse);

    await expect(
      firstValueFrom(
        sender.send({
          key: KEY,
          body: 'plain message',
          mentions: [],
          intent: { kind: 'message' },
        }).outcome,
      ),
    ).resolves.toEqual({ kind: 'rejected', retryable: true });

    expect(room.getEventForTxnId(sentTxnIds[0])?.status).toBe(
      EventStatus.NOT_SENT,
    );
  });

  it('still rejects, retryably, when cancelling the echo throws', async () => {
    const { client, answers, edit } = await openRoom();
    vi.spyOn(client, 'cancelPendingEvent').mockImplementation(() => {
      throw new Error('cannot cancel');
    });
    answers.push(refuse);

    await expect(firstValueFrom(edit('refused text').outcome)).resolves.toEqual(
      { kind: 'rejected', retryable: true },
    );
  });

  it('shows an edit the server took after all once sync delivers it', async () => {
    const { room, map, answers, sentTxnIds, edit, expectShown } =
      await openRoom();
    answers.push(dropConnection);

    await expect(
      firstValueFrom(edit('landed anyway').outcome),
    ).resolves.toEqual({ kind: 'rejected', retryable: true });
    await expectShown('original', false);

    const remote = editRaw('$landed', 3, 'landed anyway');
    remote.unsigned = { transaction_id: sentTxnIds[0] };
    await room.addLiveEvents([map(remote)], { addToState: false });

    await expectShown('landed anyway', true);
  });

  it("puts a thread root's preview back after its refused edit", async () => {
    const { client, room, answers, edit } = await openRoom();
    const thread = room.createThread(
      MESSAGE,
      room.findEventById(MESSAGE),
      [],
      false,
    );
    await vi.waitFor(() => expect(thread.initialEventsFetched).toBe(true));
    const threads = TestBed.inject(ThreadsService);
    threads.attach(KEY, client);
    const preview = () => threads.summaries()[MESSAGE]?.rootPreview;
    await vi.waitFor(() => expect(preview()).toBe('original'));
    // Past the refreshes that attaching still has in flight.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { answer, settle } = deferredAnswer();
    answers.push(answer);

    const outcome = firstValueFrom(edit('refused text').outcome);
    await vi.waitFor(() => expect(preview()).toBe('refused text'));
    settle(refuse);
    await outcome;

    await vi.waitFor(() => expect(preview()).toBe('original'));
  });
});
