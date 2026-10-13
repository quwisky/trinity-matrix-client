import { stripReplyFallbackText } from '@trinity/util/matrix';
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

/** A text message a live client has not got onto the homeserver (owner decision 5 of #1267). */
export interface PendingTextMessage {
  readonly accountId: string;
  readonly roomId: string;
  /** The thread it replies in, or null for the room's main timeline. */
  readonly threadRootId: string | null;
  /** What to put back in the composer: the plain body, the composer's own markdown source. */
  readonly text: string;
}

/** matrix-js-sdk keeps its sync loop on the protected `MatrixClient.syncApi`. */
interface SyncLoopOwner {
  readonly syncApi?: { stop(): void };
}

/**
 * Stop a client's sync loop and nothing else. `stopClient()` stops the loop the same way
 * (`this.syncApi?.stop()`), but it stops the crypto engine first, which a message still being
 * encrypted needs. There is no public sync-only stop. Should a later SDK rename the member,
 * this does nothing, and sync stops with `stopClient()` at most five seconds later.
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
        liveTimelines(room).some((timeline) =>
          timeline
            .getEvents()
            .some(
              (event) => event.status !== null && ON_ITS_WAY.has(event.status),
            ),
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
    for (const timeline of liveTimelines(room)) {
      for (const event of timeline.getEvents()) {
        const id = event.getId();
        const text = unsentText(event);
        if (!id || text === null || seen.has(id)) continue;
        seen.add(id);
        messages.push({
          accountId,
          roomId: room.roomId,
          threadRootId: threadOf(event, id),
          text,
        });
      }
    }
  }
  return messages;
}

function liveTimelines(room: Room): EventTimeline[] {
  return [
    room.getLiveTimeline(),
    ...room.getThreads().map((thread) => thread.liveTimeline),
  ];
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

/** `/spoiler` sends its text hidden in a `<span data-mx-spoiler>` formatted body. */
function isSpoiler(content: IContent): boolean {
  const formatted: unknown = content['formatted_body'];
  return typeof formatted === 'string' && formatted.includes('data-mx-spoiler');
}

function threadOf(event: MatrixEvent, id: string): string | null {
  const root = event.threadRootId;
  return root && root !== id ? root : null;
}
