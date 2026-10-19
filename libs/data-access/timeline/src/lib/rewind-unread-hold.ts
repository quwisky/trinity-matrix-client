import {
  MatrixEventEvent,
  NotificationCountType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';

interface Counts {
  readonly total: number;
  readonly highlight: number;
}

/** Key of the room's own counts, beside each thread's under its root id. */
const MAIN = '';

/** Every event the room holds now, in its live timeline and its threads. */
function heldEvents(room: Room): MatrixEvent[] {
  return [
    ...room.getLiveTimeline().getEvents(),
    ...room.getThreads().flatMap((thread) => thread.events),
  ];
}

/** Ids of every event the room holds now, in its live timeline and its threads. */
export function heldEventIds(room: Room): ReadonlySet<string> {
  return new Set(
    heldEvents(room)
      .map((event) => event.getId())
      .filter((id): id is string => !!id),
  );
}

/**
 * Until the returned stop is called, keep a rewound room's unread counts from counting an
 * already counted event twice.
 *
 * In an encrypted room the SDK adds each unread event to the counts as it decrypts, and an
 * event paged in again decrypts again. The SDK's own listener runs first, so this one puts
 * back what the counts were before an event in `counted` decrypted, while one that is new
 * (a message the server hid while its sender was blocked, or a live one) keeps its count.
 * The room list reads the counts after both, on its coalesced rebuild.
 */
export function holdUnreadCounts(
  client: MatrixClient,
  room: Room,
  counted: ReadonlySet<string>,
): () => void {
  const read = (key: string): Counts =>
    key === MAIN
      ? {
          total: room.getUnreadNotificationCount(NotificationCountType.Total),
          highlight: room.getUnreadNotificationCount(
            NotificationCountType.Highlight,
          ),
        }
      : {
          total: room.getThreadUnreadNotificationCount(
            key,
            NotificationCountType.Total,
          ),
          highlight: room.getThreadUnreadNotificationCount(
            key,
            NotificationCountType.Highlight,
          ),
        };
  const write = (key: string, counts: Counts): void => {
    if (key === MAIN) {
      room.setUnreadNotificationCount(
        NotificationCountType.Total,
        counts.total,
      );
      room.setUnreadNotificationCount(
        NotificationCountType.Highlight,
        counts.highlight,
      );
    } else {
      room.setThreadUnreadNotificationCount(
        key,
        NotificationCountType.Total,
        counts.total,
      );
      room.setThreadUnreadNotificationCount(
        key,
        NotificationCountType.Highlight,
        counts.highlight,
      );
    }
  };
  // A thread first seen while paging back in has no earlier counts to put back.
  const expected = new Map<string, Counts>([[MAIN, read(MAIN)]]);
  for (const thread of room.getThreads()) {
    expected.set(thread.id, read(thread.id));
  }
  const onDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() !== room.roomId) return;
    const key =
      event.threadRootId && !event.isThreadRoot ? event.threadRootId : MAIN;
    const before = expected.get(key);
    if (!before) return;
    const eventId = event.getId();
    if (eventId && counted.has(eventId)) {
      write(key, before);
    } else {
      expected.set(key, read(key));
    }
  };
  client.on(MatrixEventEvent.Decrypted, onDecrypted);
  return () => client.off(MatrixEventEvent.Decrypted, onDecrypted);
}

/** Settles once every event the room holds has finished decrypting. */
export async function decrypted(room: Room): Promise<void> {
  await Promise.allSettled(
    heldEvents(room).map((event) => event.getDecryptionPromise()),
  );
}
