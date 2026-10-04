import { browser, expect } from '@wdio/globals';
import { HOMESERVER_HTTP } from '../../support/homeserver/start.mjs';
import { login, tap } from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  uniqueId,
} from '../support/matrix.mts';
import { native, resetApp, webview } from '../support/session.mts';

const CHOOSER_PACKAGE = 'com.android.intentresolver';

const uiSelector = (selector: string) => $(`android=${selector}`);
const chooser = () =>
  uiSelector(`new UiSelector().packageName("${CHOOSER_PACKAGE}")`);

/** Upload a small text file and post it to the room as an unencrypted `m.file`. */
async function sendFile(
  token: string,
  roomId: string,
  filename: string,
  contents: string,
): Promise<void> {
  const auth = { authorization: `Bearer ${token}` };
  const upload = await fetch(
    `${HOMESERVER_HTTP}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      headers: { ...auth, 'content-type': 'text/plain' },
      body: contents,
    },
  );
  if (!upload.ok) throw new Error(`upload → ${upload.status}`);
  const { content_uri } = (await upload.json()) as { content_uri: string };
  const send = await fetch(
    `${HOMESERVER_HTTP}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${uniqueId('txn')}`,
    {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'm.file',
        body: filename,
        filename,
        url: content_uri,
        info: {
          mimetype: 'text/plain',
          size: Buffer.byteLength(contents),
        },
      }),
    },
  );
  if (!send.ok) throw new Error(`send → ${send.status}`);
}

describe('Android share sheet', () => {
  beforeEach(resetApp);

  it('opens the system chooser when a file attachment is downloaded, and returns to the room on dismiss', async () => {
    const user = uniqueId('android-share');
    const pass = `${user}-pass`;
    const roomName = `Share ${user}`;
    const filename = `${uniqueId('shared')}.txt`;
    await registerUser(user, pass);
    const token = await accessToken(user, pass);
    const roomId = await createRoom(token, roomName);
    await sendFile(token, roomId, filename, `contents of ${filename}`);

    await login(user, pass);
    await tap('[data-testid="rail-rooms"]');
    await tap(
      `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    const roomUrl = await browser.waitUntil(
      async () => {
        const { pathname } = new URL(await browser.getUrl());
        return pathname.startsWith('/rooms/') ? pathname : false;
      },
      { timeout: 30_000, timeoutMsg: 'the room never opened' },
    );

    // On Android the file card writes the bytes to the cache and hands them to Share.
    const card = `button[aria-label="Download ${filename}"]`;
    await tap(card);

    await native();
    await expect(chooser()).toBeDisplayed({ wait: 30_000 });
    // The chooser previews a shared file by its name.
    await expect(
      uiSelector(`new UiSelector().textContains("${filename}")`),
    ).toBeDisplayed();

    await browser.pressKeyCode(4);
    await expect(chooser()).not.toExist({ wait: 10_000 });

    await webview();
    expect(new URL(await browser.getUrl()).pathname).toBe(roomUrl);
    await expect($(card)).toBeDisplayed({ wait: 15_000 });
  });
});
