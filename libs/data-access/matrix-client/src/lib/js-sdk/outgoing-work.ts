import {
  isTemporarySendError,
  isWaitingToSend,
  stripReplyFallbackText,
} from '@trinity/util/matrix';
import {
  EventStatus,
  EventType,
  MsgType,
  RelationType,
  type EventTimeline,
  type IContent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import type { PendingTextMessage } from '../session-engine';

/** Local-echo states of a message still on its way to the homeserver. */
const ON_ITS_WAY: ReadonlySet<EventStatus> = new Set([
  EventStatus.QUEUED,
  EventStatus.ENCRYPTING,
  EventStatus.SENDING,
]);

/** Local-echo states of a message the homeserver does not have: on its way, or failed. */
const NOT_ON_SERVER: ReadonlySet<EventStatus> = new Set([
  ...ON_ITS_WAY,
  EventStatus.NOT_SENT,
]);

/** matrix-js-sdk keeps its sync loop on the protected `MatrixClient.syncApi`. */
interface SyncLoopOwner {
  readonly syncApi?: { stop(): void };
}

/**
 * matrix-js-sdk keeps every in-flight local echo of a room in the private `Room.txnToEvent`.
 * With the default `chronological` ordering a thread reply's echo is in no live timeline, so
 * this map is the only place that lists it.
 */
interface PendingEchoOwner {
  readonly txnToEvent?: ReadonlyMap<string, MatrixEvent>;
}

/**
 * Stop a client's sync loop and nothing else. `stopClient()` stops the loop the same way
 * (`this.syncApi?.stop()`), but it stops the crypto engine first, which a message still being
 * encrypted needs. There is no public sync-only stop. Should a later SDK rename the member,
 * this does nothing, and sync stops with `stopClient()` at most five seconds later. It also does
 * nothing while the client is still starting, before `startClient()` has created the member.
 */
export function pauseClientSync(client: MatrixClient): void {
  const loop = (client as unknown as SyncLoopOwner).syncApi;
  if (typeof loop?.stop === 'function') loop.stop();
}

/**
 * Whether a client still has a message on its way (a local echo queued, encrypting or sending,
 * in a room or a thread) or a file uploading. Work the SDK has not been handed yet, such as a
 * file still being encrypted before its upload starts, is not visible here.
 */
export function clientHasOutgoingWork(client: MatrixClient): boolean {
  return (
    client.getCurrentUploads().length > 0 ||
    client
      .getRooms()
      .some((room) =>
        localEchoes(room).some(
          (event) => event.status !== null && ON_ITS_WAY.has(event.status),
        ),
      )
  );
}

/**
 * Every text message of `client` that the homeserver does not have, room by room, main
 * timeline first. With the SDK's default `chronological` ordering `room.getPendingEvents()`
 * throws, so the live timelines are scanned instead; an echo found in two is counted once.
 */
export function clientPendingTexts(
  client: MatrixClient,
  accountId: string,
): PendingTextMessage[] {
  const seen = new Set<string>();
  const messages: PendingTextMessage[] = [];
  for (const room of client.getRooms()) {
    for (const event of localEchoes(room)) {
      const id = event.getId();
      const text = unsentText(event);
      if (!id || text === null || seen.has(id)) continue;
      seen.add(id);
      const txnId = event.getTxnId();
      messages.push({
        accountId,
        roomId: room.roomId,
        threadRootId: threadOf(event, id),
        text,
        ...(txnId ? { txnId } : {}),
      });
    }
  }
  return messages;
}

/** How many of `client`'s messages wait to go out by themselves, an echo in two lists counted once. */
export function waitingEchoCount(client: MatrixClient): number {
  const seen = new Set<MatrixEvent>();
  for (const room of client.getRooms()) {
    for (const event of localEchoes(room)) {
      if (isWaitingToSend(event)) seen.add(event);
    }
  }
  return seen.size;
}

/**
 * Send again every message of `client` that failed only because it was offline. Within a room
 * they go one at a time in send order; rooms run side by side. Each is checked again just
 * before its turn, so a manual Retry or Cancel that got there first is never doubled, and
 * nothing more is sent once `live` turns false. Still offline or rate-limited, a room stops there
 * and the rest wait for the next pass, keeping their order; an echo the server refuses becomes a manual
 * failure and the next one goes.
 */
export async function resendWaitingEchoes(
  client: MatrixClient,
  live: () => boolean,
): Promise<void> {
  await Promise.all(
    client.getRooms().map(async (room) => {
      for (const event of localEchoes(room).filter(isWaitingToSend)) {
        if (!live()) return;
        if (!isWaitingToSend(event)) continue;
        try {
          await client.resendEvent(event, room);
        } catch (error: unknown) {
          if (isTemporarySendError(error)) return;
        }
      }
    }),
  );
}

/**
 * The events of a room that may be local echoes, each at most once, in send order where the SDK
 * knows it: the room's in-flight map first, then whatever its live timelines hold. The map is a
 * private member; should a later SDK rename it, the timelines alone still cover the main one.
 */
function localEchoes(room: Room): MatrixEvent[] {
  const events = new Set<MatrixEvent>();
  const inFlight = (room as unknown as PendingEchoOwner).txnToEvent;
  if (inFlight instanceof Map) {
    for (const event of inFlight.values()) events.add(event);
  }
  const timelines: EventTimeline[] = [
    room.getLiveTimeline(),
    ...room.getThreads().map((thread) => thread.liveTimeline),
  ];
  for (const timeline of timelines) {
    for (const event of timeline.getEvents()) events.add(event);
  }
  return [...events];
}

/**
 * What the composer needs to send an unsent `m.text` or `m.emote` again; null for anything
 * else. A rich reply loses the `> <sender> …` quote its body carries, which is not the user's
 * text, and a spoiler gets its `/spoiler` command back, since the plain body alone would send
 * it unhidden.
 */
function unsentText(event: MatrixEvent): string | null {
  if (event.status === null || !NOT_ON_SERVER.has(event.status)) return null;
  if (event.getType() !== EventType.RoomMessage) return null;
  // An edit is a change to a message that exists, not new text to send.
  if (event.isRelation(RelationType.Replace)) return null;
  const content = event.getContent();
  const body: unknown = content['body'];
  const msgtype: unknown = content.msgtype;
  if (typeof body !== 'string') return null;
  const text = isRichReply(content) ? stripReplyFallbackText(body) : body;
  if (text.trim() === '') return null;
  if (msgtype === MsgType.Emote) return `/me ${text}`;
  if (msgtype !== MsgType.Text) return null;
  return isSpoiler(content) ? `/spoiler ${text}` : text;
}

/**
 * A reply whose body quotes the message it answers (`replyMessageContent`). A thread's own
 * fallback reply (`is_falling_back`) carries no quote, so its body is left alone.
 */
function isRichReply(content: IContent): boolean {
  const relation: unknown = content['m.relates_to'];
  if (typeof relation !== 'object' || relation === null) return false;
  const { 'm.in_reply_to': inReplyTo, is_falling_back: fallingBack } =
    relation as Record<string, unknown>;
  return (
    typeof inReplyTo === 'object' && inReplyTo !== null && fallingBack !== true
  );
}

/**
 * `/spoiler` sends its text as a formatted body that opens with `<span data-mx-spoiler`; a
 * message that only contains such a span somewhere is not one.
 */
function isSpoiler(content: IContent): boolean {
  const formatted: unknown = content['formatted_body'];
  return (
    typeof formatted === 'string' &&
    formatted.trimStart().startsWith('<span data-mx-spoiler')
  );
}

function threadOf(event: MatrixEvent, id: string): string | null {
  const root = event.threadRootId;
  return root && root !== id ? root : null;
}
