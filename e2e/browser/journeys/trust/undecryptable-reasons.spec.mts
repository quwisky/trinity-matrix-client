import { testResourceId, test, expect } from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { passwordLogin, roomKeysBackedUp } from '../../../support/account.mts';
import {
  createEncryptedRoom,
  freshAccount,
  openRoom,
  setUpEncryption,
} from '../../support/encryption-journey.mts';

// MSC4153 Phase 0, PR 1: an encrypted message a device cannot read says why, and the reason
// this device can fix (history it cannot reach until it unlocks key backup) offers the fix.
// Unlocking with the recovery key makes the message readable without a reload, because the
// SDK queued the missing session for the backup downloader.
// Needs a homeserver; self-skips without one.
const session = homeserverSession();

test.describe('Messages this device cannot read', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('an unverified device unlocks history it cannot read from the message itself', async ({
    page,
    secondaryApp,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const runId = testResourceId('run');
    const { user, pass, asSession } = await freshAccount(request, hs, 'utd');
    const roomName = `History ${runId}`;
    const body = `sent before the second sign-in ${runId}`;
    const api = await passwordLogin(request, hs, user, pass);
    const roomId = await createEncryptedRoom(request, hs, api, roomName);

    // Device A: recovery set up, the message sent, its key in the backup.
    await login(page, asSession);
    const recoveryKey = await setUpEncryption(page, pass);
    await openRoom(page, roomName);
    await page.locator('textarea.composer__input').first().click();
    await page.keyboard.type(body);
    await page.keyboard.press('Enter');
    await expect(page.locator('.msg__text', { hasText: body })).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => roomKeysBackedUp(request, hs, api, roomId), {
        timeout: 60_000,
        intervals: [1_000],
      })
      .toBe(true);

    // Device B: signed in afterwards and not verified, so that history is locked.
    const deviceB = await secondaryApp.launch();
    await login(deviceB, asSession);
    await openRoom(deviceB, roomName);
    const locked = deviceB
      .locator('.msg', {
        has: deviceB.locator('.msg__text', {
          hasText: 'Unlock your encrypted messages on this device',
        }),
      })
      .first();
    await expect(locked).toBeVisible({ timeout: 60_000 });
    const fix = locked.getByRole('button', { name: 'Verify this device' });
    await expect(fix).toBeVisible({ timeout: 30_000 });

    await fix.click();
    await deviceB.getByTestId('recovery-key-input').fill(recoveryKey);
    await deviceB.getByTestId('unlock-submit').click();

    // Readable without a reload, and nothing left to fix on this device.
    await expect(deviceB.locator('.msg__text', { hasText: body })).toBeVisible({
      timeout: 90_000,
    });
    await expect(deviceB.getByTestId('msg-utd-fix')).toHaveCount(0, {
      timeout: 30_000,
    });
  });
});
