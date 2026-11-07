import {
  isTemporarySendError,
  isWaitingToSend,
  resendAtEnd,
  stripReplyFallbackText,
} from '@trinity/util/matrix';
import {
  EventStatus,
  EventType,
  MsgType,
  RelationType,
  SyncState,
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

/** A text message a live client has not got onto the homeserver. */
export interface PendingTextMessage {
  readonly accountId: string;
  readonly roomId: string;
  /** The thread it replies in, or null for the room's main timeline. */
  readonly threadRootId: string | null;
  /** What to put back in the composer: the plain body, the composer's own markdown source. */
  readonly text: string;
  /** Names the echo's waiting-to-send record in the draft store, which this text supersedes. */
  readonly txnId?: string;
}

/** matrix-js-sdk keeps its sync loop on the protected `MatrixClient.syncApi`. */
interface SyncLoopOwner {
  readonly syncApi?: PausableSyncLoop;
}

/** The private `SyncApi` members a pause watches the stopped loop's exit through. */
interface PausableSyncLoop {
  stop(): void;
  readonly running?: boolean;
  readonly connectionReturnedResolvers?: unknown;
  readonly savedSyncPromise?: Promise<void>;
  updateSyncState?(state: SyncState, data?: unknown): void;
  startKeepAlives?(): Promise<boolean>;
}

/** States a stopped loop reports on its way out; they describe no connection anyone has. */
const LATE_STATES: ReadonlySet<SyncState> = new Set([
  SyncState.Stopped,
  SyncState.Error,
  SyncState.Reconnecting,
  SyncState.Catchup,
]);

/** Settles once each paused loop can no longer process or request anything. */
const exits = new WeakMap<PausableSyncLoop, Promise<void>>();

/** Whether a client's loop should run once its paused one has exited. */
const wanted = new WeakMap<MatrixClient, boolean>();

/** Resumes waiting for a paused loop's exit, so a second resume joins the first. */
const resuming = new WeakSet<MatrixClient>();

/**
 * The loop's exit, with its late state reports dropped: a resume must not hear "stopped" from a
 * loop already replaced. It exits through `updateSyncState(Stopped)`, after the response it was
 * processing and any saved-sync replay; a loop in, or entering, a keep-alive never syncs again.
 */
function watchExit(loop: PausableSyncLoop): Promise<void> {
  if (!loop.running || typeof loop.updateSyncState !== 'function') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const report = loop.updateSyncState!.bind(loop);
    loop.updateSyncState = (state, data) => {
      if (state === SyncState.Stopped) resolve();
      if (!LATE_STATES.has(state)) report(state, data);
    };
    loop.startKeepAlives = () => {
      resolve();
      return new Promise<boolean>(() => undefined);
    };
    if (loop.connectionReturnedResolvers) resolve();
  });
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
  wanted.set(client, false);
  const loop = (client as unknown as SyncLoopOwner).syncApi;
  if (typeof loop?.stop !== 'function') return;
  if (!exits.has(loop)) exits.set(loop, watchExit(loop));
  loop.stop();
}

/** The protected and private matrix-js-sdk members {@link resumeClientSync} restarts a loop with. */
interface ResumableClient {
  readonly clientRunning: boolean;
  readonly clientOpts?: object;
  syncApi?: ResumableSyncLoop;
  buildSyncApiOptions(): object;
}

interface ResumableSyncLoop extends PausableSyncLoop {
  running: boolean;
  abortController?: AbortController;
  syncState: SyncState | null;
  syncStateData: unknown;
  readonly onOnline: () => void;
  getPushRules(): Promise<void>;
  prepareSyncFilterLazyLoading(): void;
  prepareSyncFilterUserProfiles(): Promise<void>;
  getFilter(): Promise<{
    readonly filterId?: string;
    readonly filter?: object;
  }>;
  doSync(options: {
    readonly filter?: string;
    readonly hasSyncedBefore?: boolean;
  }): Promise<void>;
}

/**
 * Restart a loop {@link pauseClientSync} stopped, from the sync token the client holds. The SDK
 * has no public resume, and its `sync()` would first replay the saved sync into the live rooms,
 * so this runs `sync()`'s steps without that replay on a new loop object, once the stopped one
 * has exited: it may still be processing a response or replaying the saved sync. Does nothing
 * while the loop runs, before the client has one, or once `stopClient()` ended it; a pause
 * before the old loop exits cancels it.
 */
export function resumeClientSync(client: MatrixClient): void {
  const owner = client as unknown as ResumableClient;
  const paused = owner.syncApi;
  const exited = paused && exits.get(paused);
  if (!owner.clientRunning || !paused || !exited) return;
  wanted.set(client, true);
  if (resuming.has(client)) return;
  resuming.add(client);
  void exited
    .then(() => paused.savedSyncPromise)
    .then(() => {
      resuming.delete(client);
      return wanted.get(client) &&
        owner.clientRunning &&
        owner.syncApi === paused
        ? runResumedLoop(client, owner, paused)
        : undefined;
    })
    .catch((error: unknown) => {
      console.warn("Couldn't resume syncing.", error);
    });
}

async function runResumedLoop(
  client: MatrixClient,
  owner: ResumableClient,
  paused: ResumableSyncLoop,
): Promise<void> {
  const Loop = paused.constructor as new (
    ...args: unknown[]
  ) => ResumableSyncLoop;
  const loop = new Loop(client, owner.clientOpts, owner.buildSyncApiOptions());
  // Catching up: the first request returns at once, and a conversation waiting for its room
  // keeps waiting. A never-synced client stays null, which still means "never synced".
  loop.syncState = paused.syncState === null ? null : SyncState.Catchup;
  loop.running = true;
  loop.abortController = new AbortController();
  owner.syncApi = loop;
  globalThis.window?.addEventListener?.('online', loop.onOnline, false);
  // Rules a pause cut off before they loaded would leave notifications unevaluated.
  await loop.getPushRules();
  loop.prepareSyncFilterLazyLoading();
  await loop.prepareSyncFilterUserProfiles();
  const { filterId, filter } = await loop.getFilter();
  if (!filter) return;
  await loop.doSync({
    filter: filterId,
    // Only a client that never synced still owes its Prepared.
    hasSyncedBefore: client.store.getSyncToken() !== null,
  });
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
      messages.push({
        accountId,
        roomId: room.roomId,
        threadRootId: threadOf(event, id),
        text,
        txnId: event.getTxnId(),
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
          await resendAtEnd(client, event, room);
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
