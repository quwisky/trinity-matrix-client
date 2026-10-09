import { browser, expect } from '@wdio/globals';
import {
  HOMESERVER_HTTP,
  SERVER_NAME,
} from '../../support/homeserver/start.mjs';
import { login, tap } from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  uniqueId,
} from '../support/matrix.mts';
import {
  APP_PACKAGE,
  native,
  resetApp,
  restartApp,
  shell,
  webview,
} from '../support/session.mts';
import { onlyOn } from '../support/platform.mts';

const POST_NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS';
// Android's ActivityManager state for an app whose process is alive but not on screen.
const RUNNING_IN_BACKGROUND = 3;

const uiSelector = (selector: string) => $(`android=${selector}`);

/** Unpadded base64url of the room id: the Rooms route segment. */
const roomSegment = (roomId: string): string =>
  Buffer.from(roomId).toString('base64url');

async function matrixApi(
  token: string,
  method: 'POST' | 'PUT',
  path: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  const res = await fetch(`${HOMESERVER_HTTP}/_matrix/client/v3/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
}

const roomButton = (name: string) =>
  $(`//button[contains(@class,"channel")][contains(.,"${name}")]`);

describe('mobile local notifications', () => {
  before(
    onlyOn(
      'android',
      'grants POST_NOTIFICATIONS and reads the Android notification shade; the harness cannot read iOS Notification Center',
    ),
  );
  beforeEach(resetApp);

  it('shows a notification for a message received in the background and opens its room when tapped', async () => {
    const user = uniqueId('android-notify');
    const pass = `${user}-pass`;
    const sender = uniqueId('android-sender');
    const roomName = `Notify ${user}`;
    const text = `ping ${uniqueId('msg')}`;
    await registerUser(user, pass);
    await registerUser(sender, `${sender}-pass`);
    const token = await accessToken(user, pass);
    const senderToken = await accessToken(sender, `${sender}-pass`);
    const roomId = await createRoom(token, roomName);
    await matrixApi(
      token,
      'POST',
      `rooms/${encodeURIComponent(roomId)}/invite`,
      {
        user_id: `@${sender}:${SERVER_NAME}`,
      },
    );

    await login(user, pass);
    await tap('[data-testid="rail-rooms"]');
    // The room list proves the first sync finished: only live events after it notify. The
    // room stays unopened, so the policy cannot suppress it as the visible conversation.
    await expect(roomButton(roomName)).toBeDisplayed({ wait: 30_000 });

    await native();
    await shell('input', ['keyevent', 'KEYCODE_HOME']);
    await browser.waitUntil(
      async () =>
        (await browser.execute('mobile: queryAppState', {
          appId: APP_PACKAGE,
        })) === RUNNING_IN_BACKGROUND,
      { timeout: 15_000, timeoutMsg: 'the app never went to the background' },
    );

    await matrixApi(senderToken, 'POST', `join/${encodeURIComponent(roomId)}`);
    await matrixApi(
      senderToken,
      'PUT',
      `rooms/${encodeURIComponent(roomId)}/send/m.room.message/${uniqueId('txn')}`,
      { msgtype: 'm.text', body: text },
    );

    await browser.execute('mobile: openNotifications');
    const notification = uiSelector(`new UiSelector().text("${text}")`);
    await expect(notification).toBeDisplayed({ wait: 60_000 });
    await expect(
      uiSelector(
        `new UiSelector().textContains("${sender}").textContains("${roomName}")`,
      ),
    ).toBeDisplayed();
    await notification.click();

    await webview();
    await browser.waitUntil(
      async () =>
        new URL(await browser.getUrl()).pathname ===
        `/rooms/${roomSegment(roomId)}`,
      { timeout: 30_000, timeoutMsg: `the tap never opened room ${roomId}` },
    );
    await expect(
      $(`//*[contains(@class,"msg")][contains(.,"${text}")]`),
    ).toBeDisplayed({
      wait: 30_000,
    });
  });

  it('asks for notification permission after sign-in and enables alerts once allowed', async () => {
    await native();
    // Revoking a runtime permission may kill the app; restartApp brings it back.
    await shell('pm', ['revoke', APP_PACKAGE, POST_NOTIFICATIONS]);
    await restartApp();
    const user = uniqueId('android-perm');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    await login(user, pass);

    await native();
    const allow = uiSelector(
      'new UiSelector().resourceIdMatches(".*permission_allow_button")',
    );
    await expect(allow).toBeDisplayed({ wait: 30_000 });
    await allow.click();

    await browser.waitUntil(
      async () =>
        /POST_NOTIFICATIONS: granted=true/.test(
          await shell('dumpsys', ['package', APP_PACKAGE]),
        ),
      { timeout: 10_000, timeoutMsg: 'POST_NOTIFICATIONS was never granted' },
    );
  });
});
