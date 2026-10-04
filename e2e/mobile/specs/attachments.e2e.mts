import { browser, expect } from '@wdio/globals';
import { login, tap } from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  uniqueId,
} from '../support/matrix.mts';
import { native, resetApp, shell, webview } from '../support/session.mts';

// A 1x1 PNG. Android 13+ lists only what MediaStore has indexed, so the file is pushed to a
// public collection directory and then scanned.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const uiSelector = (selector: string) => $(`android=${selector}`);

/** Put a PNG in the shared Pictures collection and wait until MediaStore lists it. */
async function seedPicture(name: string): Promise<void> {
  const path = `/sdcard/Pictures/${name}`;
  await browser.execute('mobile: pushFile', {
    remotePath: path,
    payload: PNG_BASE64,
  });
  const query = () =>
    shell('content', [
      'query',
      '--uri',
      'content://media/external/images/media',
      '--projection',
      '_display_name',
    ]);
  // The legacy broadcast is ignored on some images; MediaProvider's scan_file call is the
  // current equivalent. Issue both, then poll the index itself.
  await shell('am', [
    'broadcast',
    '-a',
    'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
    '-d',
    `file://${path}`,
  ]);
  await shell('content', [
    'call',
    '--uri',
    'content://media/',
    '--method',
    'scan_file',
    '--arg',
    path,
  ]);
  let last = '';
  await browser.waitUntil(async () => (last = await query()).includes(name), {
    timeout: 30_000,
    timeoutMsg: `MediaStore never indexed ${name}; last query: ${last.slice(0, 300)}; ls: ${await shell('ls', ['-l', path])}`,
  });
}

describe('Android attachments', () => {
  beforeEach(resetApp);

  it('attaches a photo from the system photo picker and sends it', async () => {
    const user = uniqueId('android-attach');
    const pass = `${user}-pass`;
    const roomName = `Android attach ${user}`;
    await registerUser(user, pass);
    await createRoom(await accessToken(user, pass), roomName);
    await seedPicture(`${user}.png`);
    await login(user, pass);

    await tap('[data-testid="rail-rooms"]');
    const room = $(
      `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    await expect(room).toBeDisplayed({ wait: 30_000 });
    await room.click();

    await tap('[data-testid="composer-insert"]');
    await tap('[data-testid="insert-attach"]');

    // Capacitor's gallery picker is the OS photo picker (no READ_MEDIA_* grant needed on
    // API 33+). The newest item is the file seeded above; multi-select confirms with "Done".
    await native();
    const thumbnail = uiSelector(
      'new UiSelector().descriptionStartsWith("Photo taken on")',
    );
    await expect(thumbnail).toBeDisplayed({ wait: 30_000 });
    await thumbnail.click();
    const add = uiSelector('new UiSelector().text("Done")');
    await expect(add).toBeDisplayed({ wait: 10_000 });
    await add.click();

    await webview();
    await expect($('[data-testid="composer-pending"]')).toBeDisplayed({
      wait: 30_000,
    });
    await tap('[data-testid="composer-send"]');
    await expect(
      $('[data-testid="media-bubble"] img[alt^="image."]'),
    ).toBeDisplayed({ wait: 30_000 });
  });
});
