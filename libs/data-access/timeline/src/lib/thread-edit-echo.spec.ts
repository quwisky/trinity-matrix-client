import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  EventStatus,
  FeatureSupport,
  MatrixEvent,
  Room,
  THREAD_RELATION_TYPE,
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
import { CONVERSATION_MESSAGE_ADAPTER } from './conversation-message-adapter.service';
import { ThreadsService } from './threads.service';

// A real SDK client, Room, Thread and Relations: what a row shows after a cancelled echo is the
// SDK's own re-aggregation, which runs after its LocalEchoUpdated, so a fake would only restate it.

const ROOM = '!r:hs';
const ME = '@me:hs';
const ROOT = '$root';
const REPLY = '$reply';

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

const rootRaw = rawEvent(ROOT, 1, { msgtype: 'm.text', body: 'root' });

function replyRaw(unsigned: Record<string, unknown> = {}): IRoomEvent {
  return rawEvent(
    REPLY,
    2,
    {
      msgtype: 'm.text',
      body: 'original',
      'm.relates_to': {
        rel_type: THREAD_RELATION_TYPE.name,
        event_id: ROOT,
        is_falling_back: true,
        'm.in_reply_to': { event_id: ROOT },
      },
    },
    unsigned,
  );
}

function editRaw(id: string, ts: number, body: string): IRoomEvent {
  return rawEvent(id, ts, {
    msgtype: 'm.text',
    body: `* ${body}`,
    'm.new_content': { msgtype: 'm.text', body },
    'm.relates_to': { rel_type: 'm.replace', event_id: REPLY },
  });
}

/** What the homeserver does with the next PUT of an event: answers, refuses or never replies. */
type SendAnswer = () => Promise<Response>;

const refuse: SendAnswer = () =>
  Promise.resolve(
    new Response(JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'refused' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
const accept =
  (eventId: string): SendAnswer =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify({ event_id: eventId }), {
        status: 200,
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

async function openThread(reply: IRoomEvent = replyRaw()) {
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
      sentTxnIds.push(decodeURIComponent(send[1]));
      return (answers.shift() ?? accept('$unplanned'))();
    },
  });
  // `threadSupport` is a startClient option; the client is never started here.
  vi.spyOn(client, 'supportsThreads').mockReturnValue(true);
  vi.spyOn(client, 'fetchRoomEvent').mockResolvedValue(rootRaw);
  const room = new Room(ROOM, client, ME);
  client.store.storeRoom(room);
  // The mapper is what sync and pagination use, and it re-emits Replaced to the client.
  const map = client.getEventMapper({ decrypt: false });
  const root = map(rootRaw);
  await room.addLiveEvents([root], { addToState: false });
  const thread = room.createThread(ROOT, root, [], false);
  await vi.waitFor(() => expect(thread.initialEventsFetched).toBe(true));
  await room.addLiveEvents([map(reply)], { addToState: false });

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
      }),
      MockProvider(MediaService),
      MockProvider(ImagePackEditorService, {
        emoticons: signal(new Map<string, string>()),
      }),
      { provide: CONVERSATION_MESSAGE_ADAPTER, useValue: {} },
    ],
  });
  const svc = TestBed.inject(ThreadsService);
  svc.attach({ accountId: ME, roomId: ROOM }, client);
  svc.attachThreadRoot(ROOT);

  const row = () => svc.threadMessages().find((m) => m.id === REPLY);
  const preview = () => svc.summaries()[ROOT]?.latestReplyPreview;
  /** Row and preview together, once the SDK's asynchronous re-aggregation has settled. */
  const expectShown = (body: string, edited: boolean) =>
    vi.waitFor(() => {
      expect(row()?.body).toBe(body);
      expect(row()?.edited).toBe(edited);
      expect(preview()).toBe(body);
    });
  await expectShown(row()?.body ?? '', row()?.edited ?? false);

  return { client, room, svc, map, answers, sentTxnIds, row, expectShown };
}

/** An edit the SDK knows only as bundled on the message, as after a reload: in no Relations. */
function bundled(editId: string, ts: number, body: string) {
  return { 'm.relations': { 'm.replace': editRaw(editId, ts, body) } };
}

describe('a refused edit in a thread', () => {
  afterEach(() => {
    Thread.setServerSideSupport(FeatureSupport.None);
    vi.restoreAllMocks();
  });

  it('leaves the row and the preview on the original text, not marked edited', async () => {
    const { svc, answers, expectShown } = await openThread();
    answers.push(refuse);

    await expect(
      firstValueFrom(svc.editInThread(REPLY, 'refused text')),
    ).rejects.toThrow();

    await expectShown('original', false);
  });

  it('falls back to an earlier accepted edit, still marked edited', async () => {
    const { room, map, svc, answers, expectShown } = await openThread();
    await room.addLiveEvents([map(editRaw('$edit1', 3, 'accepted'))], {
      addToState: false,
    });
    await expectShown('accepted', true);
    answers.push(refuse);

    await expect(
      firstValueFrom(svc.editInThread(REPLY, 'refused text')),
    ).rejects.toThrow();

    await expectShown('accepted', true);
  });

  it('falls back to an accepted edit known only as bundled on the message', async () => {
    const { svc, answers, expectShown } = await openThread(
      replyRaw(bundled('$edit1', 3, 'bundled')),
    );
    await expectShown('bundled', true);
    answers.push(refuse);

    await expect(
      firstValueFrom(svc.editInThread(REPLY, 'refused text')),
    ).rejects.toThrow();

    await expectShown('bundled', true);
  });

  it('shows the new text when a retry lands', async () => {
    const { svc, answers, expectShown } = await openThread();
    answers.push(refuse, accept('$retried'));

    await expect(
      firstValueFrom(svc.editInThread(REPLY, 'typed text')),
    ).rejects.toThrow();
    await expectShown('original', false);

    await firstValueFrom(svc.editInThread(REPLY, 'typed text'));

    await expectShown('typed text', true);
  });

  it('shows the echo while the edit is pending', async () => {
    const { svc, answers, expectShown } = await openThread();
    const { answer, settle } = deferredAnswer();
    answers.push(answer);

    const edit = firstValueFrom(svc.editInThread(REPLY, 'pending text'));

    await expectShown('pending text', true);
    settle(refuse);
    await expect(edit).rejects.toThrow();
    await expectShown('original', false);
  });

  it('drops the echo even when nothing is subscribed any more', async () => {
    const { svc, answers, expectShown } = await openThread();
    const { answer, settle } = deferredAnswer();
    answers.push(answer);

    const closedPanel = svc.editInThread(REPLY, 'pending text').subscribe({
      error: () => undefined,
    });
    await expectShown('pending text', true);
    closedPanel.unsubscribe();
    settle(refuse);

    await expectShown('original', false);
  });

  it('touches neither an older pending edit nor another pending send', async () => {
    const { client, room, svc, answers, sentTxnIds, row } = await openThread();
    const txnIds = vi.spyOn(client, 'makeTxnId');
    // Still encrypting: the send queue is FIFO, so only that lets it outlive a newer refusal.
    const older = new MatrixEvent(editRaw('~older', 3, 'older pending'));
    older.setTxnId('older-txn');
    older.setStatus(EventStatus.SENDING);
    room.addPendingEvent(older, 'older-txn');
    room.updatePendingEvent(older, EventStatus.ENCRYPTING);
    const refused = deferredAnswer();
    answers.push(refused.answer);

    const edit = firstValueFrom(svc.editInThread(REPLY, 'refused text'));
    const otherSend = firstValueFrom(svc.sendToThread('another message'));
    await vi.waitFor(() => expect(sentTxnIds).toHaveLength(1));
    const otherTxn = txnIds.mock.results[1].value as string;
    refused.settle(refuse);
    await expect(edit).rejects.toThrow();

    expect(room.getEventForTxnId(sentTxnIds[0])?.status).toBe(
      EventStatus.CANCELLED,
    );
    expect(older.status).toBe(EventStatus.ENCRYPTING);
    // The SDK fails all that was queued behind a refusal. That send stays failed, to retry.
    await expect(otherSend).rejects.toThrow();
    expect(room.getEventForTxnId(otherTxn)?.status).toBe(EventStatus.NOT_SENT);
    await vi.waitFor(() => expect(row()?.body).toBe('older pending'));
    expect(row()?.edited).toBe(true);
  });

  it('follows a message that resolves to another edit with no new event', async () => {
    const { room, map, expectShown } = await openThread();
    // Past the refreshes that opening the thread still has in flight.
    await new Promise((resolve) => setTimeout(resolve, 50));

    room.findEventById(REPLY)?.makeReplaced(map(editRaw('$edit1', 3, 'moved')));

    await expectShown('moved', true);
  });

  it('shows an edit the server took after all once sync delivers it', async () => {
    const { room, map, svc, answers, sentTxnIds, expectShown } =
      await openThread();
    answers.push(dropConnection);

    await expect(
      firstValueFrom(svc.editInThread(REPLY, 'landed anyway')),
    ).rejects.toThrow();
    await expectShown('original', false);

    const remote = editRaw('$landed', 4, 'landed anyway');
    remote.unsigned = { transaction_id: sentTxnIds[0] };
    await room.addLiveEvents([map(remote)], { addToState: false });

    await expectShown('landed anyway', true);
  });
});
