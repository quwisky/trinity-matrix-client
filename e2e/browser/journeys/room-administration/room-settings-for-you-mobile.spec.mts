import { devices, expect, test, testResourceId } from '../../../fixtures.mts';
import { login, type SynapseSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { apiLogin } from '../../support/multi-account-journey.mts';
import {
  configureRoomSettingsSuite,
  openRoom,
  session,
} from '../../support/room-settings-journey.mts';

// The Android user agent selects Trinity's mobile settings interaction model.
test.use({ ...devices['Pixel 5'] });

test.describe('Room settings · For you on a phone', () => {
  configureRoomSettingsSuite();

  test('lets an ordinary member stage, protect, and save personal preferences', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}member`;
    const owner = `for-you-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const member = `for-you-member-${runId}`;
    const memberPass = `${member}-pass`;
    const roomName = `Mobile For you ${runId}`;
    await registerUser(request, owner, ownerPass);
    await registerUser(request, member, memberPass);
    const ownerApi = await apiLogin(request, hs, owner, ownerPass);
    const memberApi = await apiLogin(request, hs, member, memberPass);
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: ownerApi.headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [memberApi.userId],
        },
      })
      .then((response) => response.json())
      .then((body) => body.room_id as string);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: memberApi.headers },
    );

    await login(page, {
      available: true,
      hs,
      user: member,
      pass: memberPass,
    } as SynapseSession);
    await openRoom(page, roomName);
    await page.getByTestId('room-actions-overflow').tap();
    await page.getByTestId('overflow-open-room-settings').tap();
    const settings = page.getByTestId('room-settings');
    await expect(settings).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('room-settings-mobile-back').tap();
    await page.getByTestId('room-settings-tab-for-you').tap();
    await expect(page.getByTestId('room-settings-for-you-form')).toBeVisible({
      timeout: 15_000,
    });

    const mute = page
      .getByTestId('room-settings-notify-mute')
      .getByRole('radio');
    const favourite = page
      .getByTestId('room-settings-favourite')
      .getByRole('checkbox');
    await expect(mute).toBeEnabled();
    await expect(favourite).toBeEnabled();
    await page.getByTestId('room-settings-notify-mute').tap();
    await page.getByTestId('room-settings-favourite').tap();

    await page.getByTestId('room-settings-mobile-back').tap();
    const discard = page.getByRole('dialog', {
      name: 'Discard Room settings changes?',
    });
    await discard.getByRole('button', { name: 'Keep editing' }).tap();
    await expect(mute).toBeChecked();
    await expect(favourite).toBeChecked();

    await page
      .getByTestId('room-settings-for-you-save')
      .scrollIntoViewIfNeeded();
    await page.getByTestId('room-settings-for-you-save').tap();
    await expect(
      page.getByTestId('room-settings-for-you-feedback'),
    ).toContainText('saved for the opening Account', { timeout: 30_000 });
    await test.info().attach('room-settings-for-you-mobile-member', {
      body: await settings.screenshot(),
      contentType: 'image/png',
    });
  });
});
