import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browser, expect } from '@wdio/globals';
import { login } from '../support/app.mts';
import {
  createRoom,
  inviteUser,
  joinRoom,
  roomWithSender,
  sendMessage,
  setDirectRooms,
  uniqueId,
} from '../support/matrix.mts';
import { iosAppGroupContainer, resetApp } from '../support/session.mts';
import { onlyOn } from '../support/platform.mts';

const APP_GROUP = 'group.dev.trinityproject.trinity';

/** What the NotificationService extension would show, as the debug render probe reports it. */
interface RenderedPush {
  readonly title: string;
  readonly subtitle: string;
  readonly body: string;
  readonly threadIdentifier: string;
  readonly sound: boolean;
}

/** `push-handoff/rooms.json`: each account's rooms by id. */
type StoredRooms = Partial<
  Record<string, Partial<Record<string, { name: string; direct: boolean }>>>
>;

/** The app group's stored rooms; empty until the app writes them. */
async function storedRooms(file: string): Promise<StoredRooms> {
  return JSON.parse(
    await readFile(file, 'utf8').catch(() => '{}'),
  ) as StoredRooms;
}

/** The gateway's APNs push for one event: a placeholder alert the extension rewrites. */
const gatewayPush = (userId: string, roomId: string, eventId: string) => ({
  aps: {
    alert: { title: 'Trinity', body: 'New message' },
    sound: 'default',
    'mutable-content': 1,
    'thread-id': roomId,
  },
  event_id: eventId,
  room_id: roomId,
  trinity_user_id: userId,
});

/**
 * Render `payload` through the extension's path inside the running Debug app, with the
 * PushHandoff plugin's debug-only `renderProbe`.
 */
async function renderProbe(
  payload: Readonly<Record<string, unknown>>,
): Promise<RenderedPush> {
  const result = await browser.executeAsync(
    (
      push: Readonly<Record<string, unknown>>,
      done: (value: unknown) => void,
    ) => {
      const handoff = (
        window as typeof window & {
          Capacitor?: {
            Plugins?: {
              PushHandoff?: {
                renderProbe?(options: { payload: unknown }): Promise<unknown>;
              };
            };
          };
        }
      ).Capacitor?.Plugins?.PushHandoff;
      if (!handoff?.renderProbe) {
        done({ error: 'PushHandoff.renderProbe is unavailable' });
        return;
      }
      handoff
        .renderProbe({ payload: push })
        .then(done, (e: unknown) => done({ error: String(e) }));
    },
    payload,
  );
  const rendered = result as RenderedPush & { error?: string };
  if (rendered.error) throw new Error(rendered.error);
  return rendered;
}

describe('device-rendered push on iOS', () => {
  before(
    onlyOn(
      'ios',
      'renders through the iOS NotificationService path with the PushHandoff debug probe and the app group store',
    ),
  );
  beforeEach(resetApp);

  it('renders a room push with the room, the sender and the text, and a DM push without a subtitle', async () => {
    const room = await roomWithSender('ios-push');
    const dmName = `DM ${room.user}`;
    const dmId = await createRoom(room.token, dmName);
    await inviteUser(room.token, dmId, room.senderId);
    await joinRoom(room.senderToken, dmId);
    await setDirectRooms(room.token, room.userId, { [room.senderId]: [dmId] });

    await login(room.user, room.pass);
    // PushHandoffService writes room names after the first sync; wait for the shared file
    // the extension reads.
    const rooms = join(
      await iosAppGroupContainer(APP_GROUP),
      'push-handoff',
      'rooms.json',
    );
    await browser.waitUntil(
      async () => {
        const stored = (await storedRooms(rooms))[room.userId];
        return (
          stored?.[room.roomId]?.direct === false &&
          stored[dmId]?.direct === true
        );
      },
      {
        timeout: 60_000,
        timeoutMsg: 'the app never wrote both rooms to the push handoff store',
      },
    );

    const text = `room ${uniqueId('msg')}`;
    const eventId = await sendMessage(room.senderToken, room.roomId, text);
    expect(
      await renderProbe(gatewayPush(room.userId, room.roomId, eventId)),
    ).toMatchObject({
      title: room.roomName,
      subtitle: room.sender,
      body: text,
      threadIdentifier: room.roomId,
    });

    const dmText = `dm ${uniqueId('msg')}`;
    const dmEventId = await sendMessage(room.senderToken, dmId, dmText);
    expect(
      await renderProbe(gatewayPush(room.userId, dmId, dmEventId)),
    ).toMatchObject({
      title: dmName,
      subtitle: '',
      body: dmText,
      threadIdentifier: dmId,
    });
  });
});
