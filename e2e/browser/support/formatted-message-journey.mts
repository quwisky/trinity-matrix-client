import {
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../fixtures.mts';
import { login, type HomeserverSession } from '../../support/app.mts';
import {
  passwordLogin,
  registerUser,
  type AccountSession,
} from '../../support/account.mts';
import { nextTestResourceId } from '../../support/namespace.mts';
import { sendWithRetry } from './cs-api.mts';
import { openRoom } from './room-settings-journey.mts';
import { solidPng } from './png.mts';

// Message-display journeys send bodies as raw `formatted_body` over the Client-Server API,
// the way other clients and bridges do, rather than through Trinity's composer. Never logs
// tokens or passwords.

/** A throwaway account and a private room it owns. */
export interface FormattedRoom {
  readonly session: HomeserverSession;
  readonly account: AccountSession;
  readonly roomId: string;
  readonly roomName: string;
}

const bearer = (account: AccountSession): Record<string, string> => ({
  Authorization: `Bearer ${account.accessToken}`,
});

async function createRoomFor(
  request: APIRequestContext,
  hs: string,
  account: AccountSession,
  name: string,
): Promise<string> {
  const response = await sendWithRetry('create room', () =>
    request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: bearer(account),
      data: { name, preset: 'private_chat' },
    }),
  );
  return ((await response.json()) as { room_id: string }).room_id;
}

/** Register `<prefix>-<attempt id>` and create its room; one call per test. */
export async function seedFormattedRoom(
  request: APIRequestContext,
  hs: string,
  prefix: string,
): Promise<FormattedRoom> {
  const user = `${prefix}-${testResourceId('run')}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const account = await passwordLogin(request, hs, user, pass);
  const roomName = `${prefix} ${testResourceId('room')}`;
  const roomId = await createRoomFor(request, hs, account, roomName);
  return {
    session: { available: true, hs, user, pass } as HomeserverSession,
    account,
    roomId,
    roomName,
  };
}

/** Another room owned by the same account; resolves its id. */
export async function addRoom(
  request: APIRequestContext,
  hs: string,
  room: FormattedRoom,
  name: string,
): Promise<string> {
  return createRoomFor(request, hs, room.account, name);
}

/** Send `m.text`, as HTML when `content.html` is set; resolves the event id. */
export async function sendMessage(
  request: APIRequestContext,
  hs: string,
  room: FormattedRoom,
  content: { readonly body: string; readonly html?: string },
  roomId: string = room.roomId,
): Promise<string> {
  const data =
    content.html === undefined
      ? { msgtype: 'm.text', body: content.body }
      : {
          msgtype: 'm.text',
          body: content.body,
          format: 'org.matrix.custom.html',
          formatted_body: content.html,
        };
  const response = await sendWithRetry('send message', () =>
    request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${nextTestResourceId('txn')}`,
      { headers: bearer(room.account), data },
    ),
  );
  return ((await response.json()) as { event_id: string }).event_id;
}

/** Upload a solid PNG of `width` × `height` as the room's owner; resolves its `mxc://` URI. */
export async function uploadPng(
  request: APIRequestContext,
  hs: string,
  room: FormattedRoom,
  width: number,
  height: number,
  filename: string,
): Promise<string> {
  const response = await sendWithRetry('upload image', () =>
    request.post(
      `${hs}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
      {
        headers: { ...bearer(room.account), 'Content-Type': 'image/png' },
        data: solidPng(width, height),
      },
    ),
  );
  return ((await response.json()) as { content_uri: string }).content_uri;
}

/** Sign in through the UI as the room's owner and open the room. */
export async function signInAndOpen(
  page: Page,
  room: FormattedRoom,
): Promise<void> {
  await login(page, room.session);
  await openRoom(page, room.roomName);
}

export { openRoom };
