import { browser, expect } from '@wdio/globals';
import { SERVER_NAME } from '../../support/homeserver/start.mjs';
import {
  login,
  tap,
  waitForDurableActiveAccount,
  waitForRooms,
} from '../support/app.mts';
import {
  accessToken,
  createRoom,
  createRoomAlias,
  registerUser,
  uniqueId,
} from '../support/matrix.mts';
import {
  APP_PACKAGE,
  native,
  resetApp,
  shell,
  webview,
} from '../support/session.mts';

const pathname = async (): Promise<string> =>
  new URL(await browser.getUrl()).pathname;

/** The Rooms route segment for a room: unpadded base64url of its id or alias. */
const roomSegment = (roomId: string): string =>
  Buffer.from(roomId).toString('base64url');

/** Fire a VIEW intent at the installed app, then return to its WebView. */
async function openLink(link: string): Promise<void> {
  await native();
  const started = await shell('am', [
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    link,
    APP_PACKAGE,
  ]);
  if (/error/i.test(started)) throw new Error(`am start failed: ${started}`);
  await webview();
}

/** Confirm the room preview a followed matrix.to link raises, as in-app taps do. */
async function openPreviewedRoom(roomId: string): Promise<void> {
  await expect($('[data-testid="room-link-preview"]')).toBeDisplayed({
    wait: 60_000,
  });
  await tap('[data-testid="room-link-primary"]');
  await browser.waitUntil(
    async () => (await pathname()) === `/rooms/${roomSegment(roomId)}`,
    { timeout: 30_000, timeoutMsg: `never opened room ${roomId}` },
  );
}

const roomButton = (name: string) =>
  $(`//button[contains(@class,"channel")][contains(.,"${name}")]`);

describe('Android room deep links', () => {
  let roomA: { id: string; name: string };
  let roomB: { id: string; name: string };
  let token: string;

  beforeEach(async () => {
    await resetApp();
    const user = uniqueId('android-link');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    token = await accessToken(user, pass);
    roomA = { name: `Link A ${user}`, id: '' };
    roomB = { name: `Link B ${user}`, id: '' };
    roomA.id = await createRoom(token, roomA.name);
    roomB.id = await createRoom(token, roomB.name);
    await login(user, pass);
    await tap('[data-testid="rail-rooms"]');
    await expect(roomButton(roomB.name)).toBeDisplayed({ wait: 30_000 });
    await tap(
      `//button[contains(@class,"channel")][contains(.,"${roomA.name}")]`,
    );
    await browser.waitUntil(
      async () => (await pathname()) === `/rooms/${roomSegment(roomA.id)}`,
      { timeout: 20_000, timeoutMsg: 'room A never opened' },
    );
  });

  it('opens the linked room while the app is running', async () => {
    await openLink(
      `eu.qwky.trinity://matrix.to/#/${encodeURIComponent(roomB.id)}`,
    );
    await openPreviewedRoom(roomB.id);
  });

  it('opens the linked room from a cold start, after the session restores', async () => {
    const accountId = new URL(await browser.getUrl()).searchParams.get(
      'account',
    );
    if (!accountId) throw new Error('no active account before the restart');
    await waitForDurableActiveAccount(accountId);

    await native();
    await shell('am', ['force-stop', APP_PACKAGE]);
    await openLink(
      `eu.qwky.trinity://matrix.to/#/${encodeURIComponent(roomB.id)}`,
    );
    await waitForRooms(60_000);
    await openPreviewedRoom(roomB.id);
  });

  it('opens a room linked by alias', async () => {
    const alias = `#${uniqueId('alias')}:${SERVER_NAME}`;
    await createRoomAlias(token, alias, roomB.id);

    await openLink(
      `eu.qwky.trinity://matrix.to/#/${encodeURIComponent(alias)}`,
    );
    await openPreviewedRoom(roomB.id);
  });
});
