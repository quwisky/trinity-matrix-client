import {
  MatrixEvent,
  MatrixEventEvent,
  NotificationCountType,
  RelationType,
  Room,
  createClient,
} from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { heldEventIds, holdUnreadCounts } from './rewind-unread-hold';

const ME = '@me:hs';
const ROOM = '!r:hs';

describe('holdUnreadCounts', () => {
  it("puts a thread's counts back when a reply it counted decrypts again", () => {
    const client = createClient({
      baseUrl: 'https://hs',
      userId: ME,
      fetchFn: () => Promise.reject(new Error('no network in unit tests')),
    });
    vi.spyOn(client, 'supportsThreads').mockReturnValue(true);
    const room = new Room(ROOM, client, ME);
    client.store.storeRoom(room);
    const root = new MatrixEvent({
      event_id: '$root',
      room_id: ROOM,
      type: 'm.room.message',
      sender: '@a:hs',
      origin_server_ts: 1,
      content: { msgtype: 'm.text', body: 'root' },
    });
    const reply = (id: string) =>
      new MatrixEvent({
        event_id: id,
        room_id: ROOM,
        type: 'm.room.message',
        sender: '@a:hs',
        origin_server_ts: 2,
        content: {
          msgtype: 'm.text',
          body: id,
          'm.relates_to': { rel_type: RelationType.Thread, event_id: '$root' },
        },
      });
    const counted = reply('$counted');
    const fresh = reply('$fresh');
    room.createThread('$root', root, [counted, fresh], false);
    room.setThreadUnreadNotificationCount(
      '$root',
      NotificationCountType.Total,
      4,
    );
    room.setThreadUnreadNotificationCount(
      '$root',
      NotificationCountType.Highlight,
      4,
    );
    const counts = () => [
      room.getThreadUnreadNotificationCount(
        '$root',
        NotificationCountType.Total,
      ),
      room.getThreadUnreadNotificationCount(
        '$root',
        NotificationCountType.Highlight,
      ),
    ];
    const ids = new Set(
      [...heldEventIds(room)].filter((id) => id !== '$fresh'),
    );
    expect(ids).toContain('$counted');

    // As the SDK counts an unread thread reply on decryption, ahead of every later listener.
    client.on(MatrixEventEvent.Decrypted, (event) => {
      const [total, highlight] = counts();
      for (const [type, count] of [
        [NotificationCountType.Total, total],
        [NotificationCountType.Highlight, highlight],
      ] as const) {
        room.setThreadUnreadNotificationCount(
          event.threadRootId!,
          type,
          count + 1,
        );
      }
    });

    const release = holdUnreadCounts(client, room, ids);
    client.emit(MatrixEventEvent.Decrypted, counted);
    expect(counts()).toEqual([4, 4]);

    client.emit(MatrixEventEvent.Decrypted, fresh);
    expect(counts()).toEqual([5, 5]);

    release();
    client.emit(MatrixEventEvent.Decrypted, counted);
    expect(counts()).toEqual([6, 6]);
  });
});
