import { devices, expect, test, testResourceId } from '../../../fixtures.mts';
import { login, type HomeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  configureRoomSettingsSuite,
  expectSettingsSheet,
  openRoom,
  session,
} from '../../support/room-settings-journey.mts';
import { createRoom } from '../../support/space-journey.mts';

test.use({ ...devices['Pixel 5'] });

test.describe('Room settings sheet content drag', () => {
  configureRoomSettingsSuite();

  test('a guarded sheet stays open under a content drag', async ({
    page,
    request,
    touchPlatform,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}guard`;
    const user = `settings-drag-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Guarded drag ${runId}`;

    await registerUser(request, user, pass);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((response) => response.json());
    await createRoom(request, hs, { accessToken: access_token }, roomName);

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-open-room-settings').click();
    await expectSettingsSheet(page, 'room-settings');
    await touchPlatform.tap(
      page,
      page.getByTestId('room-settings-tab-general'),
    );
    await page.getByTestId('room-settings-topic').fill('An unsaved draft');

    const heading = page.getByTestId('room-settings-section-heading');
    const box = await heading.boundingBox();
    expect(box).not.toBeNull();
    const from = { x: box!.x + 8, y: box!.y + box!.height / 2 };
    await touchPlatform.swipe(page, from, { x: from.x, y: from.y + 400 });

    await expect(page.getByTestId('room-settings')).toBeVisible();
    await expect(page.getByTestId('room-settings-topic')).toHaveValue(
      'An unsaved draft',
    );
  });
});
