import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browser, expect } from '@wdio/globals';
import { login, signInPageShown } from '../support/app.mts';
import {
  createRoom,
  inviteUser,
  joinRoom,
  roomWithSender,
  sendMessage,
  setDirectRooms,
  uniqueId,
} from '../support/matrix.mts';
import {
  IOS_APP_GROUP as APP_GROUP,
  iosAppGroupContainer,
  resetApp,
} from '../support/session.mts';
import { onlyOn } from '../support/platform.mts';
import {
  storeExpiredPushAccount,
  tokenAnswersForUnknownAccount,
  tokenRoundTrip,
} from '../support/push-handoff.mts';

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
  Record<
    string,
    Partial<
      Record<string, { name: string; direct: boolean; encrypted?: boolean }>
    >
  >
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
  const result = await browser.execute(
    async (push: Readonly<Record<string, unknown>>): Promise<unknown> => {
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
        return { error: 'PushHandoff.renderProbe is unavailable' };
      }
      try {
        return await handoff.renderProbe({ payload: push });
      } catch (e: unknown) {
        return { error: String(e) };
      }
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
    // PushHandoffService writes room names after the first sync, and marks each room
    // unencrypted once the crypto store has answered; until then the extension shows no
    // text. Wait for the shared file the extension reads.
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
          stored[room.roomId]?.encrypted === false &&
          stored[dmId]?.direct === true &&
          stored[dmId]?.encrypted === false
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

  it('shows the open-Trinity text without reading anything once the stored token has expired', async () => {
    const room = await roomWithSender('ios-push-expired');
    await login(room.user, room.pass);
    const rooms = join(
      await iosAppGroupContainer(APP_GROUP),
      'push-handoff',
      'rooms.json',
    );
    // The account is written before its rooms (one serialized queue), so once the room is
    // stored nothing else rewrites the account in this test.
    await browser.waitUntil(
      async () =>
        (await storedRooms(rooms))[room.userId]?.[room.roomId] !== undefined,
      {
        timeout: 60_000,
        timeoutMsg: 'the app never wrote the room to the push handoff store',
      },
    );
    await storeExpiredPushAccount(room.userId);

    const eventId = await sendMessage(
      room.senderToken,
      room.roomId,
      `expired ${uniqueId('msg')}`,
    );
    expect(
      await renderProbe(gatewayPush(room.userId, room.roomId, eventId)),
    ).toMatchObject({
      title: room.roomName,
      subtitle: '',
      body: 'Open Trinity to read this message',
      threadIdentifier: room.roomId,
    });
  });

  it('answers the token calls for an account with no tokens through the installed plugin', async () => {
    const answers = await tokenAnswersForUnknownAccount(
      `@${uniqueId('nobody')}:unknown.invalid`,
    );

    expect(answers.current).toEqual({ kind: 'gone' });
    expect(answers.refresh).toEqual({ kind: 'gone' });
    expect(answers.malformedRemovals).toEqual(
      Array.from({ length: 6 }, () =>
        expect.stringContaining('Must provide a userId or all: true'),
      ),
    );
    expect(answers.malformedSweeps).toEqual(
      Array.from({ length: 4 }, () =>
        expect.stringContaining('Must provide userIds'),
      ),
    );
  });

  it('stores, reads and removes tokens through the installed plugin, with no network', async () => {
    // The launch sweep removes any record with no account, so it must have finished first.
    await signInPageShown();
    const accessTokenExpiresAt = 4_102_444_800_000;
    const answers = await tokenRoundTrip(
      `@${uniqueId('vault')}:unknown.invalid`,
      `@${uniqueId('nobody')}:unknown.invalid`,
      {
        lineage: 'L',
        accessToken: 'synthetic-access',
        refreshToken: 'synthetic-refresh',
        accessTokenExpiresAt,
        tokenEndpoint: 'https://unreachable.invalid/token',
        revocationEndpoint: 'https://unreachable.invalid/revoke',
        clientId: 'synthetic-client',
        deviceId: 'SYNTHETIC',
      },
    );

    expect(answers.stored).toEqual({ stored: true });
    expect(answers.current).toEqual({
      kind: 'current',
      accessToken: 'synthetic-access',
      accessTokenExpiresAt,
    });
    expect(answers.current).not.toHaveProperty('refreshToken');
    expect(answers.revokedUnknown).toEqual({ kind: 'gone' });
    expect(answers.sweepKeeping).toEqual({ removed: expect.any(Number) });
    expect(answers.currentKept).toEqual(answers.current);
    expect(answers.currentAfter).toEqual({ kind: 'gone' });
    expect(answers.sweepOfAll).toEqual({ removed: 1 });
    expect(answers.currentSwept).toEqual({ kind: 'gone' });
    expect(answers.currentAfterAll).toEqual({ kind: 'gone' });
  });
});
