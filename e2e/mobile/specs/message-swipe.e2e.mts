import { browser, expect } from '@wdio/globals';
import { login, tap, waitForRooms } from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  sendMessage,
  uniqueId,
} from '../support/matrix.mts';
import { resetApp, restartApp } from '../support/session.mts';
import { onlyOn } from '../support/platform.mts';

/** Inside the old 56px edge zone, past the 32px strip WebKit's Back keeps. */
const START_X = 40;

const MESSAGE_SWIPE_KEY = 'trinity.message-swipe';

// Swipe to reply with a real WKWebView touch: `touch-action`, WebKit's own pan arbitration and
// its Back edge are what the browser journey's Chromium cannot stand in for.
// The message is the user's own, so the swipe edits rather than replies: the same gesture,
// without a second account to send from.
describe('swipe a message', function () {
  this.timeout(300_000);
  before(onlyOn('ios', 'WebKit’s Back edge and pan arbitration'));

  it('acts on a thumb’s arc that starts near the left edge', async () => {
    await resetApp();
    const user = uniqueId('swipe');
    const pass = `${user}-pass`;
    await registerUser(user, pass);
    const token = await accessToken(user, pass);
    const roomName = `Swipe ${user}`;
    const roomId = await createRoom(token, roomName);
    await sendMessage(token, roomId, `swipe me ${user}`);

    await login(user, pass);
    await waitForRooms();
    // Preferences live in UserDefaults on iOS, out of the WebView's storage; the setting is read
    // at start, hence the restart.
    await browser.execute(
      (key: string) =>
        (
          window as typeof window & {
            Capacitor: {
              Plugins: {
                Preferences: {
                  set(o: { key: string; value: string }): Promise<void>;
                };
              };
            };
          }
        ).Capacitor.Plugins.Preferences.set({ key, value: 'right' }),
      MESSAGE_SWIPE_KEY,
    );
    await restartApp();
    await waitForRooms();
    await tap(
      `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
    );
    const row = $(`//*[@data-mid][contains(.,"swipe me ${user}")]`);
    await expect(row).toBeDisplayed({ wait: 30_000 });
    await expect(row.$('.msg__swipe')).toBeExisting({ wait: 10_000 });
    const { y } = await row.getLocation();
    const { height } = await row.getSize();
    const midY = Math.round(y + height / 2);

    // Sideways first, then 30px of upward drift: the arc a thumb draws pivoting on its joint.
    await browser
      .action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x: START_X, y: midY })
      .down()
      .move({ x: START_X + 30, y: midY - 3, duration: 80 })
      .move({ x: START_X + 70, y: midY - 15, duration: 120 })
      .move({ x: START_X + 100, y: midY - 30, duration: 120 })
      .up()
      .perform();

    await expect($('.composer__banner')).toHaveText(
      expect.stringContaining('Editing'),
      { wait: 10_000 },
    );
    // Still in the room: WebKit's Back edge did not take the drag.
    await expect(row).toBeDisplayed();
  });
});
