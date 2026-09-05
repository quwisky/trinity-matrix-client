import { devices, expect, test, testResourceId } from '../../../fixtures.mts';
import { login, type SynapseSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  configureRoomSettingsSuite,
  openRoom,
  session,
} from '../../support/room-settings-journey.mts';

// A real device profile supplies the Android user agent that selects Trinity's mobile OS
// interaction model; a narrow touch-enabled desktop viewport would not prove this surface.
test.use({ ...devices['Pixel 5'] });

test.describe('Room settings on a phone', () => {
  configureRoomSettingsSuite();

  test('uses a full-screen General-to-directory flow with protected drafts', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}mobile`;
    const user = `settings-mobile-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Mobile settings ${runId}`;

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
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);
    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-open-room-settings').click();

    const settings = page.getByTestId('room-settings');
    await expect(settings).toBeVisible({ timeout: 10_000 });
    const box = await settings.boundingBox();
    const viewport = page.viewportSize();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual((viewport?.width ?? 0) - 1);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(
      (viewport?.height ?? 0) - 1,
    );
    await expect(page.getByTestId('room-settings-panel-general')).toBeVisible();
    await expect(page.getByTestId('room-settings-directory')).toBeHidden();

    const topic = page.getByTestId('room-settings-topic');
    await topic.fill('A mobile draft');
    await page.getByTestId('room-settings-mobile-back').click();
    const discard = page.getByRole('dialog', {
      name: 'Discard Room settings changes?',
    });
    await discard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(topic).toHaveValue('A mobile draft');

    await page.getByTestId('room-settings-mobile-back').click();
    await discard.getByRole('button', { name: 'Discard changes' }).click();
    const directory = page.getByTestId('room-settings-directory');
    await expect(directory).toBeVisible();
    const general = page.getByTestId('room-settings-tab-general');
    const generalBox = await general.boundingBox();
    expect(generalBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await test.info().attach('room-settings-mobile-directory', {
      body: await settings.screenshot(),
      contentType: 'image/png',
    });

    await general.tap();
    await expect(page.getByTestId('room-settings-panel-general')).toBeVisible();
    await page.getByTestId('room-settings-cancel').tap();
    await expect(settings).toHaveCount(0);
    await expect(page.getByTestId('composer-input')).toBeVisible();
  });
});
