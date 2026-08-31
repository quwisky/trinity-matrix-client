import { expect, test, testResourceId } from '../../../fixtures.mts';
import { login, type SynapseSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  configureRoomSettingsSuite,
  openRoom,
  session,
} from '../../support/room-settings-journey.mts';

test.describe('Room settings', () => {
  configureRoomSettingsSuite();

  test('an admin renames a room from the settings dialog', async ({
    page,
    request,
  }) => {
    // Unlike reactions/polls (timeline events with instant local echo), a rename is an
    // m.room.name STATE event with no local echo — the channel list only reflects it
    // after the change round-trips via /sync, whose latency balloons under a loaded
    // homeserver. Give this one echo-gated test extra budget for the wait below.
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}s`;
    const user = `settings-user-${runId}`;
    const pass = `${user}-pass`;
    const originalName = `Before ${runId}`;
    const newName = `After ${runId}`;

    await registerUser(request, user, pass);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: originalName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, originalName);

    // Open the room settings dialog and rename the room.
    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('room-settings-name').fill(newName);
    await page.getByTestId('room-settings-save').click();

    // The rename is an m.room.name state event, and matrix-js-sdk has no local echo for
    // state — the channel list only updates once the change round-trips back via /sync,
    // which is slow under full-suite load. Give that sync-driven update headroom (the
    // per-test budget is raised in playwright.config for exactly these login+sync flows).
    await expect(
      page.locator('.channel', { hasText: newName }).first(),
    ).toBeVisible({ timeout: 90_000 });
    await expect(
      page.locator('.channel', { hasText: originalName }),
    ).toHaveCount(0);
  });

  test('an admin changes the room photo', async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}a`;
    const user = `photo-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Photo ${runId}`;

    await registerUser(request, user, pass);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible({
      timeout: 10_000,
    });

    // Set a 1×1 PNG on the (hidden) file input, which uploads it as the avatar.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await page
      .locator('.room-settings input[type="file"]')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });

    // The upload + m.room.avatar write succeed, surfacing the success toast.
    await expect(
      page.getByLabel('Notifications alt+T').getByText('Room photo updated.'),
    ).toBeVisible({ timeout: 30_000 });
  });
});
