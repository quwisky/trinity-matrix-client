import { browser, expect } from '@wdio/globals';
import { login, tap } from '../support/app.mts';
import { roomWithSender, sendMessage, uniqueId } from '../support/matrix.mts';
import {
  APP_PACKAGE,
  native,
  resetApp,
  shell,
  webview,
} from '../support/session.mts';
import { onlyOn } from '../support/platform.mts';

const PROBE = `${APP_PACKAGE}/dev.trinityproject.trinity.push.PushRenderProbeReceiver`;

const uiSelector = (selector: string) => $(`android=${selector}`);

/** Unpadded base64url of the room id: the Rooms route segment. */
const roomSegment = (roomId: string): string =>
  Buffer.from(roomId).toString('base64url');

/** `mobile: shell` goes through the device shell: quote values carrying `$` or `!`. */
const quoted = (value: string): string => `'${value}'`;

const roomButton = (name: string) =>
  $(`//button[contains(@class,"channel")][contains(.,"${name}")]`);

describe('device-rendered push on Android', () => {
  before(
    onlyOn(
      'android',
      'drives the Android renderer through its debug-only probe receiver and reads the notification shade',
    ),
  );
  beforeEach(resetApp);

  it('posts the room notification from the handoff store with the app closed and opens the room when tapped', async () => {
    const room = await roomWithSender('android-push');

    await login(room.user, room.pass);
    await tap('[data-testid="rail-rooms"]');
    await expect(roomButton(room.roomName)).toBeDisplayed({ wait: 30_000 });
    // The store's keys are plain text (its values are Keystore-encrypted), so the account's
    // rooms key shows the first room batch landed; debug builds allow run-as.
    await browser.waitUntil(
      async () =>
        (
          await shell('run-as', [
            APP_PACKAGE,
            'cat',
            'shared_prefs/trinity_push_handoff.xml',
          ])
        ).includes(`rooms:${room.userId}`),
      {
        timeout: 30_000,
        timeoutMsg: 'the app never wrote the room to the push handoff store',
      },
    );

    await native();
    await browser.terminateApp(APP_PACKAGE);
    const eventId = await sendMessage(
      room.senderToken,
      room.roomId,
      `closed ${uniqueId('msg')}`,
    );
    const sent = await shell('am', [
      'broadcast',
      '--include-stopped-packages',
      '-n',
      PROBE,
      '--es',
      'trinity_user_id',
      quoted(room.userId),
      '--es',
      'room_id',
      quoted(room.roomId),
      '--es',
      'event_id',
      quoted(eventId),
    ]);
    expect(sent).toContain('Broadcast completed');

    await browser.execute('mobile: openNotifications');
    // Native code does not trust this run's Caddy CA, so the fetch fails and the renderer
    // shows the stored room name with its fetch-failure text. The message text is proven by
    // the shared render fixture (JUnit) and the iOS spec.
    const notification = uiSelector(
      `new UiSelector().textContains("${room.roomName}")`,
    );
    await expect(notification).toBeDisplayed({ wait: 30_000 });
    await expect(
      uiSelector('new UiSelector().textContains("New message")'),
    ).toBeDisplayed();
    await notification.click();

    await webview();
    await browser.waitUntil(
      async () =>
        new URL(await browser.getUrl()).pathname ===
        `/rooms/${roomSegment(room.roomId)}`,
      {
        timeout: 30_000,
        timeoutMsg: `the tap never opened room ${room.roomId}`,
      },
    );
  });
});
